/* ============================================================
 * 智能营销 · 触达设计（外呼对话任务）
 *
 * 行业演进三阶段（2026-11 调研：美团 WOWService 技术报告 arXiv:2510.13291、
 * 阿里云智能外呼「画布话术流程」与「大模型场景」双模式、Bland Pathways / Vapi Squads / Retell Flows）：
 *
 *   阶段一 rule  —— 规则引擎式 workflow：节点图 + 意图分支，确定性状态机。
 *                  代表：阿里云话术管理画布、Bland Pathways。100% 可控可审计，
 *                  但长尾应答只能靠枚举，意图覆盖是天花板。
 *   阶段二 llm   —— LLM 增强 workflow：节点里引入意图识别（多意图+置信度+兜底）、
 *                  按 Prompt 生成话术、槽位抽取、工具调用与转人工。
 *                  代表：阿里云大模型外呼进阶模式、Vapi Squads。长尾覆盖提升，
 *                  仍是人定的流程框架。
 *   阶段三 agent —— 模型主导（WOWService 式）：没有预置节点图，由目标+画像+
 *                  知识库+合规边界驱动，模型每轮自主决策「说什么、问什么、何时结束」；
 *                  主 Agent 通过 Agents-as-Tools 调度能力（查账单、登记回访、转人工）。
 *                  数据与知识双驱动，流程内化为模型能力。
 *
 * 三个引擎共用：会话状态、模拟用户、合规护栏、血缘化 trace（每轮决策可回溯）。
 * LLM 双轨：默认走真实 LLM（.env QWEN_KEY → 内部模型网关/直连，services/smart-marketing/real-llm.js），
 * 失败/超时/SMART_MKT_REAL_LLM=off 时回落确定性模拟打分（接口形态与真实 LLM 一致）；
 * trace 带 real 标记可审计每轮用的是真模型还是模拟。
 *
 * 运行时约定（2026-11-06 与平台架构对齐）：agent 基础框架统一用 openJiuwen
 * （agent-store-builder 多个工具已复用其 Python agent-runtime/agent-core 的
 * AgentApp / A2A / Session / Checkpoint）。本模块为编排适配层：接口与 openJiuwen
 * 概念一一对应，当前执行为本地确定性模拟，真实部署时按 OPENJIUWEN_MAP 平替。
 *
 * 流程引擎执行语义（rule/llm 统一）：
 *   到达节点 → 说话术 → 等用户回复 → 匹配分支 → 路由到下一节点（同轮承接说话）。
 *   __spoken 标记区分「刚到达要说」与「已说过在等分支」；意图/工具节点为静默路由器。
 * ============================================================ */

const crypto = require('node:crypto');
const realLlm = require('./real-llm');
const agentLlm = require('./agent-llm');

/* ────────────────────────── 常量 ────────────────────────── */

const STAGES = {
  rule: { key: 'rule', name: '规则流程', tag: '阶段一', runtime: 'builtin-flow', desc: '节点图 + 意图分支，确定性状态机，100% 可控可审计。无反思层：命中红线直接熔断转人工' },
  llm: { key: 'llm', name: 'LLM 流程', tag: '阶段二', runtime: 'openjiuwen-workflow', desc: '流程图不变，意图识别从关键词升级为大模型判断，话术生成、槽位抽取、工具调用同样由模型增强 · 运行时 openJiuwen Workflow' },
  agent: { key: 'agent', name: '模型主导', tag: '阶段三', runtime: 'openjiuwen-agent', desc: '只定目标和知识，不画流程，模型自己把握整通电话的节奏与收尾 · 运行时 openJiuwen AgentApp' },
};

/* 工具风险分级（WOWService §9.5 思路：read_only / 可逆写 / 不可逆写 / 控制类，不可逆动作须先确认） */
const TOOL_RISKS = {
  query_bill: { risk: 'read_only', label: '只读', requires_confirmation: false, note: '不产生业务副作用' },
  register_callback: { risk: 'write_reversible', label: '可逆写', requires_confirmation: false, note: '登记回访，可撤销' },
  register_benefit: { risk: 'write_irreversible', label: '不可逆写', requires_confirmation: true, note: '开通权益，须先经 confirm 轮确认' },
  register_dnd: { risk: 'write_reversible', label: '可逆写', requires_confirmation: false, note: '免打扰登记，可撤销' },
  transfer_human: { risk: 'control', label: '控制', requires_confirmation: false, note: '会话移交，无业务副作用' },
};

/* openJiuwen 概念映射：真实部署时按此表把模拟实现平替为 Runtime 调用 */
const OPENJIUWEN_MAP = {
  session: 'Session（openJiuwen agent-core）——createSession/stepSession 与其会话生命周期一致',
  workflow_rule: '阶段一节点图 → openJiuwen Workflow 编排（条件节点 + 意图分支）',
  workflow_llm: '阶段二 intent/gen/slot 节点 → openJiuwen Workflow 的 LLM 节点（Prompt + 知识检索）',
  tools: 'query_bill / register_callback / transfer_human → AgentApp Tool Calling（工具注册后由流程/模型调用）',
  agent_policy: '阶段三 policy（目标/知识/边界）→ AgentApp 的 system prompt + guardrails + 知识库挂载',
  handoff: '转人工 → A2A 协议把会话与上下文移交人工坐席 Agent',
  checkpoint: '通话中断续拨 → Checkpoint 恢复会话状态',
};

const RUNTIMES = {
  'builtin-flow': { name: '内置流程引擎', simulated: true, note: '阶段一规则状态机，无 agent 框架依赖' },
  'openjiuwen-workflow': { name: 'openJiuwen Workflow', simulated: true, note: '节点编排对齐 openJiuwen workflow，intent/gen/slot/tool 运行在 AgentApp 之上；当前为本地模拟' },
  'openjiuwen-agent': { name: 'openJiuwen AgentApp', simulated: true, note: '主 Agent 全局决策 + Tools-as-Tools 调度，Session/Checkpoint 复用 openJiuwen agent-runtime；当前为本地模拟' },
};

/* 合规红线：所有阶段共用（银行外呼底线，源自合规页口径）。
   MKT-14 结构化（codex 二审）：每条红线有 id/level，级别决定处置路径——
   hard = 监管级禁止内容，命中直接熔断转人工，不允许反思改写（改写不能把
   「保本」改成合规表述，改写等于掩盖违规）；soft = 可反思改写一次的表述问题。 */
const COMPLIANCE_RULES = [
  { id: 'R1', word: '保本', level: 'hard', why: '收益承诺违规' },
  { id: 'R2', word: '稳赚', level: 'hard', why: '收益承诺违规' },
  { id: 'R3', word: '肯定涨', level: 'hard', why: '收益承诺违规' },
  { id: 'R4', word: '内部消息', level: 'hard', why: '信息合规违规' },
  { id: 'R5', word: '必须办理', level: 'hard', why: '胁迫式营销' },
  { id: 'R6', word: '不办就', level: 'hard', why: '威胁式营销' },
];
const BANNED_WORDS = COMPLIANCE_RULES.map(r => r.word);   // 兼容旧引用
const RECORDING_HINT = '本次通话将录音';

/* 用户意图标签（模拟用户 / 人工输入共用一套） */
const USER_INTENTS = ['affirm', 'deny', 'refuse', 'question', 'busy', 'silence', 'consent_record', 'other'];

/* ────────────────────────── 工具 ────────────────────────── */

function now() { return new Date().toISOString(); }
function uid() { return crypto.randomBytes(4).toString('hex'); }
function hash01(str) { // 确定性伪随机 0..1（保证同一会话回放一致）
  const h = crypto.createHash('md5').update(String(str)).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

/* ── 用户输入解析：三个引擎共用的底层 NLU（模拟） ──
   真实系统里这是 ASR→NLU/LLM；这里用规则+词表确定性解析，带 ground truth 时以 ground truth 为准。 */
function parseUserInput(text, groundTruth) {
  const t = String(text || '').trim();
  if (groundTruth && USER_INTENTS.indexOf(groundTruth) !== -1) {
    return {
      text: t, intent: groundTruth, intents: [groundTruth], raw: t,
      sentiment: (groundTruth === 'affirm' || groundTruth === 'consent_record') ? 'pos' : ((groundTruth === 'deny' || groundTruth === 'refuse' || groundTruth === 'busy') ? 'neg' : 'neutral'),
    };
  }
  if (!t) return { text: '', intent: 'silence', intents: ['silence'], sentiment: 'neutral', raw: t };
  const low = t.toLowerCase();
  const has = re => re.test(low);
  let intent = 'other';
  if (has(/不用|不需要|别再|算了|拒绝|没必要|不要|别打|挂了/)) intent = 'refuse';
  else if (has(/没时间|在忙|开会|晚点|回头|再说|忙/)) intent = 'busy';
  else if (has(/好的?|可以|行[的,.。!！]?|嗯+|是的?|对|愿意|要的?|办理吧|同意|ok|好呀|没问题|弄一个/)) intent = 'affirm';
  else if (has(/不办|不打算|没兴趣|不考虑|有什么用/)) intent = 'deny';
  else if (has(/什么|怎么|多少|哪|是不是|能不能|[?？]/)) intent = 'question';
  else if (has(/知道啦|知道了/)) intent = 'consent_record';
  const sentiment = intent === 'affirm' || intent === 'consent_record' ? 'pos' : (intent === 'deny' || intent === 'refuse' || intent === 'busy' ? 'neg' : 'neutral');
  return { text: t, intent, intents: [intent], sentiment, raw: t };
}

/* ── 合规护栏：所有引擎出话前必过 ──
   两级处置（WOWService §4.4 在线质检思路）：
   - banned_word 命中 → 规则流熔断转人工；LLM/agent 引擎先尝试一次「反思重写」，
     重写仍命中才熔断（trace 记 reflect 动作）
   - missing_recording → 属于配置缺陷，记录不拦截（校验器已在设计期提示） */
function complianceCheck(text, ctx) {
  const problems = [];
  COMPLIANCE_RULES.forEach(r => {
    if (text.indexOf(r.word) !== -1) problems.push({ code: 'banned_word', word: r.word, rule_id: r.id, level: r.level, why: r.why });
  });
  if (ctx && ctx.isOpening && text.indexOf(RECORDING_HINT) === -1) {
    problems.push({ code: 'missing_recording', word: RECORDING_HINT, level: 'soft' });
  }
  return { ok: problems.length === 0, problems, hasHard: problems.some(p => p.level === 'hard') };
}

/* 反思重写：命中禁词时改写话术（确定性模拟 LLM self-reflection）。
   realReflector 可注入真实 LLM；默认策略：去掉禁词所在分句并加合规化引导。
   MKT-14：hard 级红线不允许改写（改写收益承诺=掩盖违规），调用方必须先判 hasHard。 */
function reflectRewrite(text, problems, reflector) {
  if (reflector) return reflector(text, problems);
  const rewriteable = (problems || []).filter(p => p.code === 'banned_word' && p.level !== 'hard');
  let t = String(text || '');
  rewriteable.forEach(p => {
    // 按分句切（中英文标点），剔除含禁词的分句
    const parts = t.split(/(?<=[。！？!?；;，,])/).filter(Boolean);
    t = parts.filter(seg => seg.indexOf(p.word) === -1).join('') || t;
  });
  return t;
}

/* ── 统一动作协议（WOWService §4.1/§9.3：回复与工具命令同源，带证据链与风险标记） ──
   每轮引擎产出统一 TurnRecord；routes 层原样返回给前端，可回放可审计。 */
function turnRecord(s, opts) {
  opts = opts || {};
  return {
    turn_id: s.id + ':t' + s.turn,
    session_id: s.id,
    turn: s.turn,
    stage: s.stage,
    message: opts.message || '',
    intent: opts.intent || null,               // 引擎判定的用户意图
    evidence: opts.evidence || [],             // [{knowledge_id, title, version}] 知识引用链
    actions: opts.actions || [],               // [{action_id, tool, arguments, risk, idempotency_key, requires_confirmation, executed}]
    next_state: opts.next_state || (s.status === 'active' ? 'WAIT_USER' : s.status.toUpperCase()),
    plan_consistent: opts.plan_consistent !== false, // 回复—动作一致性检查
  };
}

/* ────────────────────────── 模拟用户 ────────────────────────── */

const PERSONAS = {
  cooperative: { name: '配合型', desc: '愿意听、顺着走，意向看权益' },
  hesitant: { name: '犹豫型', desc: '反复问细节，决策慢' },
  objection: { name: '异议型', desc: '先质疑是不是推销，对权益挑剔' },
  busy: { name: '忙碌型', desc: '没时间，倾向快速结束' },
  chatty: { name: '多话型', desc: '爱聊，容易跑题' },
  /* 高风险人格（codex 审核 P1：覆盖偏乐观，缺拒绝/投诉/身份质疑/费用条款/沉默场景。
     这些是上线前必须验证的边界——引擎在这类客户面前不得虚假达标、不得违规推进） */
  resolute: { name: '明确拒绝型', desc: '态度坚决地拒绝，考验拒绝闸与收尾保证', risk: true },
  complain: { name: '投诉型', desc: '情绪激动要投诉/转人工，考验投诉闸与强制转接', risk: true },
  identity: { name: '身份质疑型', desc: '怀疑是不是诈骗/要求证明身份，考验 AI 声明与信息核验', risk: true },
  fee: { name: '费用纠缠型', desc: '反复追问费用条款、怕被扣钱，考验口径一致与知识检索', risk: true },
  silent: { name: '沉默型', desc: '不说话或单字应付，考验静音处理与主动收尾', risk: true },
};

const UTTER_BANK = {
  cooperative: [
    { text: '喂，你好。', intent: 'other' },
    { text: '嗯，你说。', intent: 'affirm' },
    { text: '可以，具体是什么活动？', intent: 'question' },
    { text: '听起来还行，怎么办理？', intent: 'affirm' },
    { text: '好的，那就办理吧。', intent: 'affirm' },
    { text: '行，知道了，谢谢。', intent: 'consent_record' },
  ],
  hesitant: [
    { text: '喂？哪位？', intent: 'other' },
    { text: '什么事？', intent: 'question' },
    { text: '要收钱吗？', intent: 'question' },
    { text: '嗯……我再想想。', intent: 'deny' },
    { text: '真的不用额外费用？', intent: 'question' },
    { text: '那……好吧，先弄一个。', intent: 'affirm' },
  ],
  objection: [
    { text: '你好。', intent: 'other' },
    { text: '是不是推销？', intent: 'question' },
    { text: '我不需要，你们别再打了。', intent: 'refuse' },
    { text: '上次也是你们打，有什么用？', intent: 'deny' },
    { text: '……你说说看，有什么不一样的。', intent: 'question' },
    { text: '行吧，这次算你们有心。', intent: 'affirm' },
  ],
  busy: [
    { text: '喂，说话快一点，我在忙。', intent: 'busy' },
    { text: '什么事？简短点。', intent: 'busy' },
    { text: '没时间，回头再说。', intent: 'busy' },
    { text: '……那你说，30 秒讲完。', intent: 'question' },
    { text: '行行行，可以可以。', intent: 'affirm' },
    { text: '好了好了，就这样，挂了啊。', intent: 'refuse' },
  ],
  chatty: [
    { text: '哎你好你好！', intent: 'other' },
    { text: '你们这个APP我天天用啊，跟你说……', intent: 'other' },
    { text: '等下，我姐昨天也接到你们电话了？', intent: 'question' },
    { text: '哦哦这个活动，听起来不错嘛。', intent: 'affirm' },
    { text: '那个怎么弄？在哪儿点？', intent: 'question' },
    { text: '好呀好呀，那就这么定了。', intent: 'affirm' },
  ],
  /* ── 高风险人格话术库（与 PERSONAS.risk 对应）── */
  resolute: [
    { text: '喂，哪位？', intent: 'other' },
    { text: '不需要，别再打了。', intent: 'refuse' },
    { text: '说了不需要，挂了。', intent: 'refuse' },
    { text: '别再给我打电话了！', intent: 'refuse' },
  ],
  complain: [
    { text: '喂？', intent: 'other' },
    { text: '你们一天打八个电话，我要投诉！', intent: 'refuse' },
    { text: '转人工！叫你们领导来！', intent: 'refuse' },
    { text: '再打我就去银监会告你们。', intent: 'refuse' },
  ],
  identity: [
    { text: '喂，你哪个？', intent: 'other' },
    { text: '你不会是诈骗电话吧？怎么证明你是银行的？', intent: 'question' },
    { text: '我不敢信，你们是不是骗子？工号能查吗？', intent: 'question' },
    { text: '那你说是智能语音就是？谁知道你是不是人。', intent: 'question' },
  ],
  fee: [
    { text: '你好，什么事？', intent: 'other' },
    { text: '这个要收钱吗？会不会扣我费用？', intent: 'question' },
    { text: '你说不收费，那为什么给我办？背后有什么条款？', intent: 'question' },
    { text: '万一以后收费呢？合同里写了吗？我不放心。', intent: 'question' },
    // 最后一句标注 question 而非 affirm：「先了解下」是继续咨询，不是办理确认。
    // 之前误标 affirm 会让费用纠缠型被引擎记为 confirmed 并虚假 100% 达成。
    { text: '真的一分钱不收？那……那先了解下吧。', intent: 'question' },
  ],
  silent: [
    { text: '', intent: 'silence' },
    { text: '嗯。', intent: 'affirm' },
    { text: '', intent: 'silence' },
    { text: '哦。', intent: 'other' },
    { text: '', intent: 'silence' },
  ],
};

/* persona 驱动的下一句（auto 模式），确定性轮转 + 状态感知 */
function personaUtterance(persona, turn, sessionSeed, state) {
  const bank = UTTER_BANK[persona] || UTTER_BANK.cooperative;
  let idx = turn % bank.length;
  if (state && state.slots && state.slots.intent === 'positive' && (persona === 'cooperative' || persona === 'chatty')) idx = bank.length - 1;
  const u = bank[idx];
  return { text: u.text, intent: u.intent };
}

/* ────────────────────────── 会话 ────────────────────────── */

function createSession(script, customer, opts) {
  opts = opts || {};
  // 脚本级变量声明（Voiceflow Variables / Dify Conversation Variables）：
  // 用户可显式创建变量并给默认值，会话开始时注入 vars，跨轮且跨子流程共享。
  const vars = {
    name: customer ? (customer.name || '') : '客户',
    amt30: customer ? (customer.amt30 != null ? customer.amt30 : '') : '',
    txn30: customer ? (customer.txn30 != null ? customer.txn30 : '') : '',
    // MKT-03 消费降幅有据断言：drop_ratio 由客户画像字段（txnPrev→txn30）计算，
    // 数据缺失时为空 → 条件段 ${drop_ratio:...} 整段不渲染（不说无依据的话）
    drop_ratio: (customer && customer.txnPrev > 0 && customer.txn30 != null)
      ? Math.round((1 - customer.txn30 / customer.txnPrev) * 100) + '%' : '',
  };
  (script.variables || []).forEach(v => {
    if (!v || !String(v.name || '').trim()) return;
    const k = String(v.name).trim();
    if (!Object.prototype.hasOwnProperty.call(vars, k)) vars[k] = coerceVar(v.default, v.type);
  });
  return {
    id: 'SES_' + uid().toUpperCase(),
    script_id: script.id,
    script_version: script.version || 1,   // 版本化：回溯「哪版脚本跑的这通电话」
    script_name: script.name || '',
    stage: script.stage,
    customer: customer ? { xid: customer.xid, name: customer.name } : null,
    persona: opts.persona || 'cooperative',
    mode: opts.mode || 'auto', // auto=人格接管 | manual=人工扮演客户
    vars,
    slots: {},
    turn: 0,
    history: [],        // [{role:'bot'|'user', text, intent?, turn}]
    trace: [],          // [{turn, engine, action, detail}]
    turn_records: [],   // 统一动作协议 TurnRecord（每轮一条，含 evidence/actions）
    status: 'active',   // active|done|hangup|handoff
    end_reason: null,
    case_label: null,   // good|bad|null —— SRT 数据回流标签（WOWService §4.3）
    created_at: now(),
  };
}

function pushBot(s, text, action, detail) {
  if (text) s.history.push({ role: 'bot', text, turn: s.turn });
  s.trace.push({ turn: s.turn, engine: s.stage, action, detail: detail || '' });
  // 统一动作协议：引擎每轮在 s.__last_turn_record 挂本轮 TurnRecord，这里归档
  if (s.__last_turn_record) { s.turn_records.push(s.__last_turn_record); s.__last_turn_record = null; }
}
function pushUser(s, parsed) {
  s.history.push({ role: 'user', text: parsed.text, intent: parsed.intent, turn: s.turn });
}

/* 会话结束后的汇总指标：三引擎同口径可比 */
function sessionMetrics(s, script) {
  const required = (script.stage === 'agent' && script.policy && script.policy.required_slots) || [];
  const slotsHit = required.filter(k => s.slots[k]).length;
  // 目标达成判定收紧（codex 审核 P0：客户只说「知道了/嗯，你说」曾被计 100% 达成，
  // 极易制造虚假成功率并反向激励过度推销）。达成必须绑定「可验证意向」：
  //   · intent 槽位记录的是正向意向（positive/interested），或
  //   · 不可逆动作（开通权益）经客户确认后执行（confirmed 槽位，agent 引擎确认闸落账）
  // 「知道了」（consent_record）只代表听懂，「嗯，你说」只是承接，均不构成办理意向。
  // rule/llm 引擎的 intent 节点同义映射：interested 即正向；confirmed 闸只对不可逆工具落账。
  const intentSlot = String(s.slots.intent || '').toLowerCase();
  const verified = intentSlot === 'positive' || intentSlot === 'interested' || !!s.slots.confirmed;
  const success = s.end_reason === 'success' && verified;
  return {
    turns: s.turn,
    status: s.status,
    end_reason: s.end_reason,
    goal_completion: required.length ? slotsHit / required.length : (success ? 1 : 0),
    slots: Object.assign({}, s.slots),
    compliance_hits: s.trace.filter(t => t.action === 'compliance_block').length,
    reflects: s.trace.filter(t => t.action === 'reflect').length,
    handoff: s.status === 'handoff',
    script_version: s.script_version,
    // SRT 案例自动分层（WOWService §4.3 自优化数据闭环的入口）：
    // good=成功且无合规问题；bad=转人工/合规拦截；其余不标（neutral 由人工抽检）
    case_label: s.end_reason === 'success' && s.trace.every(t => t.action !== 'compliance_block') ? 'good'
      : (s.status === 'handoff' || s.trace.some(t => t.action === 'compliance_block') ? 'bad' : null),
  };
}

function renderText(tpl, session) {
  let t = String(tpl || '');
  // 条件段 ${var:...content...}：变量有值才展开内容段（值内嵌套 ${var} 一并插值），
  // 缺失时整段丢弃——事实断言必须有数据支撑，缺失就不说（MKT-03 缺失处理）。
  // 注意 content 里允许再出现单个 '}'（如中文「，}」不会出现，但内容含 '}' 的场景用正则
  // 非贪婪匹配即可）；这里 content 匹配到下一个 '}' 为止。
  t = t.replace(/\$\{(\w+):((?:[^}]|\}(?!\}))*)\}/g, (_, k, content) => {
    const vars = session.vars || {}, slots = session.slots || {};
    const v = Object.prototype.hasOwnProperty.call(vars, k) ? vars[k]
      : (Object.prototype.hasOwnProperty.call(slots, k) ? slots[k] : null);
    if (v == null || v === '') return '';
    return content.replace(/\$\{(\w+)\}/g, (m2, k2) => {
      const v2 = Object.prototype.hasOwnProperty.call(vars, k2) ? vars[k2]
        : (Object.prototype.hasOwnProperty.call(slots, k2) ? slots[k2] : null);
      return (v2 != null && v2 !== '') ? v2 : '';
    });
  });
  // 支持 <branchId>.<key>：并行汇聚点按分支前缀写回的变量也要能在话术里引用。
  return t.replace(/\$\{([\w.]+)\}/g, (_, k) => {
    // 变量优先级：客户画像 vars > 会话 slots（槽位抽取/工具结果） > 缺省占位。
    // 用 hasOwnProperty 判定，避免 0 / false 这类合法值被 || 吞掉后渲染成破折号。
    const vars = session.vars || {}, slots = session.slots || {};
    const v = Object.prototype.hasOwnProperty.call(vars, k) ? vars[k]
      : (Object.prototype.hasOwnProperty.call(slots, k) ? slots[k] : null);
    return (v != null && v !== '') ? v : '—';
  });
}

/* ═════════════════════ 全局 handler（Dialogflow CX State handlers / Botpress Hooks） ═════════════════════
   脚本级配置 script.handlers，不是节点。运行时按 Scope → Evaluation → Call 三步：
   - before 阶段（event='intent'）：flow 级路由被每个节点继承，用户任意时刻说「转人工」即打断；
     first-match、按 priority 降序、命中后其余忽略（CX event handlers 语义）。
   - after 阶段（event='no_match' / 'no_input'）：局部引擎跑完仍未识别才触发，
     afterCount 对应 CX 的 sys.no-match-N / sys.no-input-N 按次数递增。
   - session_end：会话结束时只记轨迹，不覆盖回复。
   两代差异仍只在意图识别：rule 用词表/内置意图，llm 可先由 stepSessionAsync 注入真实 LLM 判定。 */
const HANDLER_EVENTS = ['intent', 'no_match', 'no_input', 'session_end'];

function handlersOf(script, phase) {
  const all = (script && Array.isArray(script.handlers)) ? script.handlers : [];
  const want = phase === 'before' ? ['intent']
    : phase === 'after' ? ['no_match', 'no_input'] : [];
  return all.filter(h => h && h.enabled !== false && want.indexOf(h.event) !== -1)
    .map((h, i) => ({ h, i }))
    .sort((a, b) => (Number(b.h.priority) || 0) - (Number(a.h.priority) || 0) || a.i - b.i)
    .map(x => x.h);
}

function handlerMatched(h, parsed, s) {
  // 第二代真实 LLM 判定优先注入（两代只差意图识别）
  if (s.__realGlobalHandler && s.__realGlobalHandler.id === h.id) return s.__realGlobalHandler.how;
  if (Array.isArray(h.match_intents) && h.match_intents.indexOf(parsed.intent) !== -1)
    return '内置意图 ' + parsed.intent;
  const t = String(parsed.text || '');
  if (!t) return null;
  for (const k of (h.keywords || [])) { if (k && t.indexOf(String(k)) !== -1) return '关键词「' + k + '」'; }
  for (const k of (h.examples || [])) { if (k && t.indexOf(String(k)) !== -1) return '示例「' + k + '」'; }
  return null;
}

function handlerCooling(s, h) {
  const cool = s.slots.__ghCool || (s.slots.__ghCool = {});
  return (cool[h.id] || 0) > s.turn;
}

/* 覆盖本轮回复：替换同轮最后一条 bot 消息而不是再 push 一条，
   避免 history 出现两条回复、turn_record 被重复归档。 */
function handlerSay(s, text, detail) {
  const last = s.history[s.history.length - 1];
  if (last && last.role === 'bot' && last.turn === s.turn) last.text = text;
  else s.history.push({ role: 'bot', text, turn: s.turn });
  s.trace.push({ turn: s.turn, engine: s.stage, action: 'global_handler', detail: detail });
}

function fireHandler(script, s, h, parsed, how, r) {
  const cool = s.slots.__ghCool || (s.slots.__ghCool = {});
  const cnt = s.slots.__ghCount || (s.slots.__ghCount = {});
  cnt[h.id] = (cnt[h.id] || 0) + 1;
  if (h.cooldownTurns) cool[h.id] = s.turn + Number(h.cooldownTurns);
  const out = Object.assign({}, r || {});
  const scriptNow = activeScript(script, s);
  if (h.text) {
    const text = renderText(h.text, s);
    handlerSay(s, text, h.id + '（' + (h.event || '') + '）· ' + how + ' · 第 ' + cnt[h.id] + ' 次');
    out.text = text;
  } else {
    s.trace.push({ turn: s.turn, engine: s.stage, action: 'global_handler',
      detail: h.id + '（' + (h.event || '') + '）· ' + how + ' · 静默动作（无播报）· 第 ' + cnt[h.id] + ' 次' });
  }
  if (h.to && !h.resume && findNode(scriptNow, h.to)) {
    s.slots.__node = h.to; s.slots.__spoken = null; s.slots.__spoken_fb = false;
  }
  if (h.end) {
    s.status = 'done'; s.end_reason = h.end_reason || 'global_handler';
    out.done = true;
    if (h.end_reason === 'handoff' || h.end_reason === 'transfer') out.handoff = true;
  }
  return out;
}

/* 会话结束钩子（Botpress After Conversation End）：只记轨迹，不受 first-match 影响。
   必须在全局 handler 已经覆盖过回复、最终会话状态确定之后调用。 */
function fireSessionEndHandlers(script, s) {
  ((script && script.handlers) || []).filter(h => h && h.enabled !== false && h.event === 'session_end')
    .forEach(h => s.trace.push({ turn: s.turn, engine: s.stage, action: 'global_handler_end',
      detail: h.id + ' · ' + (h.name || '') }));
}

function runGlobalHandlers(script, s, parsed, phase, r) {
  const list = handlersOf(script, phase);
  if (!list.length) return null;
  const streaks = s.slots.__ghStreak || (s.slots.__ghStreak = {});
  // 只在 after 计数：before 也跑一次会把连续次数算成两倍（CX 的 sys.no-match-N 按轮计）。
  const isNoMatch = phase === 'after' && Boolean(s.__lastUnrecognized);
  const isNoInput = phase === 'after' && (parsed.intent === 'silence' || !String(parsed.text || '').trim());
  if (phase === 'after') {
    streaks.no_match = isNoMatch ? (streaks.no_match || 0) + 1 : 0;
    streaks.no_input = isNoInput ? (streaks.no_input || 0) + 1 : 0;
  }
  for (const h of list) {
    if (handlerCooling(s, h)) continue;                       // Scope + cooldown
    if (h.event === 'no_match' && !isNoMatch) continue;       // Evaluation
    if (h.event === 'no_input' && !isNoInput) continue;
    const key = h.event === 'no_match' ? 'no_match' : (h.event === 'no_input' ? 'no_input' : null);
    if (key) {
      const need = Math.max(1, Number(h.afterCount) || 1);
      if ((streaks[key] || 0) < need) continue;
    }
    const how = h.event === 'intent' ? handlerMatched(h, parsed, s) : '连续 ' + (streaks[key] || 0) + ' 次';
    if (!how) continue;
    return fireHandler(script, s, h, parsed, how, r);         // Call：first-match，其余忽略
  }
  return null;
}

/* 第二代全局打断意图的真实 LLM 判定：从候选 handler 中选一个，失败自然回落词表。 */
async function realGlobalHandlerMatch(utterText, handlers) {
  if (!utterText || !utterText.trim() || !handlers.length) return null;
  const list = handlers.map((h, i) => '- 条件' + (i + 1) + '：' + (h.name || h.id) + '。典型说法：'
    + ((h.examples || []).join('、') || (h.keywords || []).join('、') || '（未配置示例）')).join('\n');
  const SYSTEM = '你是银行外呼电话的全局意图识别器。判断客户这句话是否要触发某个全局处理（如转人工、投诉、要求挂机）。只输出 JSON：{"match":序号或0,"score":0到1}。0=都不触发。不要输出其他内容。';
  const r = await realLlm.chat([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: '全局处理列表：\n' + list + '\n\n客户说：「' + utterText + '」' },
  ], { maxTokens: 400, temperature: 0 });
  if (!r.ok) return null;
  try {
    const m = r.text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : r.text);
    const idx = Number(j.match);
    if (!idx || idx < 1 || idx > handlers.length) return null;
    const score = Math.max(0, Math.min(1, Number(j.score) || 0));
    if (score < 0.5) return null;
    return { id: handlers[idx - 1].id, how: 'LLM ' + Math.round(score * 100) + '%' };
  } catch (e) { return null; }
}

/* ═════════════════════ 并行分支（Dify Serial/Parallel Execution） ═════════════════════
   电话是一问一答的单指针状态机，同时只能播报一句，因此这里的「并行」是
   fan-out 静默任务（变量赋值 / 工具 / 条件），不是多条话术并发播报。
   严格按 Dify 语义：各分支从同一份进入快照启动 → 互相读不到对方新写的变量 →
   汇聚点下游可读全部（<branchId>.<key> 前缀 + 显式 outputs 映射）。 */
const PARALLEL_SILENT_TYPES = ['assign', 'tool', 'condition'];

function clonePlain(o) { return JSON.parse(JSON.stringify(o == null ? {} : o)); }

function shadowForParallel(s, snapVars, snapSlots, depth) {
  return Object.assign({}, s, {
    vars: clonePlain(snapVars),
    slots: clonePlain(snapSlots),
    history: [],                       // 分支内播报不进主对话
    turn_records: [],
    trace: s.trace,                    // 执行轨迹合并进主 trace，便于回溯
    __flowStack: clonePlain(s.__flowStack || []),
    __nodeVisits: clonePlain(s.__nodeVisits || {}),
    __last_turn_record: null, __lastUnrecognized: false,
    __realIntent: null, __realText: null, __realBranch: null, __realGlobalHandler: null,
    __parallelDepth: depth,
  });
}

function parallelDiff(snap, now) {
  const out = {};
  Object.keys(now || {}).forEach(k => {
    if (k.indexOf('__') === 0) return;
    if (!Object.prototype.hasOwnProperty.call(snap || {}, k) || JSON.stringify(snap[k]) !== JSON.stringify(now[k]))
      out[k] = now[k];
  });
  return out;
}

function applyParallelJoin(node, s, results, snapVars, snapSlots) {
  const changed = [];
  // 1) 显式出参映射（Voiceflow/Botpress 的 output variables）
  (node.outputs || []).forEach(m => {
    if (!m || !String(m.key || '').trim()) return;
    const src = results.find(r => r.id === m.branch) || results[0];
    if (!src) return;
    const from = String(m.from || '').trim();
    const v = Object.prototype.hasOwnProperty.call(src.vars, from) ? src.vars[from]
      : (Object.prototype.hasOwnProperty.call(src.slots, from) ? src.slots[from] : null);
    if (v != null) { s.vars[String(m.key).trim()] = v; changed.push(String(m.key).trim() + '=' + v); }
  });
  // 2) 自动前缀：各分支相对快照的变化量都可在汇聚点下游按 <branchId>.<key> 读到
  results.forEach(r => {
    const bid = String(r.id);
    const dv = parallelDiff(snapVars, r.vars), ds = parallelDiff(snapSlots, r.slots);
    Object.keys(dv).forEach(k => { s.vars[bid + '.' + k] = dv[k]; });
    Object.keys(ds).forEach(k => { s.vars[bid + '.' + k] = ds[k]; });
    // 工具/槽位在分支内写出的业务 slots，未显式映射时按后写覆盖合并回主会话
    Object.keys(ds).forEach(k => { s.slots[k] = ds[k]; });
  });
  s.trace.push({ turn: s.turn, engine: s.stage, action: 'parallel_join',
    detail: node.id + ' · ' + results.length + ' 分支 · ' + (node.joinMode || 'all') + ' · ' + (changed.join('，') || '自动前缀写回') });
}

function runParallelNode(root, s, node, parsed, depth, stepFn) {
  const script = activeScript(root, s);
  const list = (node.branches || []).filter(b => b && b.to && findNode(script, b.to));
  const joinTo = node.join || node.to;
  const myDepth = (s.__parallelDepth || 0) + 1;
  if (myDepth > 1 || list.length < 2 || !joinTo || !findNode(script, joinTo)) {
    s.status = 'done'; s.end_reason = 'parallel_config';
    return { text: '（并行分支配置错误：需要至少 2 条有效分支和汇聚节点，且禁止嵌套并行）', done: true };
  }
  const snapVars = clonePlain(s.vars), snapSlots = clonePlain(s.slots);
  const results = [];
  const maxSteps = Math.max(1, Math.min(24, Number(node.maxSteps) || 12));
  s.trace.push({ turn: s.turn, engine: s.stage, action: 'parallel_fork',
    detail: node.id + ' · ' + list.length + ' 分支 · 变量快照隔离' });
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const bid = String(b.id || b.name || ('b' + (i + 1)));
    const sub = shadowForParallel(s, snapVars, snapSlots, myDepth);
    sub.slots.__node = b.to; sub.slots.__spoken = null; sub.slots.__spoken_fb = false;
    const t0 = s.trace.length;
    let spoke = false, overflow = false;
    try { stepFn(root, sub, parsed, 0); } catch (e) { /* 分支异常不外抛，按失败记录 */ }
    const spokeNode = sub.slots.__spoken ? findNode(script, sub.slots.__spoken) : null;
    spoke = Boolean(spokeNode && PARALLEL_SILENT_TYPES.indexOf(spokeNode.type) === -1);
    overflow = (s.trace.length - t0) > maxSteps;
    results.push({ id: bid, vars: sub.vars, slots: sub.slots, spoke, overflow,
      status: sub.status, detail: bid + (spoke ? '（分支含交互节点，产出仅按变量合并）' : '') + (overflow ? '（超过 maxSteps）' : '') });
    s.trace.push({ turn: s.turn, engine: s.stage, action: 'parallel_branch', detail: results[results.length - 1].detail });
    if (node.joinMode === 'any' && !spoke && !overflow) break;
  }
  applyParallelJoin(node, s, results, snapVars, snapSlots);
  s.slots.__node = joinTo; s.slots.__spoken = null;
  return stepFn(root, s, parsed, depth + 1);
}

function findNode(script, id) {
  return (script.nodes || []).find(n => n.id === id) || null;
}

/* ────────────────────────── 变量赋值 / 子流程编排 ──────────────────────────
   调研基线（2026-11-09 实读官方原文，非凭印象）：
   · Voiceflow《Set》：一个节点可写多个变量（Value / Prompt），静默执行、连线即走；
     《Variables》：变量可在侧栏显式创建并设默认值，按 user_id 隔离、跨轮保存。
   · Voiceflow《Workflow step》：调用另一 workflow，结束后「returns to the original
     workflow and continues from where it left off」——必须有调用栈，不是 goto。
   · Botpress《Dialog Engine》：Transition 目的地含「The previous Flow (Flow Stacks)」；
     「the state is global to the conversation, so if the conversation spans multiple
     flows, the state is shared for all the flows」；《Pass variables between Workflows》：
     Entry/Exit Node 声明输入/输出变量，父流程用 workflow.<card>.<var> 读子流程输出。
   · Dify《Variable Assigner》：单节点多变量赋值，op 含 overwrite/clear/set/arithmetic/
     append；Conversation Variables 跨轮持久，Workflow Variables 单次执行内有效。

   本实现取四者交集，且遵守用户定的「两代只差意图识别」：assign / flow 在 rule 与
   llm 两代语义完全一致。
   设计取舍：变量统一放 session.vars（会话级、跨轮、跨子流程共享，等价 Botpress State /
   Dify Conversation Variables），不引入 Workflow/Bot/User 三级作用域与类型系统；
   不做并行分支与变量聚合器（Dify 明确说明 Variable Aggregator 只汇聚互斥分支）。 */

let SCRIPT_RESOLVER = null;
function setScriptResolver(fn) { SCRIPT_RESOLVER = typeof fn === 'function' ? fn : null; }
function resolveScript(id) {
  if (!SCRIPT_RESOLVER || !id) return null;
  try { return SCRIPT_RESOLVER(id) || null; } catch (e) { return null; }
}
/* 当前活动脚本：栈顶是被调用的子流程。resolver 是模块级注入，与传入的 script 对象无关，
   因此 ruleStep/llmStep 只需在入口把参数重指向活动脚本，函数体所有 findNode 自动生效。 */
function activeScript(script, s) {
  const st = s.__flowStack || [];
  if (!st.length) return script;
  return resolveScript(st[st.length - 1].script_id) || script;
}
function coerceVar(raw, type) {
  if (type === 'number') return Number(raw) || 0;
  if (type === 'boolean') return raw === true || raw === 'true' || raw === 1;
  return raw == null ? '' : String(raw);
}
function assignmentValue(raw, s) {
  const t = String(raw == null ? '' : raw).trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '') return '';
  if (/^'.*'$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return renderText(raw, s);   // 其余按模板处理，支持 ${var} 插值
}
function runAssignments(node, s) {
  const done = [];
  (node.assignments || []).forEach(a => {
    if (!a || !String(a.key || '').trim()) return;
    const key = String(a.key).trim();
    const op = a.op || 'set';
    const cur = s.vars[key];
    let next;
    if (op === 'copy') {
      const src = String(a.value || '').trim();
      next = Object.prototype.hasOwnProperty.call(s.vars, src) ? s.vars[src]
        : (Object.prototype.hasOwnProperty.call(s.slots, src) ? s.slots[src] : '');
    } else {
      const val = assignmentValue(a.value, s);
      switch (op) {
        case 'add': next = (Number(cur) || 0) + (Number(val) || 0); break;
        case 'sub': next = (Number(cur) || 0) - (Number(val) || 0); break;
        case 'mul': next = (Number(cur) || 0) * (Number(val) || 0); break;
        case 'div': next = Number(val) === 0 ? (Number(cur) || 0) : (Number(cur) || 0) / Number(val); break;
        case 'append': next = String(cur == null ? '' : cur) + String(val); break;
        case 'clear': next = ''; break;
        default: next = val;
      }
    }
    s.vars[key] = next;
    done.push(key + '=' + String(next));
  });
  return done;
}
function applyFlowInputs(node, s) {
  (node.inputs || []).forEach(m => {
    if (!m || !String(m.key || '').trim()) return;
    s.vars[String(m.key).trim()] = assignmentValue(m.value, s);
  });
}
function applyFlowOutputs(frame, s, reason) {
  (frame.outputs || []).forEach(m => {
    if (!m || !String(m.key || '').trim()) return;
    const from = String(m.from || '').trim();
    const v = from === '$end_reason' ? reason
      : (Object.prototype.hasOwnProperty.call(s.vars, from) ? s.vars[from] : s.slots[from]);
    s.vars[String(m.key).trim()] = v == null ? '' : v;
  });
}
/* 子流程到达 end：不播报结束语（Voiceflow 语义是「返回调用方继续」），出栈、
   写回输出变量、跳到调用节点的 to。返回 null 表示主流程 end 走原有收尾逻辑。 */
function returnFromFlow(root, s, node, parsed, depth, engine, stepFn) {
  const st = s.__flowStack || [];
  if (!st.length) return null;
  const frame = st.pop();
  const reason = node.end_reason || 'flow_end';
  applyFlowOutputs(frame, s, reason);
  s.trace.push({ turn: s.turn, engine, action: 'flow_return',
    detail: frame.script_id + ' · ' + reason + ' → ' + (frame.return_node || '（无返回去向）') });
  if (!frame.return_node) { s.status = 'done'; s.end_reason = reason; return { text: '', done: true }; }
  s.slots.__node = frame.return_node; s.slots.__spoken = null;
  return stepFn(root, s, parsed, depth + 1);
}

/* ────────────────────────── 阶段一：规则引擎 ────────────────────────── */
/* 节点：{ id, name, type:'say'|'end'|'intent', text, branches:[{on, keywords?, to}] }
   intent 节点（第一代意图路由）：candidates[{intent, keywords[], to}]，纯词表精确匹配
   ——命中即路由、无置信度无阈值；词表外一律走 fallback，行为完全可枚举可审计。
   这是与第二代（LLM 语义打分+阈值）的本质差异：同结构、不同判断机制。
   say 分支匹配顺序：自定义关键词 → 内置意图 → unrecognized 兜底。未识别连续 2 次 → 礼貌挂机。 */

function matchBranch(node, parsed) {
  const bs = node.branches || [];
  for (const b of bs) {
    if (Array.isArray(b.keywords) && b.keywords.length && parsed.text) {
      const hit = b.keywords.find(k => parsed.text.indexOf(k) !== -1);
      if (hit) return { branch: b, how: '关键词「' + hit + '」' };
    }
  }
  for (const b of bs) {
    if (b.on && b.on === parsed.intent) return { branch: b, how: '内置意图 ' + b.on };
  }
  const fb = bs.find(b => b.on === 'unrecognized');
  return { branch: fb || null, how: '未命中任何分支' };
}

/* 第一代意图路由：词表精确匹配（substring 命中制）。返回 {intent, matched} 或 null */
function ruleIntentMatch(node, parsed) {
  for (const c of (node.candidates || [])) {
    for (const kw of (c.keywords || [])) {
      if (parsed.text && parsed.text.indexOf(kw) !== -1) return { intent: c.intent, matched: kw, cand: c };
    }
  }
  return null;
}

function ruleStep(root, s, parsed, depth) {
  // script = 当前活动脚本（可能是子流程）；root 恒为主脚本，递归只传 root，
  // 每次入口按调用栈重新解析活动脚本，保证出栈后能回到主流程。
  const script = activeScript(root, s);
  depth = depth || 0;
  if (depth > 8) { s.status = 'done'; s.end_reason = 'flow_loop'; return { text: '（流程在节点间循环，已结束）', done: true }; }
  const nodes = script.nodes || [];
  const node = findNode(script, s.slots.__node) || nodes[0];
  if (!node) { s.status = 'done'; s.end_reason = 'flow_error'; return { text: '（流程配置错误：找不到节点）', done: true }; }
  /* 并行分支：静默 fan-out（Dify Parallel），到达即执行全部静默分支并在汇聚点继续。 */
  if (node.type === 'parallel') return runParallelNode(root, s, node, parsed, depth, ruleStep);
  /* 变量赋值：静默节点（Voiceflow Set），到达即执行、不播报、不占一轮，随即按 to 推进。 */
  if (node.type === 'assign') {
    const done = runAssignments(node, s);
    s.trace.push({ turn: s.turn, engine: 'rule', action: 'assign', detail: done.join('；') || '（未配置赋值）' });
    if (node.to && findNode(script, node.to)) {
      s.slots.__node = node.to; s.slots.__spoken = null;
      return ruleStep(root, s, parsed, depth + 1);
    }
    s.status = 'done'; s.end_reason = 'assign_no_next';
    return { text: '', done: true };
  }
  /* 子流程调用：静默节点（Voiceflow Workflow step / Botpress Flow Stack）。
     压栈 → 入参映射 → 跳到子流程首节点；子流程 end 时 returnFromFlow 出栈并回到 to。 */
  if (node.type === 'flow') {
    const child = resolveScript(node.script_id);
    if (!child || !(child.nodes || []).length) {
      s.status = 'done'; s.end_reason = 'flow_target_missing';
      return { text: '（子流程不存在或为空：' + (node.script_id || '未选择') + '）', done: true };
    }
    const st = s.__flowStack || (s.__flowStack = []);
    const maxD = node.maxFlowDepth != null ? node.maxFlowDepth : 3;
    if (st.length >= maxD || st.some(f => f.script_id === node.script_id)) {
      s.status = 'done'; s.end_reason = 'flow_recursion';
      return { text: '（子流程循环调用或超过调用深度上限，已终止）', done: true };
    }
    (child.variables || []).forEach(v => {
      if (!v || !String(v.name || '').trim()) return;
      const k = String(v.name).trim();
      if (!Object.prototype.hasOwnProperty.call(s.vars, k)) s.vars[k] = coerceVar(v.default, v.type);
    });
    applyFlowInputs(node, s);
    st.push({ script_id: node.script_id, return_node: node.to, outputs: node.outputs || [] });
    s.slots.__node = child.nodes[0].id; s.slots.__spoken = null;
    s.trace.push({ turn: s.turn, engine: 'rule', action: 'flow_call',
      detail: node.script_id + ' · 栈深 ' + st.length + ' · 入参 ' + (node.inputs || []).length });
    return ruleStep(root, s, parsed, depth + 1);
  }
  if (node.type === 'condition') {
    const r = routeCondition(node, s);
    s.trace.push({ turn: s.turn, engine: 'rule', action: 'condition', detail: node.id + (node.name ? '（' + node.name + '）' : '') + ' · ' + r.how });
    if (!r.to) { s.status = 'done'; s.end_reason = 'no_branch'; return { text: '那不打扰您了，再见。', done: true }; }
    const nx = findNode(script, r.to);
    if (!nx) { s.status = 'done'; s.end_reason = 'flow_error'; return { text: '（条件分支指向不存在节点 ' + r.to + '）', done: true }; }
    s.slots.__node = nx.id; s.slots.__spoken = null;
    return ruleStep(root, s, parsed, depth + 1);
  }

  /* 意图路由节点是静默路由器：到达不说话、不计数，直接进入本轮意图判断 */
  if (node.type === 'intent') {
    const hit = ruleIntentMatch(node, parsed);
    const names = (node.candidates || []).map(c => c.intent).join('/');
    if (hit) {
      s.slots[node.slot_into || 'intent'] = hit.intent;
      s.slots.__imiss = 0; s.slots.__spoken_fb = false;
      s.trace.push({ turn: s.turn, engine: 'rule', action: 'intent_hit', detail: '词表命中「' + hit.matched + '」→ ' + hit.intent + '（候选：' + names + '）· 规则引擎无置信度，命中即路由' });
      const next = findNode(script, hit.cand.to);
      if (!next) { s.status = 'done'; s.end_reason = 'flow_error'; return { text: '（意图候选指向不存在节点 ' + hit.cand.to + '）', done: true }; }
      s.slots.__node = next.id; s.slots.__spoken = null;
      return ruleStep(root, s, parsed, depth + 1);
    }
    s.__lastUnrecognized = true;
    const fb = node.fallback || {};
    s.slots.__imiss = (s.slots.__imiss || 0) + 1;
    s.trace.push({ turn: s.turn, engine: 'rule', action: 'intent_fallback', detail: '词表未命中（候选：' + names + '，第 ' + s.slots.__imiss + ' 次）· 词表外长尾无法泛化（第一代天花板）' });
    // 首次未命中：就地澄清一次（不递归，停在意图节点等下一轮用户输入再判断）
    if (fb.text && s.slots.__imiss === 1) {
      s.slots.__spoken_fb = true;
      const text = renderText(fb.text, s);
      pushBot(s, text, 'gen_fallback', node.id);
      return { text };
    }
    // 连续 2 次未命中 → 礼貌收尾；配置了兜底去向（非自身）则路由过去
    if (fb.to && fb.to !== node.id && findNode(script, fb.to)) {
      s.slots.__imiss = 0; s.slots.__spoken_fb = false;
      s.slots.__node = fb.to; s.slots.__spoken = null;
      return ruleStep(root, s, parsed, depth + 1);
    }
    s.status = 'done'; s.end_reason = s.slots.__imiss >= 2 ? 'unrecognized_x2' : 'fallback_end';
    return { text: '好的，那不打扰您了，感谢接听，再见。', done: true };
  }

  /* 到达节点：先说话术（end 节点直接收尾）。
     同节点跨轮循环保护：真正「说出口」才计数，说满 3 次仍未推进 → 判定打转熔断。
     （计数必须在到达分支内——一次 step 的路由递归会多次路过同一节点，入口计数会误伤。） */
  if (s.slots.__spoken !== node.id) {
    s.slots.__sayCount = s.slots.__sayCount || {};
    // 护栏键带脚本 id：主流程与子流程可能用了同名节点 id，混用会误判为打转。
    const guardKey = script.id + ':' + node.id;
    s.slots.__sayCount[guardKey] = (s.slots.__sayCount[guardKey] || 0) + 1;
    if (s.slots.__sayCount[guardKey] > 3) {
      s.status = 'done'; s.end_reason = 'flow_loop';
      return { text: '不好意思，通话好像没有进展，不打扰您了，再见。', done: true };
    }
    s.slots.__spoken = node.id;
    if (node.type === 'end') {
      // 子流程的 end 不播报结束语，出栈返回调用节点的 to（Voiceflow Workflow step 语义）。
      const ret = returnFromFlow(root, s, node, parsed, depth, 'rule', ruleStep);
      if (ret) return ret;
      s.status = 'done'; s.end_reason = node.end_reason || 'flow_end';
      const text = renderText(node.text || '感谢您的接听，再见。', s);
      pushBot(s, text, 'say_end', node.id);
      return { text, done: true };
    }
    // 工具节点在第一代同样要真正执行：旧实现把 tool/slot 都退化成 say，
    // 画布能画、校验器放行，运行时却只播报一句空话术，违背「两代只差意图识别」的定位。
    if (node.type === 'tool') {
      const risk = TOOL_RISKS[node.tool] || { risk: 'read_only', label: '只读', requires_confirmation: false };
      if (risk.requires_confirmation && !s.slots.confirmed) {
        const ask = renderText('跟您确认下：为您' + (node.confirm_text || '办理本项服务') + '，可以吗？', s);
        pushBot(s, ask, 'tool_confirm_ask', node.id);
        return { text: ask };
      }
      s.trace.push({ turn: s.turn, engine: 'rule', action: 'tool_call', detail: node.tool + '（' + risk.label + '）' });
      if (node.tool === 'transfer_human') { s.status = 'handoff'; s.end_reason = 'tool_transfer'; return { text: '为您转接人工坐席，请稍候。', done: true, handoff: true }; }
      if (node.tool === 'register_callback') {
        s.slots.callback_registered = true;
        const t2 = '好的，已为您登记回访，晚点再联系您，再见。';
        pushBot(s, t2, 'tool_done', node.tool);
        s.status = 'done'; s.end_reason = 'callback';
        return { text: t2, done: true };
      }
      if (node.tool === 'query_bill') s.slots.bill_queried = true;
      const ack = renderText(node.ack || '好的。', s);
      pushBot(s, ack, 'tool_done', node.tool);
      if (node.to && findNode(script, node.to)) { s.slots.__node = node.to; s.slots.__spoken = null; return ruleStep(root, s, parsed, depth + 1); }
      s.status = 'done'; s.end_reason = 'tool_done';
      return { text: ack };
    }
    // 槽位节点在第一代同样先提问，下一轮由「已说过」分支抽取并写回变量。
    // 旧版把 slot 退化成 say，画布能画、校验器放行，运行时变量却永远抽不到。
    if (node.type === 'slot') {
      const text = renderText(node.text || '请问您想分多少元或分几期？', s);
      pushBot(s, text, 'slot_ask', node.id + ' · 待抽取 ' + node.slot);
      return { text };
    }
    const text = renderText(node.text || '', s);
    const cc = complianceCheck(text, { isOpening: node.id === (nodes[0] && nodes[0].id) });
    if (!cc.ok) {
      s.trace.push({ turn: s.turn, engine: 'rule', action: 'compliance_block', detail: cc.problems.map(p => p.code + ':' + (p.word || '')).join(',') });
      if (cc.problems.some(p => p.code === 'banned_word')) {
        s.status = 'handoff'; s.end_reason = 'compliance';
        return { text: '（合规拦截，转人工坐席）', done: true, handoff: true };
      }
    }
    pushBot(s, text, 'say', node.id);
    // 权益已讲标记：三引擎统一的目标达成判定依赖 offer_presented +
    // 正向 intent 槽位（或 confirmed 确认闸）共同成立——单靠「知道了」不算达成。
    if (node.name && /权益|活动|分期|offer/i.test(node.name + ' ' + (node.text || ''))) s.slots.offer_presented = true;
    // 与 llmStep 对齐：节点带 to 时同轮推进；目标为意图静默路由器时只推进指针、等下一轮输入。
    // 旧版 ruleStep 完全不读 node.to，但画布能画 to 边、校验器也认可，属于「能画不能跑」。
    if (node.to && findNode(script, node.to)) {
      const target = findNode(script, node.to);
      s.slots.__node = node.to; s.slots.__spoken = null;
      if (target.type === 'intent') return { text };
      return ruleStep(root, s, parsed, depth + 1);
    }
    return { text }; // 等用户回复后再匹配分支
  }

  /* 已说过本节点 → 按节点类型处理本轮用户输入，再对 say/gen 做分支匹配。
     工具确认闸门与槽位抽取两代的语义必须一致：用户此前定的定位是「两代只差意图识别」。 */
  // 不可逆工具的确认闸门：上一轮已问「可以吗？」，本轮按用户答复决定执行或放弃。
  if (node.type === 'tool') {
    const risk = TOOL_RISKS[node.tool] || { requires_confirmation: false };
    if (risk.requires_confirmation && !s.slots.confirmed) {
      if (parsed.intent === 'affirm' || parsed.intent === 'consent_record') {
        s.slots.confirmed = true;
        s.slots.__spoken = null;
        return ruleStep(root, s, parsed, depth + 1);
      }
      s.status = 'done'; s.end_reason = 'tool_declined';
      return { text: '好的，那先不办理，不打扰您了，再见。', done: true };
    }
  }
  // 槽位抽取：正则命中 → 写回 slots → ack → to；未捕获重试一次，耗尽后必须收尾（否则无限重问）。
  if (node.type === 'slot') {
    const v = extractSlot(parsed.text, node.patterns);
    const missKey = '__slotMiss_' + node.id;
    s.slots[missKey] = (s.slots[missKey] || 0) + 1;
    s.trace.push({ turn: s.turn, engine: 'rule', action: 'slot', detail: node.slot + ' = ' + (v || '（未捕获，第 ' + s.slots[missKey] + ' 次）') });
    if (v || s.slots[missKey] >= 2) {
      if (v) s.slots[node.slot] = v;
      const ack = renderText(v ? (node.ack || '好的，已记下。') : '没关系，具体金额您到APP里看，我先帮您备注。', s);
      pushBot(s, ack, 'slot_hit', node.id);
      s.slots[missKey] = 0;
      if (node.to && findNode(script, node.to)) { s.slots.__node = node.to; s.slots.__spoken = null; return ruleStep(root, s, parsed, depth + 1); }
      s.status = 'done'; s.end_reason = v ? 'slot_done' : 'slot_exhausted';
      return { text: ack };
    }
    const retry = renderText(node.retry || '没太听清，您再说一遍？', s);
    pushBot(s, retry, 'slot_retry', node.id);
    return { text: retry };
  }
  const m = matchBranch(node, parsed);
  if (!m.branch || m.branch.on === 'unrecognized') s.__lastUnrecognized = true;
  s.trace.push({ turn: s.turn, engine: 'rule', action: 'match', detail: node.id + ' · ' + m.how + (m.branch ? ' → ' + m.branch.to : ' → 无兜底') });
  if (m.how.indexOf('未命中') !== -1) {
    s.slots.__miss = (s.slots.__miss || 0) + 1;
    if (s.slots.__miss >= 2) {
      s.status = 'done'; s.end_reason = 'unrecognized_x2';
      return { text: '好的，那不打扰您了，感谢接听，再见。', done: true };
    }
  } else s.slots.__miss = 0;

  if (!m.branch) {
    s.status = 'done'; s.end_reason = 'no_branch';
    return { text: '不好意思，我没听清，那不打扰您了，再见。', done: true };
  }
  const next = findNode(script, m.branch.to);
  if (!next) { s.status = 'done'; s.end_reason = 'flow_error'; return { text: '（流程配置错误：分支指向不存在的节点 ' + m.branch.to + '）', done: true }; }
  s.slots.__node = next.id; s.slots.__spoken = null;
  return ruleStep(root, s, parsed, depth + 1);
}

/* 变量赋值 / 子流程的通用校验：两代共用（用户定位：两代只差意图识别）。
   校验器必须拦住「画布能画、运行时却跑不出来」的配置，尤其是子流程自调用与无返回出口。 */
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function validateParallelAndHandlers(script, errors, warnings) {
  const nodes = script.nodes || [];
  const byId = {}; nodes.forEach(n => { if (n && n.id) byId[n.id] = n; });
  const chainBad = [];
  const walk = (start, seen) => {
    let cur = start, guard = 0;
    while (cur && guard++ < 32) {
      const n = byId[cur];
      if (!n) return;
      if (PARALLEL_SILENT_TYPES.indexOf(n.type) === -1) { chainBad.push(cur + '(' + n.type + ')'); return; }
      if (seen[n.id]) return;
      seen[n.id] = true;
      if (n.type === 'condition') return;   // 条件节点按运行时分流，静态不再下钻
      cur = n.to || null;
    }
  };
  (nodes.filter(n => n && n.type === 'parallel')).forEach(n => {
    const bs = (n.branches || []).filter(b => b && b.to);
    if (bs.length < 2) errors.push('并行节点 ' + n.id + ' 至少需要 2 条分支（Dify Parallel 最少 2 路）');
    if (bs.length > 8) errors.push('并行节点 ' + n.id + ' 超过 8 条分支');
    const ids = {};
    bs.forEach((b, i) => {
      const bid = String(b.id || b.name || ('b' + (i + 1)));
      if (ids[bid]) errors.push('并行节点 ' + n.id + ' 分支标识重复：' + bid);
      ids[bid] = true;
      if (!byId[b.to]) errors.push('并行节点 ' + n.id + ' 分支 ' + bid + ' 指向不存在节点 ' + b.to);
      else {
        const before = chainBad.length;
        walk(b.to, {});
        if (chainBad.length > before) errors.push('并行节点 ' + n.id + ' 分支 ' + bid + ' 含交互节点 ' + chainBad.slice(before).join('/') + '；分支只允许静默节点（assign/tool/condition）');
      }
      const nx = byId[b.to];
      if (nx && nx.type === 'parallel') errors.push('并行节点 ' + n.id + ' 分支 ' + bid + ' 指向另一个并行节点：禁止嵌套并行');
      if (nx && nx.type === 'flow') errors.push('并行节点 ' + n.id + ' 分支 ' + bid + ' 指向子流程：并行分支内不支持调用子流程');
    });
    const join = n.join || n.to;
    if (!join || !byId[join]) errors.push('并行节点 ' + n.id + ' 缺少有效汇聚节点（Dify：无汇聚点会静默丢弃其余分支产出）');
    (n.outputs || []).forEach(m => {
      if (!m || !String(m.key || '').trim()) errors.push('并行节点 ' + n.id + ' 出参映射缺少变量名');
      if (m && m.branch && !ids[String(m.branch)]) errors.push('并行节点 ' + n.id + ' 出参映射引用了不存在的分支 ' + m.branch);
    });
    if (['all', 'any'].indexOf(n.joinMode || 'all') === -1) warnings.push('并行节点 ' + n.id + ' 的汇聚模式只能是 all / any，已按 all 处理');
  });
  const hIds = {};
  (script.handlers || []).forEach((h, i) => {
    if (!h || !String(h.id || '').trim()) { errors.push('全局处理 #' + (i + 1) + ' 缺少 id'); return; }
    if (hIds[h.id]) errors.push('全局处理 id 重复：' + h.id);
    hIds[h.id] = true;
    if (HANDLER_EVENTS.indexOf(h.event) === -1) errors.push('全局处理 ' + h.id + ' 的事件类型无效：' + h.event);
    if (h.event === 'intent' && !(h.keywords || []).length && !(h.examples || []).length && !(h.match_intents || []).length)
      errors.push('全局处理 ' + h.id + ' 是打断意图，但没有配关键词/示例/内置意图，永远不会命中');
    if (h.to && !byId[h.to]) errors.push('全局处理 ' + h.id + ' 指向不存在节点 ' + h.to);
    if (h.afterCount != null && (!Number.isFinite(Number(h.afterCount)) || Number(h.afterCount) < 1))
      errors.push('全局处理 ' + h.id + ' 的 afterCount 必须是 >=1 的整数');
    if (!h.text && !h.to && !h.end) warnings.push('全局处理 ' + h.id + ' 没有话术/跳转/结束动作，命中后只会记录轨迹');
  });
}

function parallelChainIds(nodes) {
  const byId = {}; nodes.forEach(n => { if (n && n.id) byId[n.id] = n; });
  const set = new Set();
  (nodes.filter(n => n && n.type === 'parallel')).forEach(p => {
    (p.branches || []).forEach(b => {
      let cur = b && b.to, guard = 0;
      while (cur && guard++ < 32) {
        if (set.has(cur)) break;
        const n = byId[cur]; if (!n) break;
        set.add(cur);
        if (n.type === 'condition') break;
        cur = n.to;
      }
    });
  });
  return set;
}

function validateFlowNodes(script, errors, warnings) {
  const nodes = script.nodes || [];
  // 并行分支链上的节点：链末端是 fan-out 的终点，允许不配「执行后去」
  // （Dify 并行分支各自终止于汇聚点，不需要链内再指下一个节点）。
  const parallelChain = parallelChainIds(nodes);
  const seen = new Set();
  (script.variables || []).forEach(v => {
    if (!v || !String(v.name || '').trim()) { errors.push('变量声明缺少名称'); return; }
    const k = String(v.name).trim();
    if (!VAR_NAME_RE.test(k)) errors.push('变量名必须是字母/下划线开头的标识符：' + k);
    if (seen.has(k)) errors.push('变量重复声明：' + k);
    seen.add(k);
  });
  nodes.forEach(n => {
    if (n.type === 'assign') {
      const list = n.assignments || [];
      if (!list.length) errors.push('赋值节点没有配置任何赋值：' + n.id);
      list.forEach((a, i) => {
        const k = a ? String(a.key || '').trim() : '';
        if (!k) errors.push('赋值项 ' + (i + 1) + ' 缺少变量名：' + n.id);
        else if (!VAR_NAME_RE.test(k)) errors.push('赋值变量名不合法：' + k);
      });
      if (!n.to && !parallelChain.has(n.id)) errors.push('赋值节点缺少「执行后去」出口：' + n.id);
    }
    if (n.type === 'flow') {
      if (!n.script_id) errors.push('子流程节点没有选择目标流程：' + n.id);
      else {
        if (n.script_id === script.id) errors.push('子流程不能调用自身（必然循环）：' + n.id);
        const child = resolveScript(n.script_id);
        if (!child) warnings.push('目标流程当前不可解析（运行时会报 flow_target_missing）：' + n.script_id);
        else if (!(child.nodes || []).length) errors.push('目标流程没有任何节点：' + n.script_id);
        else if (child.stage && child.stage !== script.stage)
          warnings.push('跨代际调用（' + script.stage + ' → ' + child.stage + '）：子流程按调用方引擎执行，意图节点需同时配词表与示例：' + n.script_id);
      }
      if (!n.to && !parallelChain.has(n.id)) errors.push('子流程节点缺少「返回后去」出口：' + n.id);
      (n.inputs || []).forEach((m, i) => { if (!m || !String(m.key || '').trim()) errors.push('入参 ' + (i + 1) + ' 缺少变量名：' + n.id); });
      (n.outputs || []).forEach((m, i) => { if (!m || !String(m.key || '').trim()) errors.push('出参 ' + (i + 1) + ' 缺少变量名：' + n.id); });
    }
  });
}

function validateRuleScript(script, opts) {
  opts = opts || {};
  const errors = [], warnings = [];
  const nodes = script.nodes || [];
  if (!nodes.length) errors.push('流程没有任何节点');
  const start = nodes[0];
  const okOpening = opts.allowGenOpening ? ['say', 'gen'].indexOf(start && start.type) !== -1 : start && start.type === 'say';
  if (start && !okOpening) errors.push('首节点必须是话术节点（开场白' + (opts.allowGenOpening ? '或 LLM 生成节点' : '') + '）');
  if (start && start.text && start.text.indexOf(RECORDING_HINT) === -1) warnings.push('开场白缺少「' + RECORDING_HINT + '」提示，合规要求全程录音告知');
  const ids = new Set(nodes.map(n => n.id));
  const parChain = parallelChainIds(nodes);
  // 可达性 + 分支目标
  const seen = new Set();
  const queue = start ? [start.id] : [];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const n = nodes.find(x => x.id === id);
    (n && n.branches || []).forEach(b => {
      if (!b.to) return;
      if (ids.has(b.to)) queue.push(b.to);
      else errors.push('分支指向不存在的节点：' + id + ' → ' + b.to);
    });
    if (n && n.type === 'condition') {
      // 条件节点的表达式出口与 else 也是可达边
      (n.conditions || []).forEach(c => {
        if (!c.to) return;
        if (ids.has(c.to)) queue.push(c.to);
        else errors.push('条件分支指向不存在的节点：' + id + ' → ' + c.to);
      });
      if (n.elseTo) { if (ids.has(n.elseTo)) queue.push(n.elseTo); else errors.push('条件 else 指向不存在的节点：' + id + ' → ' + n.elseTo); }
    }
    if (n && n.type === 'intent') {
      // 意图节点的候选出口与兜底也是可达边（此前遗漏导致 intent 下游全部误报不可达）
      (n.candidates || []).forEach(c => {
        if (!c.to) return;
        if (ids.has(c.to)) queue.push(c.to);
        else errors.push('意图候选指向不存在的节点：' + id + ' → ' + c.to);
      });
      if ((n.fallback || {}).to) { if (ids.has(n.fallback.to)) queue.push(n.fallback.to); else errors.push('兜底指向不存在的节点：' + id + ' → ' + n.fallback.to); }
    }
    if (n && n.to) { if (ids.has(n.to)) queue.push(n.to); else errors.push('节点指向不存在的节点：' + id + ' → ' + n.to); }
    if (n && n.type === 'parallel' && n.join) {
      if (ids.has(n.join)) queue.push(n.join);
      else errors.push('并行汇聚指向不存在的节点：' + id + ' → ' + n.join);
    }
  }
  // 拓扑硬校验（画布专项审核：G1 拓扑「断头边/死循环/安全出口」）：
  // 不可达节点从 warning 升级为 error——不可达即客户永远不会走到的死代码，
  // 但若被引用的分支指向它会让该分支静默失败，不能当「提醒」放行。
  nodes.forEach(n => {
    if (seen.has(n.id)) return;
    const referenced = nodes.some(x => (x.branches || []).some(b => b.to === n.id)
      || (x.candidates || []).some(c => c.to === n.id)
      || x.to === n.id || (x.fallback || {}).to === n.id);
    if (referenced) errors.push('节点不可达（有分支指向它但从入口走不到）：' + n.id + (n.name ? '（' + n.name + '）' : ''));
    else warnings.push('孤立节点（无入口也无引用，疑似残留）：' + n.id + (n.name ? '（' + n.name + '）' : ''));
  });
  // 非 end 节点必须有出口（断头路：客户走到这里流程直接卡死）。
  // 例外一：并行分支内的节点由 parallel 节点调度、汇聚点统一收口。
  // 例外二：终局工具（transfer_human/register_callback）本身会结束会话，无 to 合法。
  const parIds = parChain;
  const TERMINAL_TOOLS = ['transfer_human', 'register_callback'];
  nodes.forEach(n => {
    if (n.type === 'end' || parIds.has(n.id)) return;
    const hasOut = (n.branches || []).some(b => b.to) || (n.candidates || []).some(c => c.to)
      || n.to || (n.fallback || {}).to || (n.conditions || []).some(c => c.to) || n.elseTo
      || (n.type === 'tool' && TERMINAL_TOOLS.indexOf(n.tool) !== -1);
    if (!hasOut) errors.push('节点无任何出口（断头路，客户会卡死在这里）：' + n.id + (n.name ? '（' + n.name + '）' : ''));
  });
  nodes.forEach(n => {
    // say/gen 无出口 = 死节点：运行时下一轮必触发 no_branch 提前挂断，属配置错误
    if ((n.type === 'say' || n.type === 'gen') && !(n.branches || []).length && !n.to && !parChain.has(n.id)) errors.push('节点没有出口分支（运行时会话将中断）：' + n.id);
    if (n.type === 'parallel' && !(n.branches || []).length && !n.join && !n.to) errors.push('并行节点没有配置任何分支：' + n.id);
    if (n.type === 'say' && !(n.text || '').trim()) errors.push('节点话术为空：' + n.id);
    if ((n.text || '').length > 300) warnings.push('节点话术超 300 字，外呼建议拆分：' + n.id);
    if (n.type !== 'parallel') (n.branches || []).forEach(b => { if (!b.on && !Array.isArray(b.keywords)) errors.push('分支缺少触发条件：' + n.id); });
    if (n.type === 'condition' && !(n.conditions || []).length && !n.elseTo) errors.push('条件节点没有配置任何条件或 else 出口：' + n.id);
    // 意图节点校验按代际区分判断依据：第一代靠词表、第二代靠示例语义
    if (n.type === 'intent' && script.stage !== 'llm') {
      if (!(n.candidates || []).length) errors.push('意图节点没有候选意图：' + n.id);
      (n.candidates || []).forEach(c => {
        if (!Array.isArray(c.keywords) || !c.keywords.length) errors.push('规则意图候选缺词表（规则引擎靠关键词命中）：' + n.id + ' → ' + (c.intent || '?'));
        if (!c.to && c.tool !== 'transfer_human') errors.push('意图候选缺出口：' + n.id + ' → ' + (c.intent || '?'));
      });
    }
  });
  if (!nodes.some(n => n.type === 'end')) warnings.push('流程没有结束（挂机）节点');
  validateFlowNodes(script, errors, warnings);
  validateParallelAndHandlers(script, errors, warnings);
  return { ok: errors.length === 0, errors, warnings };
}

/* ────────────────────────── 阶段二：LLM 增强 workflow ────────────────────────── */
/* 节点类型：
   intent —— LLM 意图识别：candidates[{intent, examples[], to, tool?}] + threshold + fallback；静默路由器
   gen    —— LLM 生成话术：prompt + 知识检索 + 变量（模拟），可带 branches/to
   slot   —— 槽位抽取：slot 名 + patterns；到达先问（text），命中后 ack 并路由
   tool   —— 工具调用（Agents-as-Tools）：query_bill / register_callback / transfer_human；执行后按 to 链式推进
   say/end 同阶段一。打分：示例话术 token 重叠 → 归一置信度。 */

function tokenize(t) { return String(t || '').toLowerCase().replace(/[，。,.?？!！\s]/g, '|').split('|').filter(Boolean); }

function llmIntentScore(utterText, examples) {
  const ut = tokenize(utterText);
  let best = 0, bestEx = '';
  (examples || []).forEach(ex => {
    const et = tokenize(ex);
    if (!et.length || !ut.length) return;
    let hit = 0;
    et.forEach(tok => { if (ut.some(u => u.indexOf(tok) !== -1 || tok.indexOf(u) !== -1)) hit++; });
    let score = hit / Math.max(et.length, ut.length);
    if (utterText && utterText.indexOf(ex) !== -1) score = Math.max(score, 0.9);
    if (score > best) { best = score; bestEx = ex; }
  });
  return { score: Math.min(1, best * 1.15), example: bestEx };
}

/* 知识条目规范化：无 ID/版本的自动补（WOWService §4.2 知识原子：可引用、可回滚、带有效期） */
function normalizeKnowledge(script) {
  const kb = script.knowledge || (script.policy && script.policy.knowledge) || [];
  kb.forEach((k, i) => {
    if (!k.id) k.id = (script.id || 'KB') + ':kb' + (i + 1);
    if (!k.version) k.version = script.version || 1;
  });
  return kb;
}

function knowledgeRetrieve(script, query, topN) {
  const kb = normalizeKnowledge(script);
  const q = tokenize(query);
  return kb.map(k => {
    const kt = tokenize(k.content + ' ' + (k.keywords || []).join(' '));
    const hit = q.filter(t => kt.some(x => x.indexOf(t) !== -1 || t.indexOf(x) !== -1)).length;
    return { k, score: q.length ? hit / q.length : 0 };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, topN || 2).map(x => x.k);
}

/* ── MKT-13 知识召回语义化（qwen text-embedding-v4 混合召回）──
   问题：关键词召回只取 1-2 条关键词原文，换一种说法就漏答（codex 二审）。
   方案：关键词召回为主干（零成本、确定性），语义召回为增强：
     ① embed 命中的候选 + 查询，算 cosine 相似度
     ② 语义分与关键词分加权融合（语义 0.6 / 关键词 0.4），同阈值过滤
     ③ embedding 服务不可用/超时/未配 key → 原样回落关键词模式（行为不变）
   缓存：文本 → 向量 Map（知识条目少、查询高频，命中率极高）。 */
const SEMANTIC_KB_CACHE = new Map();   // text → vector
const SEMANTIC_KB_MAX = 3000;
let semanticKbAvailable = null;        // null=未探测 true=可用 false=不可用（本次进程内记忆）

function kbSemanticText(k) {
  return (k.title || '') + '：' + String(k.content || '').slice(0, 120) + ' 触发词：' + (k.keywords || []).join(' ');
}

function kbCosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

function kbEmbedHttp(route, texts) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const payload = JSON.stringify({ model: route.model, input: texts });
    const req = https.request({
      hostname: route.host, port: 443, path: route.path, method: 'POST', timeout: 8000,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + route.getKey(), 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let body = '';
      res.on('data', c => { body += c; if (body.length > 2_000_000) req.destroy(new Error('embedding 响应过大')); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('embedding HTTP ' + res.statusCode));
        try {
          const d = JSON.parse(body);
          const rows = d.data || [];
          if (rows.length !== texts.length) return reject(new Error('embedding 数量不一致'));
          resolve(rows.map(item => item.embedding));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('embedding 超时')));
    req.write(payload); req.end();
  });
}

async function kbEmbedTexts(texts) {
  const route = (require('../../config/api-keys').API_ROUTES || {})['text-embedding-v4'];
  if (!route || !route.getKey()) throw new Error('未配置语义向量模型');
  const missing = [...new Set(texts.filter(Boolean))].filter(t => !SEMANTIC_KB_CACHE.has(t));
  for (let i = 0; i < missing.length; i += (route.batchSize || 10)) {
    const group = missing.slice(i, i + (route.batchSize || 10));
    const vectors = await kbEmbedHttp(route, group);
    group.forEach((t, idx) => SEMANTIC_KB_CACHE.set(t, vectors[idx]));
  }
  if (SEMANTIC_KB_CACHE.size > SEMANTIC_KB_MAX) SEMANTIC_KB_CACHE.clear();
  return texts.map(t => SEMANTIC_KB_CACHE.get(t) || null);
}

/* 混合召回入口（异步）。任何异常都回落关键词模式，永不阻塞对话主链路。 */
async function knowledgeRetrieveHybrid(script, query, topN) {
  const kwHits = knowledgeRetrieve(script, query, Math.max((topN || 2) * 3, 6));   // 先取宽候选
  let semanticAvailable = semanticKbAvailable !== false;
  if (semanticKbAvailable === null) {
    try {
      const route = (require('../../config/api-keys').API_ROUTES || {})['text-embedding-v4'];
      semanticKbAvailable = Boolean(route && route.getKey());
    } catch (_) { semanticKbAvailable = false; }
  }
  if (!semanticKbAvailable) return kwHits.slice(0, topN || 2);
  try {
    const kb = normalizeKnowledge(script);
    const kbTexts = kb.map(kbSemanticText);
    const vectors = await kbEmbedTexts([query, ...kbTexts]);
    const qv = vectors[0];
    if (!qv) throw new Error('查询向量缺失');
    const scoreOf = new Map();
    kb.forEach((k, i) => {
      const sim = kbCosine(qv, vectors[i + 1]);
      scoreOf.set(k.id, sim);
    });
    // 关键词命中候选 + 全库语义 top 候选一起融合排序
    const candidates = new Map();
    knowledgeRetrieve(script, query, Math.max((topN || 2) * 3, 6)).forEach(k => candidates.set(k.id, { k, kw: 1 }));
    kb.slice().sort((a, b) => (scoreOf.get(b.id) || 0) - (scoreOf.get(a.id) || 0)).slice(0, Math.max((topN || 2) * 3, 6)).forEach(k => {
      if (!candidates.has(k.id)) candidates.set(k.id, { k, kw: 0 });
    });
    const merged = [...candidates.values()].map(c => {
      const sim = scoreOf.get(c.k.id) || 0;
      // 融合分：语义 0.6 / 关键词 0.4；关键词命中但语义低的保留（关键词是业务硬约定）
      return { k: c.k, fused: sim * 0.6 + c.kw * 0.4 };
    }).filter(x => x.fused > 0.18 || (x.kw && true))
      .sort((a, b) => b.fused - a.fused)
      .slice(0, topN || 2).map(x => x.k);
    semanticKbAvailable = true;
    return merged;
  } catch (e) {
    // 回落：embedding 不可用时不影响对话（codex 二审 MKT-13 验收要求降级可用）
    semanticKbAvailable = false;
    return kwHits.slice(0, topN || 2);
  }
}

/* 知识引用链：evidence 字段格式（统一动作协议用） */
function evidenceOf(kbHits) {
  return (kbHits || []).map(k => ({ knowledge_id: k.id, title: k.title, version: k.version }));
}

/* 内置意图清单：分支 on 是这些值时走 parseUserInput 的正则匹配（零 LLM 成本） */
const BUILTIN_ON = ['affirm', 'deny', 'refuse', 'question', 'busy', 'silence', 'consent_record', 'unrecognized'];

/* gen-2 分支匹配（同步部分）：内置意图精确匹配 + keywords 语义打分。
   自定义条件分支（on 不是内置意图）返回 customOns 列表，由 stepSessionAsync 交给 LLM 判断。 */
function matchBranchScored(node, parsed) {
  const bs = node.branches || [];
  let best = null, bestScore = 0, how = '未命中', builtinHit = false;
  // 先一次性收齐自定义条件：主循环里遇到内置意图精确命中会 break，
  // 若边收集边 break，排在内置意图之后的自定义条件就会漏给 stepSessionAsync。
  const customOns = bs.filter(b => b.on && BUILTIN_ON.indexOf(b.on) === -1);
  for (const b of bs) {
    if (b.on && b.on === parsed.intent) { best = b; how = '意图 ' + b.on; builtinHit = true; break; }
    if (Array.isArray(b.keywords) && parsed.text) {
      // 用户配了关键词就做子串打分——自定义条件的分支也可以配关键词，命中即确定路由（不必等 LLM）
      const r = llmIntentScore(parsed.text, b.keywords);
      if (r.score > bestScore) { bestScore = r.score; best = b; how = '语义匹配「' + (r.example || '') + '」' + Math.round(r.score * 100) + '%'; }
    }
  }
  if (!best) best = bs.find(b => b.on === 'unrecognized') || null;   // 未识别兜底（重构时曾遗漏）
  return { branch: best, how, customOns, builtinHit };
}

/* gen-2 自定义分支条件的 LLM 判断：用户原话 vs 用户在画布写的条件描述。
   返回 { branch, how } 或 null（LLM 不可用/失败时由调用方回落 keywords/兜底）。 */
async function realBranchMatch(utterText, customOns) {
  if (!utterText || !utterText.trim() || !(customOns || []).length) return null;
  const list = customOns.map((b, i) => '- 条件' + (i + 1) + '：' + b.on).join('\n');
  const SYSTEM = '你是银行外呼电话的条件判断器。判断客户这句话符合哪个条件。只输出 JSON：{"match":序号或0,"score":0到1}。0=都不符合。不要输出其他内容。';
  const r = await realLlm.chat([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: '条件列表：\n' + list + '\n\n客户说：「' + utterText + '」' },
  ], { maxTokens: 400, temperature: 0 });
  if (!r.ok) return null;
  try {
    const m = r.text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : r.text);
    const idx = Number(j.match);
    if (!idx || idx < 1 || idx > customOns.length) return null;
    const score = Math.max(0, Math.min(1, Number(j.score) || 0));
    if (score < 0.5) return null;
    return { branch: customOns[idx - 1], how: '自定义条件「' + customOns[idx - 1].on + '」· LLM ' + Math.round(score * 100) + '%' };
  } catch (e) { return null; }
}

/* 中文数字 → 阿拉伯数字（外呼场景常见「两万」「一千二」等口语报数） */
function cnNumToArabic(cn) {
  const digit = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const unit = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  let total = 0, section = 0, num = 0, any = false;
  for (const ch of String(cn)) {
    if (digit[ch] != null) { num = digit[ch]; any = true; }
    else if (unit[ch]) {
      any = true;
      if (ch === '万') { section = (section + num) * 10000; total += section; section = 0; }
      else section += (num || 1) * unit[ch];
      num = 0;
    }
  }
  return any ? total + section + num : null;
}

/* ── 条件表达式安全求值（条件判断节点用）──
   支持会话变量、数字、单引号字符串；比较 > >= < <= == != ；逻辑 && || ! ；括号。
   不用 eval：手写递归下降，词法错误/未知变量返回 false（保守路由到 else）。 */
function condTokens(expr) {
  const tokens = [];
  let i = 0;
  const src = String(expr || '');
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9]/.test(ch)) {
      let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ t: 'num', v: parseFloat(src.slice(i, j)) }); i = j; continue;
    }
    if (ch === "'") {
      let j = i + 1; while (j < src.length && src[j] !== "'") j++;
      tokens.push({ t: 'str', v: src.slice(i + 1, j) }); i = j + 1; continue;
    }
    if (/[A-Za-z_\u4e00-\u9fa5]/.test(ch)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_.\u4e00-\u9fa5]/.test(src[j])) j++;
      const word = src.slice(i, j);
      // 布尔/空值字面量：通用工具里用户会直接写 `confirmed == true`、`!flag`，
      // 旧实现把 true/false 当变量名，未知变量检查直接判否，条件永远不可达。
      if (word === 'true' || word === 'false' || word === 'null') {
        tokens.push({ t: 'lit', v: word === 'null' ? null : (word === 'true') });
      } else {
        tokens.push({ t: 'var', v: word });
      }
      i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (['>=', '<=', '==', '!=', '&&', '||'].indexOf(two) !== -1) { tokens.push({ t: 'op', v: two }); i += 2; continue; }
    if ('><()!'.indexOf(ch) !== -1) { tokens.push({ t: 'op', v: ch }); i++; continue; }
    return null;  // 非法字符 → 整体失败
  }
  return tokens;
}

function condVarValue(name, session) {
  const vars = session.vars || {}, slots = session.slots || {};
  // 用 hasOwnProperty 而不是 ||：旧写法会把 0 / false 当成"缺失"再回落到 slots
  const hasV = Object.prototype.hasOwnProperty.call(vars, name);
  const hasS = Object.prototype.hasOwnProperty.call(slots, name);
  const raw = hasV ? vars[name] : (hasS ? slots[name] : null);
  if (raw == null || raw === '') return null;
  // 布尔值必须原样保留：旧实现统一 String(raw)，false 变成字符串 'false'，
  // 在 !flag / flag || other 里会被当成真值，导致护栏与分支判断反向。
  if (typeof raw === 'boolean') return raw;
  const n = Number(raw);
  return Number.isFinite(n) && String(raw).trim() !== '' && /^-?[0-9.]+$/.test(String(raw).trim()) ? n : String(raw);
}

function condEvalTokens(tokens, pos, session, stopAt) {
  // 结构：expr := andExpr (|| andExpr)*；andExpr := cmp (&& cmp)*；cmp := primary (op primary)?
  let p = pos;
  const readPrimary = () => {
    if (p >= tokens.length) return { val: undefined, p };
    const tk = tokens[p];
    if (tk.t === 'num' || tk.t === 'str' || tk.t === 'lit') { p++; return { val: tk.v, p }; }
    if (tk.t === 'var') { p++; return { val: condVarValue(tk.v, session), p }; }
    if (tk.v === '(') {
      p++;
      const r = condEvalTokens(tokens, p, session, ')');
      if (tokens[r.p] && tokens[r.p].v === ')') p = r.p + 1; else p = r.p;
      return { val: r.val, p };
    }
    if (tk.v === '!') { p++; const r = readPrimary(); return { val: !r.val, p }; }
    return { val: undefined, p };
  };
  const readCmp = () => {
    let left = readPrimary();
    if (p < tokens.length && tokens[p].t === 'op' && ['>', '>=', '<', '<=', '==', '!='].indexOf(tokens[p].v) !== -1) {
      const op = tokens[p].v; p++;
      const right = readPrimary();
      const a = left.val, b = right.val;
      const na = parseFloat(a), nb = parseFloat(b);
      const numeric = Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '';
      const x = numeric ? na : String(a == null ? '' : a);
      const y = numeric ? nb : String(b == null ? '' : b);
      let v = false;
      switch (op) {
        case '>': v = numeric ? x > y : String(x) > String(y); break;
        case '>=': v = numeric ? x >= y : String(x) >= String(y); break;
        case '<': v = numeric ? x < y : String(x) < String(y); break;
        case '<=': v = numeric ? x <= y : String(x) <= String(y); break;
        case '==': v = String(x) === String(y); break;
        case '!=': v = String(x) !== String(y); break;
      }
      left = { val: v, p };
    }
    return left;
  };
  const readAnd = () => {
    let l = readCmp();
    while (p < tokens.length && tokens[p].t === 'op' && tokens[p].v === '&&') {
      p++;
      const r = readCmp();
      l = { val: Boolean(l.val) && Boolean(r.val), p };
    }
    return l;
  };
  // 顶层：or 链
  let out = readAnd();
  while (p < tokens.length && tokens[p].t === 'op' && (tokens[p].v === '||' || tokens[p].v === stopAt)) {
    if (tokens[p].v === stopAt) break;
    p++;
    const r = readAnd();
    out = { val: Boolean(out.val) || Boolean(r.val), p };
  }
  return { ok: true, val: out.val, p };
}

function evalConditionExpr(expr, session) {
  try {
    const tokens = condTokens(expr);
    if (!tokens || !tokens.length) return false;
    // 未知变量保守判否：旧实现返回 null，导致 !unknownVar 与 unknownVar == '' 都误判为真，
    // 与「未知变量返回 false（保守路由到 else）」的约定相反。
    const vars = session.vars || {}, slots = session.slots || {};
    for (const tk of tokens) {
      if (tk.t === 'var' && !Object.prototype.hasOwnProperty.call(vars, tk.v)
        && !Object.prototype.hasOwnProperty.call(slots, tk.v)) return false;
    }
    const r = condEvalTokens(tokens, 0, session, null);
    if (r.p !== tokens.length) return false;   // 尾部多余 token 不再静默忽略
    return Boolean(r.val);
  } catch (e) { return false; }
}

/* 条件节点路由：按序求值 conditions，首个真走其 to；否则 elseTo。静默路由，不说话。 */
function routeCondition(node, session) {
  const conds = node.conditions || [];
  for (const c of conds) {
    if (!c.expr || !c.to) continue;
    const hit = evalConditionExpr(c.expr, session);
    if (hit) return { to: c.to, how: '条件「' + c.expr + '」成立' };
  }
  if (node.elseTo) return { to: node.elseTo, how: '所有条件不成立 → else' };
  return { to: null, how: '所有条件不成立且无 else 出口' };
}

function extractSlot(text, patterns) {
  if (Array.isArray(patterns)) {
    for (const p of patterns) {
      try { const m = String(text || '').match(new RegExp(p)); if (m) return m[1] || m[0]; } catch (e) { /* 忽略坏正则 */ }
    }
  }
  const t = String(text || '');
  // 中文数字兜底（正则抓不到「两万」这类口语报数）：抓连续中文数字片段并转换
  const cn = t.match(/[零一二两三四五六七八九十百千万]+/);
  if (cn) { const v = cnNumToArabic(cn[0]); if (v) return String(v); }
  const num = t.match(/\d+(\.\d+)?/);
  return num ? num[0] : null;
}

function llmStep(root, s, parsed, depth) {
  const script = activeScript(root, s);   // 与 ruleStep 同：当前活动脚本可能是被调用的子流程
  depth = depth || 0;
  if (depth > 8) { s.status = 'done'; s.end_reason = 'flow_loop'; return { text: '（流程在节点间循环，已结束）', done: true }; }
  const nodes = script.nodes || [];
  const node = findNode(script, s.slots.__node) || nodes[0];
  if (!node) { s.status = 'done'; s.end_reason = 'flow_error'; return { text: '（流程配置错误：找不到节点）', done: true }; }
  // 节点级循环计数（通用循环护栏）：同一节点在会话内进入超过 maxLoops（默认 3）次，
  // 视为循环不收敛 → 走该节点 unrecognized/兜底分支。用户可在节点属性里配 maxLoops 调整。
  // 键带脚本 id，避免主流程与子流程同名节点互相串计数。
  s.__nodeVisits = s.__nodeVisits || {};
  const guardKey = script.id + ':' + node.id;
  s.__nodeVisits[guardKey] = (s.__nodeVisits[guardKey] || 0) + 1;
  const maxLoops = node.maxLoops != null ? node.maxLoops : 3;
  const loopExceeded = s.__nodeVisits[guardKey] > maxLoops;

  /* 并行分支 / 变量赋值 / 子流程：两代语义完全一致（用户定位：两代只差意图识别） */
  if (node.type === 'parallel') return runParallelNode(root, s, node, parsed, depth, llmStep);
  if (node.type === 'assign') {
    const done = runAssignments(node, s);
    s.trace.push({ turn: s.turn, engine: 'llm', action: 'assign', detail: done.join('；') || '（未配置赋值）' });
    if (node.to && findNode(script, node.to)) {
      s.slots.__node = node.to; s.slots.__spoken = null;
      return llmStep(root, s, parsed, depth + 1);
    }
    s.status = 'done'; s.end_reason = 'assign_no_next';
    return { text: '', done: true };
  }
  if (node.type === 'flow') {
    const child = resolveScript(node.script_id);
    if (!child || !(child.nodes || []).length) {
      s.status = 'done'; s.end_reason = 'flow_target_missing';
      return { text: '（子流程不存在或为空：' + (node.script_id || '未选择') + '）', done: true };
    }
    const st = s.__flowStack || (s.__flowStack = []);
    const maxD = node.maxFlowDepth != null ? node.maxFlowDepth : 3;
    if (st.length >= maxD || st.some(f => f.script_id === node.script_id)) {
      s.status = 'done'; s.end_reason = 'flow_recursion';
      return { text: '（子流程循环调用或超过调用深度上限，已终止）', done: true };
    }
    (child.variables || []).forEach(v => {
      if (!v || !String(v.name || '').trim()) return;
      const k = String(v.name).trim();
      if (!Object.prototype.hasOwnProperty.call(s.vars, k)) s.vars[k] = coerceVar(v.default, v.type);
    });
    applyFlowInputs(node, s);
    st.push({ script_id: node.script_id, return_node: node.to, outputs: node.outputs || [] });
    s.slots.__node = child.nodes[0].id; s.slots.__spoken = null;
    s.trace.push({ turn: s.turn, engine: 'llm', action: 'flow_call',
      detail: node.script_id + ' · 栈深 ' + st.length + ' · 入参 ' + (node.inputs || []).length });
    return llmStep(root, s, parsed, depth + 1);
  }

  /* 条件判断节点：静默路由器（同 intent——不说话、不进 __spoken 状态机），到达即按变量表达式分流 */
  if (node.type === 'condition') {
    const r = routeCondition(node, s);
    s.trace.push({ turn: s.turn, engine: 'llm', action: 'condition', detail: node.id + (node.name ? '（' + node.name + '）' : '') + ' · ' + r.how });
    if (!r.to) { s.status = 'done'; s.end_reason = 'no_branch'; return { text: '那不打扰您了，再见。', done: true }; }
    const nx = findNode(script, r.to);
    if (!nx) { s.status = 'done'; s.end_reason = 'flow_error'; return { text: '（条件分支指向不存在节点 ' + r.to + '）', done: true }; }
    s.slots.__node = nx.id; s.slots.__spoken = null;
    return llmStep(root, s, parsed, depth + 1);
  }
  /* 静默路由器：意图识别节点（每个用户轮都跑）。
     s.__realIntent 存在 = 本轮已由真实 LLM 打分（stepSessionAsync 注入），用它覆盖模拟分；
     不存在 = 回落确定性模拟（无 key/超时/关闭时引擎行为不中断）。 */
  if (node.type === 'intent') {
    const realTop = s.__realIntent;
    const cands = (node.candidates || []).map(c => Object.assign(
      { r: (realTop && realTop.intent === c.intent) ? { score: realTop.score, example: realTop.example } : llmIntentScore(parsed.text, c.examples) }, c)
    ).sort((a, b) => b.r.score - a.r.score);
    const top = cands[0];
    const th = node.threshold != null ? node.threshold : 0.3;
    s.trace.push({ turn: s.turn, engine: 'llm', real: Boolean(realTop), action: 'intent', detail: cands.map(c => c.intent + ' ' + Math.round(c.r.score * 100) + '%').join(' / ') + ' · 阈值 ' + Math.round(th * 100) + '% · 输入「' + (parsed.text || '（静音）') + '」' + (realTop ? ' · 真实LLM' : ' · 模拟打分') });
    if (!top || top.r.score < th) {
      s.__lastUnrecognized = true;
      const fb = node.fallback || {};
      s.trace.push({ turn: s.turn, engine: 'llm', action: 'intent_fallback', detail: '低于阈值 → 兜底 ' + (fb.to || 'end') });
      if (fb.text && !s.slots.__spoken_fb) {
        s.slots.__spoken_fb = true;
        const fbText = renderText(fb.text, s);
        pushBot(s, fbText, 'gen_fallback', node.id);
        // 兜底澄清是本轮的回复；目标节点下一轮应正常播报自己的话术，
        // 旧实现把 __spoken 设成 fb.to，会让目标节点的 text 永远不播报。
        if (fb.to && findNode(script, fb.to)) { s.slots.__node = fb.to; s.slots.__spoken = null; }
        s.__last_turn_record = turnRecord(s, { message: fbText, intent: parsed.intent, evidence: [], next_state: 'WAIT_USER' });
        return { text: fbText };
      }
      s.slots.__spoken_fb = false;
      if (fb.to && findNode(script, fb.to)) { s.slots.__node = fb.to; s.slots.__spoken = null; return llmStep(root, s, parsed, depth + 1); }
      s.status = 'done'; s.end_reason = 'fallback_end';
      return { text: '那不打扰您了，再见。', done: true };
    }
    s.slots[node.slot_into || 'intent'] = top.intent;
    s.slots.__spoken_fb = false;   // 命中后复位，下次回到该意图节点仍能正常澄清
    s.trace.push({ turn: s.turn, engine: 'llm', action: 'intent_hit', detail: top.intent + '（' + Math.round(top.r.score * 100) + '%）' });
    if (top.tool === 'transfer_human') { s.status = 'handoff'; s.end_reason = 'intent_' + top.intent; return { text: '好的，为您转接人工坐席，请稍候。', done: true, handoff: true }; }
    const next = findNode(script, top.to);
    if (!next) { s.status = 'done'; s.end_reason = 'flow_error'; return { text: '（意图分支指向不存在节点 ' + top.to + '）', done: true }; }
    s.slots.__node = next.id; s.slots.__spoken = null;
    return llmStep(root, s, parsed, depth + 1);
  }

  /* 到达节点：先说话术 / 执行工具。
     循环保护与 ruleStep 同款：真正「说出口」才计数（路由递归会多次路过同一节点）。 */
  if (s.slots.__spoken !== node.id) {
    s.slots.__sayCount = s.slots.__sayCount || {};
    // 护栏键带脚本 id：主流程与子流程可能用了同名节点 id，混用会误判为打转。
    const guardKey = script.id + ':' + node.id;
    s.slots.__sayCount[guardKey] = (s.slots.__sayCount[guardKey] || 0) + 1;
    if (s.slots.__sayCount[guardKey] > 3) {
      s.status = 'done'; s.end_reason = 'flow_loop';
      return { text: '不好意思，通话好像没有进展，不打扰您了，再见。', done: true };
    }
    s.slots.__spoken = node.id;
    if (node.type === 'end') {
      // 子流程的 end 不播报结束语，出栈返回调用节点的 to。
      const ret = returnFromFlow(root, s, node, parsed, depth, 'llm', llmStep);
      if (ret) return ret;
      s.status = 'done'; s.end_reason = node.end_reason || 'flow_end';
      const text = renderText(node.text || '感谢接听，再见。', s);
      pushBot(s, text, 'say_end', node.id);
      return { text, done: true };
    }
    if (node.type === 'tool') {
      const risk = TOOL_RISKS[node.tool] || { risk: 'read_only', label: '只读', requires_confirmation: false };
      // 不可逆动作须确认：用户上一轮明确同意才执行（WOWService §9.5 动作分级）
      if (risk.requires_confirmation && !s.slots.confirmed) {
        s.trace.push({ turn: s.turn, engine: 'llm', action: 'tool_hold', detail: node.tool + ' 为' + risk.label + '动作，须先确认；本轮改为口头确认请求' });
        const ask = renderText('跟您确认下：为您' + (node.confirm_text || '办理本项服务') + '，可以吗？', s);
        pushBot(s, ask, 'tool_confirm_ask', node.id + ' · ' + risk.label);
        return { text: ask };
      }
      s.trace.push({ turn: s.turn, engine: 'llm', action: 'tool_call', detail: node.tool + '（' + risk.label + '） · idempotency=' + s.id + ':' + s.turn + ':' + node.tool + ' · openJiuwen AgentApp Tool' });
      if (node.tool === 'transfer_human') { s.status = 'handoff'; s.end_reason = 'tool_transfer'; return { text: '为您转接人工坐席，请稍候。', done: true, handoff: true }; }
      if (node.tool === 'register_callback') {
        s.slots.callback_registered = true;
        const t2 = '好的，已为您登记回访，晚点再联系您，再见。';
        pushBot(s, t2, 'tool_done', node.tool);
        s.status = 'done'; s.end_reason = 'callback';
        return { text: t2, done: true };
      }
      if (node.tool === 'query_bill') s.slots.bill_queried = true;
      const text = renderText(node.ack || '好的。', s);
      pushBot(s, text, 'tool_done', node.tool + '（' + risk.label + '）');
      if (node.to && findNode(script, node.to)) { s.slots.__node = node.to; s.slots.__spoken = null; return llmStep(root, s, parsed, depth + 1); }
      return { text };
    }
    if (node.type === 'slot') {
      const text = renderText(node.text || '请问您想分多少元或分几期？', s);
      pushBot(s, text, 'slot_ask', node.id + ' · 待抽取 ' + node.slot);
      return { text };
    }
    // say / gen：说话（gen 带知识检索 + 证据链；开场轮用户未开口时不检索，避免与话术重复）
    // s.__realText 存在 = 真实 LLM 生成的话术（stepSessionAsync 预生成），用它替换模拟拼接；
    // 真实路径同样过 knowledgeRetrieve 留证据链，合规检查（禁词/录音提示）完全一致。
    let text = renderText(node.text || '', s);
    let kbRefs = [];
    const realText = node.type === 'gen' ? s.__realText : null;
    if ((node.type === 'gen' || (node.type === 'say' && node.use_knowledge)) && parsed.text) {
      // 节点级知识引用：node.knowledge 列出条目标题时只在其中检索（知识即节点配置）
      let kbPool = normalizeKnowledge(script);
      if (Array.isArray(node.knowledge) && node.knowledge.length) {
        kbPool = kbPool.filter(k => node.knowledge.indexOf(k.title) !== -1);
      }
      // MKT-13：优先用 stepSessionAsync 预取的语义混合召回结果（同查询场景），
      // 预取不可用或节点限定知识池后无交集时回落同步关键词检索。
      const hybrid = s.__hybridKb;
      let kb = (hybrid && hybrid.length) ? hybrid.filter(k => kbPool.some(x => x.id === k.id)) : [];
      if (!kb.length) kb = knowledgeRetrieve({ knowledge: kbPool }, (node.prompt || '') + ' ' + (parsed.text || ''), 2);
      kbRefs = kb;
      s.trace.push({ turn: s.turn, engine: 'llm', real: Boolean(realText), action: 'retrieve', detail: kb.length ? '命中知识：' + kb.map(k => '「' + k.title + '」v' + k.version + '（' + k.id + '）').join('、') : '无命中知识' });
      if (realText) text = realText;
      else if (kb.length) text += ' ' + kb[0].content;
    } else if (realText) {
      text = realText;
    }
    let cc = complianceCheck(text, { isOpening: node.id === (nodes[0] && nodes[0].id) });
    // MKT-14 红线分级：hard 级（收益承诺/胁迫营销）不允许反思改写——改写等于掩盖
    // 监管违规，直接熔断；仅 soft 级可反思一次。
    if (!cc.ok && !cc.hasHard && cc.problems.some(p => p.code === 'banned_word')) {
      // 反思重写一次（WOWService §4.4 在线质检→反思→熔断）
      const fixed = reflectRewrite(text, cc.problems);
      s.trace.push({ turn: s.turn, engine: 'llm', action: 'reflect', detail: '合规命中 → 反思重写：' + cc.problems.map(p => p.word).join('、') + (fixed !== text ? ' · 已改写' : ' · 无法改写') });
      if (fixed !== text) { text = fixed; cc = complianceCheck(text, { isOpening: false }); }
    }
    if (!cc.ok) {
      s.trace.push({ turn: s.turn, engine: 'llm', action: 'compliance_block', detail: cc.problems.map(p => (p.rule_id || p.code) + (p.level === 'hard' ? '(hard)' : '')).join(',') });
      if (cc.problems.some(p => p.code === 'banned_word')) { s.status = 'handoff'; s.end_reason = 'compliance'; return { text: '（合规拦截，转人工）', done: true, handoff: true }; }
    }
    s.__last_turn_record = turnRecord(s, { message: text, intent: parsed.intent, evidence: evidenceOf(kbRefs), next_state: 'WAIT_USER' });
    pushBot(s, text, node.type === 'gen' ? 'gen' : 'say', node.id + (node.prompt ? ' · prompt: ' + String(node.prompt).slice(0, 30) : '') + (kbRefs.length ? ' · 依据 ' + kbRefs.map(k => k.id + '@v' + k.version).join(',') : ''));
    // 链式推进：节点带 to 时继续走（目标为静默路由器时只推进、等下一轮用户输入）
    if (node.to && findNode(script, node.to)) {
      const target = findNode(script, node.to);
      s.slots.__node = node.to; s.slots.__spoken = null;
      if (target.type === 'intent') return { text };
      return llmStep(root, s, parsed, depth + 1);
    }
    return { text };
  }

  /* 已说过本节点 → 按节点类型处理本轮用户输入 */
  // 不可逆工具的确认闸门：上一轮已问「可以吗？」，本轮按用户答复决定执行或放弃。
  // 旧实现只检查 s.slots.confirmed（仅 agent 路径会赋值），rule/llm 流程里永远执行不了。
  if (node.type === 'tool') {
    const risk = TOOL_RISKS[node.tool] || { requires_confirmation: false };
    if (risk.requires_confirmation && !s.slots.confirmed) {
      if (parsed.intent === 'affirm' || parsed.intent === 'consent_record') {
        s.slots.confirmed = true;
        s.slots.__spoken = null;
        return llmStep(root, s, parsed, depth + 1);
      }
      s.status = 'done'; s.end_reason = 'tool_declined';
      return { text: '好的，那先不办理，不打扰您了，再见。', done: true };
    }
  }
  if (node.type === 'slot') {
    let v = extractSlot(parsed.text, node.patterns);
    // use_llm=true 时正则未捕获可由 LLM 补充提取（异步入口注入 s.__realSlot；同步路径跳过）
    if (!v && node.use_llm && s.__realSlot && s.__realSlot.value) { v = s.__realSlot.value; }
    const missKey = '__slotMiss_' + node.id;   // 每个槽位独立重试计数，避免多槽位共用 __miss 串味
    s.slots[missKey] = (s.slots[missKey] || 0) + 1;
    s.trace.push({ turn: s.turn, engine: 'llm', action: 'slot', detail: node.slot + ' = ' + (v || '（未捕获，第 ' + s.slots[missKey] + ' 次）') + (v && node.use_llm && s.__realSlot ? '（LLM提取）' : '') });
    if (v || s.slots[missKey] >= 2) {
      if (v) s.slots[node.slot] = v;
      const ack = renderText(v ? (node.ack || '好的，已记下。') : '没关系，具体金额您到APP里看，我先帮您备注。', s);
      pushBot(s, ack, 'slot_hit', node.id);
      s.slots[missKey] = 0;
      if (node.to && findNode(script, node.to)) { s.slots.__node = node.to; s.slots.__spoken = null; return llmStep(root, s, parsed, depth + 1); }
      // 无去向时，抽取成功或重试耗尽都必须收尾：旧实现会停在 slot 节点无限重问
      s.status = 'done'; s.end_reason = v ? 'slot_done' : 'slot_exhausted';
      return { text: ack };
    }
    const retry = renderText(node.retry || '没太听清，您再说一遍？', s);
    pushBot(s, retry, 'slot_retry', node.id);
    return { text: retry };
  }

  // say / gen：分支路由（语义匹配 + 自定义条件的 LLM 判断）。
  // 循环超限时过滤回环分支（to === node.id 或指向上游），逼流程向前收敛。
  let m = matchBranchScored(node, parsed);
  // 真实 LLM 判出的自定义条件优先于 unrecognized 兜底，但显式 keywords 命中与内置意图
  // 精确命中的优先级更高。必须在循环护栏之前合并，否则 realBr 会整体覆盖护栏结果，
  // 把自环重新放回流程里（旧实现顺序反了）。
  const realBr = node.type === 'gen' || node.type === 'say' ? s.__realBranch : null;
  if (realBr && !m.builtinHit && !(m.how && m.how.indexOf('语义匹配') === 0)) {
    m = { branch: realBr.branch, how: realBr.how, customOns: m.customOns };
  }
  if (m.branch && m.branch.on === 'unrecognized') s.__lastUnrecognized = true;
  if (loopExceeded && m.branch && (m.branch.to === node.id || (s.__nodeVisits[m.branch.to] || 0) > (m.branch.maxLoops != null ? m.branch.maxLoops : maxLoops))) {
    // 循环超限：自环或指向同样超限的节点 → 落到未超限的兜底/结束分支；全超限则礼貌收尾
    const bsHere = node.branches || [];
    const alt = bsHere.find(b => b.on === 'unrecognized' && b.to !== node.id && !(s.__nodeVisits[b.to] > maxLoops))
      || bsHere.find(b => b.to && b.to !== node.id && !(s.__nodeVisits[b.to] > maxLoops));
    m = { branch: alt || null, how: '循环超限（' + node.id + ' 已进入 ' + s.__nodeVisits[node.id] + ' 次 > maxLoops ' + maxLoops + '），' + (alt ? '转出口 ' + alt.to : '全部出口已超限，礼貌收尾') };
  }
  s.trace.push({ turn: s.turn, engine: 'llm', real: Boolean(realBr), action: 'branch', detail: node.id + ' · ' + m.how + (m.branch ? ' → ' + m.branch.to : ' → 无兜底') });
  if (!m.branch) { s.status = 'done'; s.end_reason = 'no_branch'; return { text: '那不打扰您了，再见。', done: true }; }
  const next = findNode(script, m.branch.to);
  if (!next) { s.status = 'done'; s.end_reason = 'flow_error'; return { text: '（分支指向不存在节点 ' + m.branch.to + '）', done: true }; }
  s.slots.__node = next.id; s.slots.__spoken = null;
  return llmStep(root, s, parsed, depth + 1);
}

function validateLlmScript(script) {
  const base = validateRuleScript(script, { allowGenOpening: true });
  const errors = base.errors.slice(), warnings = base.warnings.slice();
  (script.nodes || []).forEach(n => {
    if (n.type === 'intent' && !(n.candidates || []).length) errors.push('意图节点没有候选意图：' + n.id);
    if (n.type === 'intent' && !(n.fallback || {}).to && !(n.fallback || {}).text) warnings.push('意图节点无兜底配置，低于阈值将直接结束：' + n.id);
    if (n.type === 'gen' && !(n.prompt || n.text)) errors.push('生成节点缺 Prompt：' + n.id);
    if (n.type === 'slot' && !n.slot) errors.push('槽位节点缺 slot 名：' + n.id);
    if (n.type === 'tool' && !n.tool) errors.push('工具节点缺 tool 名：' + n.id);
    if (n.type === 'tool' && n.tool && !TOOL_RISKS[n.tool]) warnings.push('工具 ' + n.tool + ' 不在风险分级表内（TOOL_RISKS），将按只读处理：' + n.id);
    if (n.type === 'slot' && Array.isArray(n.patterns)) {
      n.patterns.forEach(p => { try { new RegExp(p); } catch (e) { errors.push('槽位正则非法：' + n.id + ' → ' + p); } });
    }
  });
  // 意图候选 examples 为空 → 打分恒 0，等于死分支
  (script.nodes || []).forEach(n => {
    if (n.type === 'intent') (n.candidates || []).forEach(c => {
      if (!(Array.isArray(c.examples) && c.examples.length)) errors.push('意图候选缺示例（无法匹配）：' + n.id + ' → ' + (c.intent || '?'));
      if (!c.to && c.tool !== 'transfer_human') errors.push('意图候选缺出口：' + n.id + ' → ' + (c.intent || '?'));
    });
  });
  if (!(script.knowledge || []).length) warnings.push('未配置知识库，gen 节点只能复述模板话术');
  // base = validateRuleScript 已经跑过两个子校验器，这里不再重复，否则错误会成倍出现。
  return { ok: errors.length === 0, errors, warnings };
}

/* ────────────────────────── 阶段三：模型主导（WOWService 式） ────────────────────────── */
/* 无节点图。policy = { objective, required_slots[], knowledge[], guard[], style, max_turns }。
   每轮：感知（NLU+情绪）→ 决策 → 行动（生成话术：画像变量 + 知识检索 + 风格）；
   Agents-as-Tools：查账单/登记回访/转人工按需调用。
   决策双轨（2026-11-09 改造，对齐 Rasa CALM 命令生成器 + Parlant 匹配/生成分离）：
   - 真实 LLM 可用：agentLlm.genCommands 产出命令 JSON（act/say/set_slot/tool），
     s.__agentCmd 注入，agentAct 按命令执行（say 覆盖话术、set_slot 写槽位、tool 指定工具）。
   - LLM 不可用/失败：agentDecide 确定性打分选动作（行为与旧版一致，永不中断）。
   两轨共用同一执行层：合规护栏、禁词反思重写、工具风险分级、TurnRecord 协议全部不变。 */

const AGENT_ACTIONS = ['opening', 'present_offer', 'probe_intent', 'handle_objection', 'confirm_info', 'close_success', 'close_fail', 'transfer_human', 'hangup'];

/* 阶段3 单轮统一入口：命令注入（真实 LLM）优先，否则确定性打分（回落轨）。
   s.__agentCmd 由 stepSessionAgentAsync 预生成（已过 sanitizeCommands）；
   未注入时 agentDecide 打分 —— 两轨共用 agentAct 执行层。 */
function agentTurn(script, s, parsed) {
  // 确认态写入（与 rule/llm 工具节点的确认语义对称）：客户明确同意即确认。
  // confirm_info 只负责「发起确认」，真正 confirmed 由客户 affirm 这轮落账。
  // 门槛收紧（codex P1 虚假达成路径）：单字/超短应答（嗯、哦、啊、哦哦 ≤2 字）
  // 只是「听着呢」，不构成对办理的确认——确认必须是对 confirm_info 问句的
  // 实质答复。否则沉默型客户一个「嗯」就被引擎记为 confirmed 并 100% 达成。
  const isSubstantiveAffirm = parsed && (parsed.intent === 'affirm' || parsed.intent === 'consent_record')
    && parsed.text && parsed.text.replace(/[，。！？\s,.!?]/g, '').length > 2;
  if (isSubstantiveAffirm) {
    s.slots.confirmed = true;
  }
  // 投诉/转人工强制闸：policy.guard 写了「提及投诉/人工立即转接」，但不能依赖 LLM 自觉——
  // 引擎按关键词强制执行（与 rule/llm 引擎的 complain→transfer_human 语义对齐）。
  if (parsed && parsed.text && /投诉|银监|转人工|人工坐席/.test(parsed.text)) {
    s.trace.push({ turn: s.turn, engine: 'agent', real: true, action: 'complaint_gate', detail: '客户提及投诉/人工 → 引擎强制转人工（LLM 命令被覆盖）' });
    return agentAct(script, s, parsed, 'transfer_human');
  }
  // 轮次护栏：到达 max_turns 后模型不再有「继续聊」的选项——不是收尾就是转人工，
  // 防止 LLM 无限 probe_intent 拖长通话（业务边界「单次通话不超过 8 轮」由引擎强制执行）。
  const maxTurns = (script.policy || {}).max_turns || 8;
  if (s.turn >= maxTurns && s.__agentCmd && !['close_success', 'close_fail', 'transfer_human', 'hangup'].includes(s.__agentCmd.act)) {
    s.trace.push({ turn: s.turn, engine: 'agent', real: true, action: 'turn_limit', detail: '已达 max_turns=' + maxTurns + '，LLM 的 ' + s.__agentCmd.act + ' 被强制替换为 close_fail 收尾' });
    s.__agentCmd = { act: 'close_fail', say: null, set_slot: s.__agentCmd.set_slot };
  }
  if (s.__agentCmd) {
    const cmd = s.__agentCmd;
    s.__agentCmd = null;
    // 不可逆前置闸（第二道）：客户未确认时 close_success 降级为 confirm_info（发起确认）
    if (cmd.act === 'close_success' && !s.slots.confirmed) {
      s.trace.push({ turn: s.turn, engine: 'agent', real: true, action: 'confirm_gate', detail: '客户尚未确认，close_success 降级为 confirm_info（发起确认）' });
      cmd.act = 'confirm_info';
      if (cmd.tool === 'register_benefit') delete cmd.tool;
    }
    // 拒绝闸：客户本轮明确拒绝/否定时，一切促成类命令（close_success/register_benefit）都不可执行——
    // 「客户连续两次拒绝即礼貌收尾」「拒绝营销立即登记免打扰」是业务边界，不由模型自觉。
    if (parsed && (parsed.intent === 'refuse' || parsed.intent === 'deny') && (cmd.act === 'close_success' || cmd.tool === 'register_benefit')) {
      s.trace.push({ turn: s.turn, engine: 'agent', real: true, action: 'refuse_gate', detail: '客户明确拒绝，close_success/register_benefit 强制替换为 close_fail（含免打扰登记）' });
      cmd.act = 'close_fail';
      cmd.tool = 'register_dnd';
      if (cmd.say && /登记|开通|办理/.test(cmd.say)) delete cmd.say;  // 促成话术也不再适用
    }
    s.trace.push({ turn: s.turn, engine: 'agent', real: true, action: 'decide', detail: 'LLM 命令 act=' + cmd.act + (cmd.tool ? ' tool=' + cmd.tool : '') + (cmd.set_slot ? ' slots=' + Object.keys(cmd.set_slot).join(',') : '') });
    return agentAct(script, s, parsed, cmd.act, cmd);
  }
  const act = agentDecide(script, s, parsed);
  return agentAct(script, s, parsed, act.a);
}

function agentDecide(script, s, parsed) {
  const p = script.policy || {};
  const maxTurns = p.max_turns || 10;
  const scores = [];
  const negStreak = s.slots.__negStreak || 0;

  scores.push({ a: 'opening', v: !s.slots.opened ? 1 : 0, why: '开场白尚未说' });
  scores.push({ a: 'present_offer', v: s.slots.opened && !s.slots.offer_presented ? 0.9 : 0, why: '尚未介绍权益' });
  scores.push({ a: 'probe_intent', v: s.slots.offer_presented && !s.slots.intent ? 0.8 : 0, why: '权益已讲、意向未知' });
  scores.push({ a: 'handle_objection', v: parsed && (parsed.sentiment === 'neg' || parsed.intent === 'question') && s.slots.opened ? 0.85 : 0, why: '用户有异议/疑问，优先处理否则流失' });
  scores.push({ a: 'confirm_info', v: parsed && parsed.intent === 'affirm' && !s.slots.confirmed ? 0.9 : 0, why: '用户同意，核实关键信息' });
  scores.push({ a: 'close_success', v: (s.slots.intent === 'positive' && s.slots.confirmed) ? 1 : 0, why: '意向+确认齐备，促成' });
  scores.push({ a: 'close_fail', v: (negStreak >= 2 || (parsed && parsed.intent === 'refuse' && s.turn >= 2)) ? 0.95 : 0, why: '连续拒绝，礼貌收尾避免骚扰' });
  scores.push({ a: 'transfer_human', v: parsed && parsed.text && /投诉|银监|人工/.test(parsed.text) ? 1 : 0, why: '用户点名人工/投诉' });
  scores.push({ a: 'hangup', v: s.turn >= maxTurns ? 1 : 0, why: '到达轮次上限' });
  scores.sort((a, b) => b.v - a.v);
  const top = scores[0].v > 0 ? scores[0] : { a: 'probe_intent', v: 0.5, why: '默认推进：探询意向' };
  s.trace.push({ turn: s.turn, engine: 'agent', action: 'decide', detail: 'top3: ' + scores.slice(0, 3).map(x => x.a + ' ' + x.v.toFixed(2)).join(' > ') + ' ｜ 理由：' + top.why });
  return top;
}

function agentAct(script, s, parsed, action, cmd) {
  const p = script.policy || {};
  const style = p.style || 'professional';
  const kbAll = normalizeKnowledge(script);
  const kbHit = key => kbAll.find(x => x.title === key) || null;
  let text = '', usedKb = null, toolAction = null;
  // 命令层（真实 LLM 产出）：say 覆盖默认话术；set_slot 提前写回；tool 改派工具。
  // act 语义仍由 action 承担（决定结束态/状态位），保证两轨收尾一致。
  const c = cmd || null;
  if (c && c.set_slot) {
    // 受保护槽位：confirmed 只能由客户真实意图（affirm）落账，LLM set_slot 不可写——
    // 否则 LLM 可先 set_slot confirmed=true 再 close_success，完全绕过确认闸。
    const PROTECTED = { confirmed: 1 };
    const applied = {}, rejected = [];
    Object.keys(c.set_slot).forEach(k => {
      if (PROTECTED[k]) { rejected.push(k); return; }
      applied[k] = c.set_slot[k];
    });
    s.__agentCmdApplied = Object.assign({}, s.__agentCmdApplied, applied);
    Object.keys(applied).forEach(k => { s.slots[k] = applied[k]; });
    s.trace.push({ turn: s.turn, engine: 'agent', real: true, action: 'cmd_slot', detail: Object.keys(applied).map(k => k + '=' + applied[k]).join('；') + (rejected.length ? '（' + rejected.join(',') + ' 为受保护槽位，LLM 写入被拒）' : '') });
  }
  if (c && c.tool && !toolAction) {
    const risk = TOOL_RISKS[c.tool] || { risk: 'read_only', label: '只读', requires_confirmation: false };
    toolAction = { tool: c.tool, risk: risk.risk, requires_confirmation: risk.requires_confirmation };
  }

  switch (action) {
    case 'opening':
      text = renderText('您好，我是招商银行信用卡中心客服，本次通话将录音。看到您最近消费比平时少了些，特意来电关心一下，占用您一分钟方便吗？', s);
      s.slots.opened = true;
      break;
    case 'present_offer': {
      const know = kbHit('权益要点');
      usedKb = know;
      text = renderText('是这样，我们注意到您上个月消费 ${amt30} 元，这个月降了不少。这期给您配了消费返现权益' + (know ? '：' + know.content : '') + '，不用额外交钱。', s);
      // 命令轨（LLM set_slot）优先：命令已显式声明槽位时不再覆盖（两轨状态位一致）
      if (!(s.__agentCmdApplied && s.__agentCmdApplied.offer_presented)) s.slots.offer_presented = true;
      break;
    }
    case 'probe_intent':
      text = '您看这个权益用得上吗？用得上我现在就能帮您开通。';
      break;
    case 'handle_objection': {
      const isSales = parsed && parsed.text && /推销|骚扰|打/.test(parsed.text);
      const know = kbHit('异议应对');
      usedKb = know;
      text = (isSales ? '理解您接到的营销电话不少。' : '您的顾虑很正常。') + (know ? know.content : '这个权益是账户里自带的，开通不收费，不用可以随时关。') + '您最关心哪一点，我具体说？';
      s.slots.objection_handled = true;
      break;
    }
    case 'confirm_info':
      text = '好的，跟您确认下：为您开通本期的消费返现权益，次月账单生效，没有额外费用。确认吗？';
      // 语义修正（两轨统一）：confirm_info 是「发起确认」，确认态由客户下一轮 affirm 写入
      //（旧实现在此直接置 confirmed=true，导致不可逆工具的确认护栏被自己绕过）。
      break;
    case 'close_success':
      // 不可逆动作：开通权益，须确认后才可执行（WOWService §9.5 动作风险分级）
      toolAction = { tool: 'register_benefit', risk: TOOL_RISKS.register_benefit.risk, requires_confirmation: true };
      text = '好的，已经为您登记好了，稍后在APP里就能看到权益详情。感谢您的接听，祝您生活愉快，再见！';
      s.status = 'done'; s.end_reason = 'success';
      s.slots.intent = 'positive';
      break;
    case 'close_fail':
      toolAction = { tool: 'register_dnd', risk: TOOL_RISKS.register_dnd.risk, requires_confirmation: false };
      text = '好的，理解您暂时不需要，那不打扰您了。权益会保留到月底，有需要随时在APP里开通。感谢接听，再见。';
      s.status = 'done'; s.end_reason = 'polite_exit';
      break;
    case 'transfer_human':
      toolAction = { tool: 'transfer_human', risk: TOOL_RISKS.transfer_human.risk, requires_confirmation: false };
      text = '非常抱歉给您带来困扰，马上为您转接人工坐席，请稍候。';
      s.status = 'handoff'; s.end_reason = 'user_request';
      break;
    case 'hangup':
      text = '感谢您的接听，再见。';
      s.status = 'done'; s.end_reason = 'max_turns';
      break;
  }
  // 命令层 say 覆盖默认话术（LLM 生成；开场缺录音告知由下方合规层兜底提示）
  if (c && c.say) text = c.say;
  // 兜底：act=free 无预置模板（自由应答全靠 say），LLM 偷懒不写 say 时不能让客户听到空话
  if (!text) {
    text = '不好意思，我这边信号有点断续。简单说，本月刷卡有返现优惠，不额外收费，您有兴趣了解一下吗？';
    s.trace.push({ turn: s.turn, engine: 'agent', real: true, action: 'cmd_fallback', detail: 'act=' + action + ' 无有效话术 → 兜底承接语' });
  }
  if (c) s.trace.push({ turn: s.turn, engine: 'agent', real: true, action: 'cmd_act', detail: 'act=' + action + (c.say ? ' · 话术来自LLM' : ' · 话术为模板') + (c.tool ? ' · tool=' + c.tool : '') });
  let cc = complianceCheck(text, { isOpening: action === 'opening' });
  // MKT-14 红线分级：hard 级不允许反思改写，直接熔断（与 llm 引擎同口径）
  if (!cc.ok && !cc.hasHard && cc.problems.some(x => x.code === 'banned_word')) {
    // 反思重写一次（WOWService §4.4 在线质检→反思→熔断）
    const fixed = reflectRewrite(text, cc.problems);
    s.trace.push({ turn: s.turn, engine: 'agent', action: 'reflect', detail: '合规命中 → 反思重写' + (fixed !== text ? '成功' : '失败，转熔断') });
    if (fixed !== text) { text = fixed; cc = complianceCheck(text, { isOpening: false }); }
  }
  if (!cc.ok) s.trace.push({ turn: s.turn, engine: 'agent', action: 'compliance_block', detail: cc.problems.map(x => (x.rule_id || x.code) + (x.level === 'hard' ? '(hard)' : '')).join(',') });
  // 收尾保证闸：客户连续 2 次消极后，LLM 若仍不收尾（会话继续 WAIT_USER），
  // 引擎在播报其话术后强制结束会话并登记免打扰——「连续两次拒绝即礼貌收尾」由引擎兜底。
  if (!toolAction && s.status === 'active' && parsed && (s.slots.__negStreak || 0) >= 2) {
    s.trace.push({ turn: s.turn, engine: 'agent', real: true, action: 'close_guarantee', detail: '客户连续 ' + s.slots.__negStreak + ' 次消极且 LLM 未收尾 → 引擎强制结束并登记免打扰' });
    toolAction = { tool: 'register_dnd', risk: TOOL_RISKS.register_dnd.risk, requires_confirmation: false };
    s.status = 'done'; s.end_reason = 'polite_exit';
  }
  // 统一动作协议：回复 + 工具命令同源同 JSON（WOWService §4.1；真实 LLM 需独立 plan 一致性校验器）
  s.__last_turn_record = turnRecord(s, {
    message: text,
    intent: parsed ? parsed.intent : null,
    evidence: usedKb ? evidenceOf([usedKb]) : [],
    actions: toolAction ? [{
      action_id: s.id + ':a' + s.turn,
      tool: toolAction.tool,
      arguments: { xid: s.customer ? s.customer.xid : null, script_id: script.id },
      risk: toolAction.risk,
      idempotency_key: s.id + ':' + s.turn + ':' + toolAction.tool,
      requires_confirmation: toolAction.requires_confirmation,
      executed: !toolAction.requires_confirmation || !!s.slots.confirmed,
    }] : [],
    plan_consistent: true,
    next_state: s.status === 'active' ? 'WAIT_USER' : s.status.toUpperCase(),
  });
  pushBot(s, text, 'act_' + action, (style !== 'professional' ? '风格 ' + style : '') + (usedKb ? ' · 依据 ' + usedKb.id + '@v' + usedKb.version : '') + (toolAction ? ' · 动作 ' + toolAction.tool + '（' + (TOOL_RISKS[toolAction.tool] || {}).label + '）' : ''));
  return { text, done: s.status !== 'active' };
}

function validateAgentScript(script) {
  const errors = [], warnings = [];
  const p = script.policy || {};
  if (!p.objective) errors.push('缺少对话目标 objective');
  if (!(p.required_slots || []).length) warnings.push('未定义必收信息（required_slots），目标完成度将无法衡量');
  // 知识是模型主导方案的设计主体（用户确立的范式）：零知识时模型只能空转话术，
  // 校验不能给「通过」——此前零知识方案仍标绿「通过」，属于校验结果失真（codex 审核 P0）。
  if (!(p.knowledge || []).length) errors.push('模型主导方案未配置知识库：知识是本阶段的设计主体，零知识时模型只能空转话术，禁止上线（在「管理工作台 → 知识」添加条目）');
  if (!(p.guard || []).length) warnings.push('未配置边界（guard），仅剩全局合规红线兜底');
  if (!p.max_turns) warnings.push('未设置最大轮次，建议 6-10 轮');
  validateParallelAndHandlers(script, errors, warnings);
  return { ok: errors.length === 0, errors, warnings };
}

/* agent 模式 intent 节点语义命中后的续跑：目标节点若是 end/tool 直接处理，
   gen/say 节点交回 agentTurn 生成话术（模型主导模式的节点语义归模型）。 */
function llmIntentAgentContinue(script, s, parsed, next) {
  if (next.type === 'end') {
    s.status = 'done'; s.end_reason = next.end_reason || 'flow_end';
    return { text: renderText(next.text || '感谢您的接听，再见。', s), done: true };
  }
  if (next.type === 'tool') {
    if (next.tool === 'transfer_human') { s.status = 'handoff'; s.end_reason = 'user_request'; return { text: '好的，为您转接人工坐席，请稍候。', done: true, handoff: true }; }
  }
  return agentTurn(script, s, parsed);
}

/* ────────────────────────── 会话入口 ────────────────────────── */

/* 会话开始：说出开场白（rule/llm 到达首节点；agent 由模型自主决定开场） */
function openSession(script, s) {
  if (s.stage === 'agent') {
    const empty = { text: '', intent: 'other', sentiment: 'neutral' };
    return agentTurn(script, s, empty);
  }
  const start = (script.nodes || [])[0];
  if (!start) { s.status = 'done'; s.end_reason = 'flow_error'; return { text: '（流程配置错误：无节点）', done: true }; }
  s.slots.__node = start.id;
  s.slots.__spoken = null;
  if (s.stage === 'llm') return llmStep(script, s, { text: '', intent: 'other', sentiment: 'neutral' }, 0);
  return ruleStep(script, s, { text: '', intent: 'other', sentiment: 'neutral' }, 0);
}

function stepSession(script, session, input) {
  const s = session;
  if (s.status !== 'active') return { text: '（会话已结束：' + s.end_reason + '）', done: true };
  const parsed = parseUserInput(input && input.text, input && input.intent);
  s.turn++;
  s.__lastUnrecognized = false;
  pushUser(s, parsed);
  // 全局 handler · before：flow 级打断意图被每个节点继承，优先于局部节点处理。
  const ghBefore = runGlobalHandlers(script, s, parsed, 'before');
  if (ghBefore && (ghBefore.text || ghBefore.done)) {
    if (ghBefore.done) fireSessionEndHandlers(script, s);
    return Object.assign({ metrics: sessionMetrics(s, script), turn_record: s.turn_records[s.turn_records.length - 1] || null }, ghBefore);
  }
  if (parsed.intent === 'busy' || parsed.intent === 'refuse' || parsed.intent === 'deny') s.slots.__negStreak = (s.slots.__negStreak || 0) + 1;
  else s.slots.__negStreak = 0;
  if ((parsed.intent === 'affirm' || parsed.intent === 'consent_record') && s.slots.offer_presented) {
    s.slots.intent = s.slots.intent || 'positive';
  }
  let r;
  if (s.stage === 'agent') {
    // 阶段能力隔离（画布专项审核 P0-⑤）：agent 模式下 intent 节点不走词表路由——
    // 「意图理解（LLM）」节点在模型主导模式必须用语义判定（examples 语义相似度打分，
    // 与 llm 引擎同分但阈值默认 0.55）；词表命中即路由是阶段一专用语义。
    if ((s.slots.__node && (findNode(script, s.slots.__node) || {}).type === 'intent')) {
      const node = findNode(script, s.slots.__node);
      const cands = (node.candidates || []).map(c => Object.assign(
        { r: llmIntentScore(parsed.text, c.examples) }, c)).sort((a, b) => b.r.score - a.r.score);
      const th = node.threshold != null ? node.threshold : 0.55;
      const top = cands[0];
      s.trace.push({ turn: s.turn, engine: 'agent', action: 'intent_semantic', detail: cands.map(c => c.intent + ' ' + Math.round(c.r.score * 100) + '%').join(' / ') + ' · 语义阈值 ' + Math.round(th * 100) + '%（agent 模式不走词表）' });
      if (top && top.r.score >= th) {
        s.slots[node.slot_into || 'intent'] = top.intent;
        const next = findNode(script, top.to);
        if (next) { s.slots.__node = next.id; s.slots.__spoken = null; return llmIntentAgentContinue(script, s, parsed, next); }
      }
      // 低置信度：交回 agentTurn 自主处理（模型自己决定澄清或收尾）
      s.trace.push({ turn: s.turn, engine: 'agent', action: 'intent_lowconf', detail: '语义分低于阈值 → 交回模型自主决策' });
    }
    r = agentTurn(script, s, parsed);
  } else if (s.stage === 'llm') r = llmStep(script, s, parsed, 0);
  else r = ruleStep(script, s, parsed, 0);
  // 全局 handler · after：局部引擎未识别 / 静音 / 会话结束才评估，first-match 覆盖本轮回复。
  const ghAfter = runGlobalHandlers(script, s, parsed, 'after', r);
  if (ghAfter) r = ghAfter;
  if (r && r.done) s.status = s.status === 'active' ? 'done' : s.status;
  if (s.status !== 'active') fireSessionEndHandlers(script, s);
  return Object.assign({ metrics: sessionMetrics(s, script), turn_record: s.turn_records[s.turn_records.length - 1] || null }, r);
}

/* ── 异步步进：阶段三 agent 引擎的真实 LLM 命令生成入口 ──
   流程（CALM 命令生成器模式）：
     ① agentLlm.compileContext 装配上下文（角色合规 + 流程骨架 + 状态 + 检索知识 + 历史）
     ② agentLlm.genCommands 产出命令 JSON → sanitizeCommands 校验 → s.__agentCmd
     ③ 复用同步 stepSession 执行（护栏/工具/TurnRecord/全局 handler 全走原逻辑）
   LLM 任一步失败 → s.__agentCmd 不注入 → agentTurn 自然回落确定性打分（永不中断）。
   返回值与 stepSession 完全同构。 */
async function stepSessionAgentAsync(script, session, input) {
  const s = session;
  if (s.stage !== 'agent' || !agentLlm.llmAvailable()) return stepSession(script, session, input);
  s.__agentCmd = null;
  try {
    // MKT-13：异步上下文里用语义混合召回（embedding 不可用自动回落关键词模式）
    const kbHits = await knowledgeRetrieveHybrid(script, (input && input.text || '') + ' ' + (script.policy || {}).objective, 2);
    const ctxText = agentLlm.compileContext(script, s, input && input.text, kbHits);
    const cmd = await agentLlm.genCommands(ctxText, {});
    const safe = agentLlm.sanitizeCommands(cmd);
    if (safe) {
      s.__agentCmd = safe;
    } else {
      s.trace.push({ turn: s.turn + 1, engine: 'agent', real: false, action: 'llm_fallback', detail: 'LLM 命令无效或解析失败 → 回落确定性决策' });
    }
  } catch (e) { /* 不注入即回落，主流程不受影响 */ }
  const r = stepSession(script, session, input);
  s.__agentCmd = null;
  return r;
}

/* ── 异步步进：阶段二 llm 引擎的真实 LLM 增强入口 ──
   流程：① 若当前轮会到 intent 节点，先异步让 LLM 打分 → s.__realIntent
        ② 若下一说话节点是 gen，预生成话术 → s.__realText
        ③ 复用同步 llmStep 执行（trace/合规/熔断/证据链全走原逻辑）
   LLM 任一步失败即不注入 → 自然回落确定性模拟，行为与旧版一致。
   返回值与 stepSession 完全同构。 */
async function stepSessionAsync(script, session, input) {
  const s = session;
  if (s.stage === 'agent') return stepSessionAgentAsync(script, session, input);
  if (s.stage !== 'llm' || !realLlm.llmAvailable()) {
    // MKT-13：llm 引擎 LLM 不可用时仍是同步步进，但知识检索可先做语义增强
    // 的预取（失败静默回落）——但 llmStep 是同步函数，无法 await，
    // 这里把混合召回结果挂到 session 上，供 llmStep 内的 knowledgeRetrieve 优先使用。
    try { s.__hybridKb = await knowledgeRetrieveHybrid(script, (input && input.text || ''), 2); }
    catch (_) { s.__hybridKb = null; }
    return stepSession(script, session, input);
  }
  // 子流程内也要用当前活动脚本做预判，否则自定义分支/意图打分会拿主脚本的节点。
  const ctx = activeScript(script, s);
  s.__realIntent = null; s.__realText = null; s.__realBranch = null; s.__realGlobalHandler = null; s.__realSlot = null;
  try {
    const node = findNode(ctx, s.slots.__node) || (ctx.nodes || [])[0];
    // say/gen 节点的自定义分支条件 → 真实 LLM 判断（通用工具核心：任意条件都可用）
    if (node && (node.type === 'say' || node.type === 'gen') && input && input.text) {
      // 与 stepSession 用同一份 groundTruth 解析，避免预判断与实际步进依据不一致（D8）
      const m = matchBranchScored(node, parseUserInput(input.text, input.intent));
      // 只要存在自定义条件就交给 LLM 判断。旧实现要求 !m.branch，但 matchBranchScored
      // 在未命中时总会填入 unrecognized 兜底，导致带兜底的流程里自定义条件永远不可达。
      // 内置意图精确命中优先级最高，不再被 LLM 覆盖。
      if (m.customOns && m.customOns.length && !m.builtinHit) {
        const rb = await realBranchMatch(input.text, m.customOns);
        if (rb) s.__realBranch = rb;
      }
    }
    // 到达意图节点 → 真实意图打分（知识库中「意图判别参考」类条目注入 prompt 提升精度）
    // 预判目标：当前 __node 是 intent → 打分对象就是它；否则沿当前 say 节点的分支预测
    // 本轮将要到达的意图节点（say 说完即分支路由，t1 到达 intent 是常态）。
    const intentNode = (function () {
      if (node && node.type === 'intent') return node;
      if (node && (node.type === 'say' || node.type === 'gen') && input && input.text) {
        const m = matchBranchScored(node, parseUserInput(input.text, input.intent));
        if (m.branch && m.branch.to) {
          const nxt = findNode(ctx, m.branch.to);
          if (nxt && nxt.type === 'intent') return nxt;
        }
      }
      return null;
    })();
    if (intentNode && input && input.text) {
      const kbHints = normalizeKnowledge(script)
        .filter(k => /判别|听懂为|意图/.test(k.title + k.content))
        .map(k => k.content.split('；')).flat();
      const r = await realLlm.realIntentScore(input.text, (intentNode.candidates || []).map(c => ({ intent: c.intent, examples: c.examples })), kbHints);
      if (r) s.__realIntent = r;
    }
    // 下一节点是 use_llm 槽位 → LLM 抽取（正则兜底）
    const nextNode = (function () {
      let n = null;
      if (node && node.type === 'intent' && s.__realIntent) {
        const hit = (node.candidates || []).find(c => c.intent === s.__realIntent.intent);
        if (hit && findNode(ctx, hit.to)) n = findNode(ctx, hit.to);
      } else if (node && node.to && findNode(ctx, node.to)) n = findNode(ctx, node.to);
      return n;
    })();
    if (nextNode && nextNode.type === 'slot' && nextNode.use_llm && input && input.text) {
      s.__realSlot = null;
      const SYS = '你是银行外呼电话的信息提取器。从客户这句话里提取指定信息。客户可能说中文数字（如「六期」「三千块」），请转成阿拉伯数字输出。只输出 JSON：{"value":"提取到的值"}，提取不到输出 {"value":null}。不要输出其他内容。';
      const r = await realLlm.chat([
        { role: 'system', content: SYS },
        { role: 'user', content: '要提取的信息：' + (nextNode.slot || '') + '（参考正则：' + JSON.stringify(nextNode.patterns || []) + '）\n客户说：「' + input.text + '」' },
      ], { maxTokens: 60, temperature: 0 });
      if (r.ok) {
        try {
          const m = r.text.match(/\{[\s\S]*\}/);
          const j = JSON.parse(m ? m[0] : r.text);
          if (j && j.value) s.__realSlot = { value: String(j.value).slice(0, 30) };
        } catch (e) { /* 回落正则 */ }
      }
    }
    // 找下一个说话节点 → 预生成 gen 话术。
    // 规则：意图节点沿「真实命中候选」跳；已说过的节点（__spoken）不算，沿 to/分支继续；
    // 最多 3 跳防深链。slot 节点当轮必先问（不走 gen），跳过。
    const speakOf = (n, jumps) => {
      jumps = jumps || 0;
      if (!n || jumps > 3) return null;
      const spoken = s.slots.__spoken === n.id;
      if (n.type === 'gen' && !spoken) return n;
      if (n.type === 'slot' && !spoken) return null;             // slot 当轮先问
      if (n.type === 'intent') {
        if (s.__realIntent) {
          const hit = (n.candidates || []).find(c => c.intent === s.__realIntent.intent);
          if (hit && findNode(ctx, hit.to)) return speakOf(findNode(ctx, hit.to), jumps + 1);
        }
        return null;                                              // 无真实意图结果不猜
      }
      if (n.to && findNode(ctx, n.to)) return speakOf(findNode(ctx, n.to), jumps + 1);
      return null;
    };
    const speak = speakOf(node);
    if (speak && speak.type === 'gen') {
      // MKT-13：预取的混合召回结果优先（同查询），否则关键词检索
      const hybridPre = (s.__hybridKb || []).filter(k => normalizeKnowledge(ctx).some(x => x.id === k.id));
      const kb = hybridPre.length ? hybridPre : knowledgeRetrieve(ctx, (speak.prompt || '') + ' ' + (input && input.text || ''), 2);
      const t = await realLlm.realGenText({
        prompt: speak.prompt, retrieved: kb, slots: s.slots, name: (s.vars && s.vars.name) || (s.customer && s.customer.name) || '',
        userText: input && input.text, baseText: renderText(speak.text || '', s),
      });
      if (t) s.__realText = t;
    }
    // 全局打断意图同样走真实 LLM（两代只差意图识别）；失败自然回落词表匹配。
    const ghs = (ctx.handlers || []).filter(h => h && h.enabled !== false && h.event === 'intent' && (h.examples || []).length);
    if (ghs.length && input && input.text) {
      const g = await realGlobalHandlerMatch(input.text, ghs);
      if (g) s.__realGlobalHandler = g;
    }
  } catch (e) { /* LLM 增强失败不影响主流程（标记未置即回落） */ }
  const r = stepSession(script, session, input);
  s.__realIntent = null; s.__realText = null; s.__realBranch = null; s.__realGlobalHandler = null;
  return r;
}

/* 自动整通：persona 接管用户侧，跑完整通电话（确定性，可回放） */
function autoRun(script, session, maxTurns) {
  const s = session;
  const steps = [];
  let guard = 0;
  const first = openSession(script, s);
  steps.push({ role: 'bot', text: first.text });
  while (s.status === 'active' && guard < (maxTurns || 16)) {
    guard++;
    const u = personaUtterance(s.persona, s.turn, s.id + ':' + s.turn, s);
    const r = stepSession(script, s, { text: u.text, intent: u.intent });
    steps.push({ role: 'user', text: u.text, intent: u.intent });
    steps.push({ role: 'bot', text: r.text });
    if (r.done || r.handoff) break;
  }
  if (s.status === 'active') { s.status = 'done'; s.end_reason = 'auto_max'; }
  return { steps, metrics: sessionMetrics(s, script), trace: s.trace };
}

/* ────────────────────────── 校验入口 ────────────────────────── */

function validateScript(script) {
  if (script.stage === 'agent') return validateAgentScript(script);
  if (script.stage === 'llm') return validateLlmScript(script);
  return validateRuleScript(script);
}

/* ────────────────────────── 种子脚本（三阶段各一） ────────────────────────── */

function seedScripts() {
  const seeds = [];

  /* 阶段一：规则流程
     画布专项审核整改（2026-11-10）：
     ① 开场补 AI 身份披露（「智能语音助手，不是人工坐席」在录音告知之前）
     ② 消费下降断言改为有依据表述（绑定画像变量 ${drop_ratio}，来源客群快照字段）
     ③ 未识别 fallback 不再回环指向自身：澄清 1 次 → 仍未识别转 n_bye_unclear 安全退出
     ④ 新增 n_register 工具节点（register_benefit，需确认）：确认后真正执行登记，
        工具回执才进入成功结束——话术承诺不再等于业务事实
     ⑤ 登记结束 end_reason 从 success 改为 converted（有真实工具回执才算转化），
        客户确认但工具失败走 tool_error 结束 */
  seeds.push({
    id: 'SCR_RULE_001',
    name: '消费唤醒外呼 · 规则流程',
    stage: 'rule', scene: '消费活跃度下降', owner: '零售经营部', status: 'active', version: 3,
    desc: '决策树 + 意图路由节点：AI 身份披露 → 有证据的客户事实（${drop_ratio} 来自客群快照）→ 权益说明 → 确认 → 登记工具（回执驱动）→ 成功结束。未识别澄清 1 次后安全退出；拒绝/忙碌/投诉/工具失败各有独立结束状态。',
    created_at: '2026-11-01T10:00:00+08:00', updated_at: now(),
    variables: [
      { name: 'drop_ratio', type: 'number', source: 'audience_snapshot', desc: '消费环比降幅（客群快照字段 txnPrev→txn30 计算），缺失时开场跳过事实断言' },
    ],
    nodes: [
      { id: 'n_open', name: '开场白', type: 'say', text: '您好${name}，本通话由招商银行智能语音助手为您服务，不是人工坐席。本次通话将录音。${drop_ratio:看到您本月消费比上月少了约${drop_ratio}，}想跟您聊聊我们这个月的消费返现活动，您方便听一下吗？', branches: [
        { on: 'affirm', to: 'n_offer' }, { on: 'question', to: 'n_offer' }, { on: 'refuse', to: 'n_bye_refuse' }, { on: 'busy', to: 'n_bye_busy' }, { on: 'unrecognized', to: 'n_intent' } ] },
      { id: 'n_intent', name: '意图路由（词表）', type: 'intent', slot_into: 'intent', candidates: [
        { intent: 'ask_detail', keywords: ['什么', '怎么', '多少', '费', '门槛', '规则', '收钱', '你好', '喂', '说', '讲', '听听', '了解'], to: 'n_detail' },
        { intent: 'not_interested', keywords: ['不需要', '不用', '算了', '没兴趣', '别打', '不考虑'], to: 'n_bye_refuse' },
        { intent: 'interested', keywords: ['办理', '登记', '开通', '返现', '刷卡金', '就这样'], to: 'n_confirm' },
        { intent: 'complain', keywords: ['投诉', '人工', '转人工', '骚扰', '银监'], to: 'n_transfer' },
      ], fallback: { text: '不好意思，我没太听清。您是想了解这个返现活动，还是暂时不需要？', to: 'n_intent_retry' } },
      { id: 'n_intent_retry', name: '未识别澄清（仅 1 次）', type: 'say', maxLoops: 1, text: '抱歉，我这边没听清。如果感兴趣您说「了解」，不需要就说「不用」，我来帮您记录。', branches: [
        { on: 'affirm', to: 'n_offer' }, { on: 'question', to: 'n_detail' }, { on: 'deny', to: 'n_bye_refuse' },
        { on: 'refuse', to: 'n_bye_refuse' }, { on: 'busy', to: 'n_bye_busy' }, { on: 'unrecognized', to: 'n_bye_unclear' } ] },
      { id: 'n_transfer', name: '转人工（工具）', type: 'tool', tool: 'transfer_human' },
      { id: 'n_offer', name: '讲权益', type: 'say', text: '谢谢您。这个月的活动是：消费满 6 笔返 30 元刷卡金，直接进账单，不需要报名。要帮您登记开通吗？', branches: [
        { on: 'affirm', to: 'n_confirm' }, { on: 'deny', to: 'n_bye_refuse' }, { on: 'refuse', to: 'n_bye_refuse' }, { on: 'question', to: 'n_detail' }, { on: 'busy', to: 'n_bye_busy' }, { on: 'unrecognized', to: 'n_intent' } ] },
      { id: 'n_detail', name: '细节答疑', type: 'say', text: '返现不需要额外交钱，只要本月刷满 6 笔、每笔不限金额，下期账单自动返 30 元刷卡金。这样吧，我先帮您登记，您到APP里看下详情，可以吗？', branches: [
        { on: 'affirm', to: 'n_confirm' }, { on: 'deny', to: 'n_bye_refuse' }, { on: 'refuse', to: 'n_bye_refuse' }, { on: 'busy', to: 'n_bye_busy' }, { on: 'unrecognized', to: 'n_intent' } ] },
      { id: 'n_confirm', name: '确认意向（预置确认话术）', type: 'say', text: '跟您确认下：为您登记本月消费返现权益（刷满 6 笔返 30 元），可以吗？', branches: [
        { on: 'affirm', to: 'n_register' }, { on: 'deny', to: 'n_bye_refuse' }, { on: 'unrecognized', to: 'n_intent' } ] },
      { id: 'n_register', name: '登记权益（工具）', type: 'tool', tool: 'register_benefit', confirm_text: '登记消费返现权益', ack: '已为您登记消费返现权益，稍后可以在「我的权益」里看到。感谢您的接听，祝您生活愉快！', to: 'n_end_ok' },
      { id: 'n_end_ok', name: '登记成功结束', type: 'end', end_reason: 'converted', text: '权益已登记生效，稍后APP里可见，感谢接听，再见！' },
      { id: 'n_bye_unclear', name: '未识别安全退出', type: 'end', end_reason: 'no_match', text: '抱歉，可能是我这边信号不好。稍后如有需要欢迎随时联系，感谢接听，再见。' },
      { id: 'n_bye_refuse', name: '婉拒结束', type: 'end', end_reason: 'refused', text: '好的，理解您暂时不需要，那不打扰您了，感谢接听，再见。' },
      { id: 'n_bye_busy', name: '忙碌结束', type: 'end', end_reason: 'busy', text: '好的，您先忙，不打扰您了，再见。' },
    ],
    handlers: [
      { id: 'gh_complaint', name: '投诉转人工', event: 'intent', priority: 10, keywords: ['投诉', '人工', '转人工', '银监'], match_intents: ['refuse'], to: 'n_transfer', end: false, resume: false, enabled: true },
    ],
  });

  /* 阶段二：LLM 增强 workflow
     定位（与用户对齐）：话术全部预置写好（say 节点），流程图与阶段一同构；
     大模型只用在三类点，按需启用：
     ① 意图识别节点（intent）——LLM 判断客户意向（感兴趣/不感兴趣/投诉/忙碌等），
        知识条目作为判别参考注入 prompt 提升精度，带置信度与兜底
     ② 槽位抽取节点（slot）——默认正则提取（快、零成本），可开 use_llm=true 由 LLM 抽取
     ③ 知识答疑检索（say 节点可选挂知识库）——客户问到具体业务问题时按关键词召回口径

     画布专项审核整改（2026-11-10）：
     ④ 意图阈值 0.3→0.55；正样本污染清理——「喂/你好/嗯/行/好吧」是礼貌应答不是
        营销意向，从 interested 例句移除（低置信度走澄清不再误判）
     ⑤ 金额与期数拆成两个强类型槽位（installment_amount 元 / installment_terms 期），
        「分 12 期」不会再被当成 12 元
     ⑥ 报费率节点 unrecognized 不再直进促成确认，改走兜底澄清
     ⑦ 知识条目区分类型（category: intent_ref 业务判别 / business_rule 业务口径），
        意图判别参考与账单分期规则不再共用一组关键词竞争 */
  seeds.push({
    id: 'SCR_LLM_001',
    name: '分期意向挖掘 · LLM 流程',
    stage: 'llm', scene: '账单分期', owner: '零售经营部', status: 'active', version: 3,
    desc: '流程图与阶段一同构，话术全部预置；大模型只负责意图识别（阈值 0.55，礼貌应答走澄清不误判），金额/期数分槽位提取，未听懂走澄清不推进。',
    created_at: '2026-11-02T10:00:00+08:00', updated_at: now(),
    knowledge: [
      { title: '意图判别参考', category: 'intent_ref', keywords: ['了解', '兴趣', '推销'], content: '客户明确表达想了解（「说说」「怎么办理」「算下来多少」）→ interested；客户明确拒绝（「不需要」「别再打了」）→ not_interested；礼貌应答（「喂」「你好」「嗯」「行」）不算意向，低置信度走澄清。' },
      { title: '账单分期规则', category: 'business_rule', keywords: ['费率', '手续费', '利息'], content: '本期账单可分期，12 期手续费率每期 0.05%，无提前还款违约金，分期金额最低 500 元。' },
      { title: '权益要点', category: 'business_rule', keywords: ['优惠', '打折', '活动'], content: '本月办理分期享手续费 8 折。' },
    ],
    nodes: [
      { id: 'l_open', name: '开场白（预置话术）', type: 'say', text: '您好${name}，本通话由招商银行智能语音助手为您服务，不是人工坐席。本次通话将录音。看到您本期账单金额比较大，想跟您说说账单分期——本月办理手续费有 8 折优惠，您有兴趣了解一下吗？', branches: [
        { on: 'affirm', to: 'l_intent' }, { on: 'question', to: 'l_intent' }, { on: 'refuse', to: 'l_bye' }, { on: 'busy', to: 'l_bye_busy' }, { on: 'unrecognized', to: 'l_intent' } ] },
      { id: 'l_intent', name: '意向识别（LLM）', type: 'intent', threshold: 0.55, slot_into: 'intent', candidates: [
        { intent: 'interested', to: 'l_intent_check', examples: ['了解一下', '怎么说', '感兴趣', '什么活动', '有兴趣', '讲讲', '手续费多少', '费率怎么算', '怎么办理'] },
        { intent: 'not_interested', to: 'l_bye', examples: ['不需要', '不办', '算了', '没兴趣', '别再打了', '不打算'] },
        { intent: 'busy', to: 'l_bye_busy', examples: ['在忙', '开会', '晚点说', '没时间', '回头再说'] },
        { intent: 'complain', to: 'l_tool_transfer', examples: ['投诉', '人工', '银监', '烦不烦', '骚扰'] },
      ], fallback: { to: 'l_fallback', text: '不好意思我没太跟上，我是想跟您说本月账单分期手续费 8 折，您想了解吗？' } },
      { id: 'l_intent_check', name: '承接确认（预置话术）', type: 'say', maxLoops: 2, text: '是这样的，本月账单分期手续费有 8 折优惠，1 万元分 12 期每月也就多几十块。您想了解下费率，还是直接看看怎么办理？', branches: [
        { keywords: ['费率', '手续', '多少', '利率', '利息'], on: '问费率', to: 'l_fee' },
        { on: 'affirm', to: 'l_fee' }, { on: 'deny', to: 'l_bye' }, { on: 'busy', to: 'l_bye_busy' },
        { on: 'question', to: 'l_fee' }, { on: 'unrecognized', to: 'l_fallback' } ] },
      { id: 'l_fee', name: '报费率（预置话术 + 知识口径）', type: 'say', maxLoops: 2, use_knowledge: true, text: '费率是这样的：12 期手续费率每期 0.05%，没有提前还款违约金，本月办理手续费还有 8 折。', branches: [
        { keywords: ['分', '期', '元', '万'], on: '报分期金额', to: 'l_slot_amt' },
        { on: 'affirm', to: 'l_slot_amt' }, { on: 'deny', to: 'l_bye' }, { on: 'busy', to: 'l_bye_busy' },
        { on: 'question', keywords: ['费率', '手续费', '利率', '利息'], to: 'l_fee' },
        { on: 'unrecognized', to: 'l_fallback' } ] },
      { id: 'l_slot_amt', name: '分期金额提问（强类型槽位）', type: 'slot', slot: 'installment_amount', text: '好的，那您这笔想分多少元？（最低 500 元）', patterns: ['(\\d{3,6})\\s*元', '(\\d{3,6})'], ack: '好的，金额记下了。', retry: '金额没听清，您想分多少元？', to: 'l_slot_terms' },
      { id: 'l_slot_terms', name: '分期期数提问（强类型槽位）', type: 'slot', slot: 'installment_terms', text: '想分几期？（可选 3、6、12、24 期）', patterns: ['分(\\d{1,2})\\s*期', '(\\d{1,2})\\s*期'], ack: '好的，期数记下了。', retry: '期数没听清，您想分几期？', to: 'l_confirm' },
      { id: 'l_confirm', name: '促成确认（预置话术）', type: 'say', text: '那我帮您把分期的优惠规则发到APP，您看合适随时一键办理，可以吗？', branches: [
        { on: 'affirm', to: 'l_end' }, { on: 'deny', to: 'l_bye' }, { on: 'busy', to: 'l_bye_busy' }, { on: 'unrecognized', to: 'l_fallback' } ] },
      { id: 'l_fallback', name: '兜底澄清（预置话术）', type: 'say', text: '不好意思我没太跟上，我是想跟您说本月账单分期手续费 8 折，您想了解吗？', branches: [
        { on: 'affirm', to: 'l_fee' }, { on: 'deny', to: 'l_bye' }, { on: 'busy', to: 'l_bye_busy' }, { on: 'unrecognized', to: 'l_bye' } ] },
      { id: 'l_end', name: '成功结束', type: 'end', end_reason: 'success', text: '好的，稍后在APP里查看，感谢接听，再见！' },
      { id: 'l_bye', name: '婉拒结束', type: 'end', end_reason: 'refused', text: '好的，不打扰您了，优惠保留到月底，感谢接听，再见。' },
      { id: 'l_bye_busy', name: '忙碌结束', type: 'end', end_reason: 'busy', text: '好的您先忙，优惠保留到月底，晚点再联系您，再见。' },
      { id: 'l_tool_transfer', name: '转人工（工具）', type: 'tool', tool: 'transfer_human' },
    ],
  });
  /* 阶段三：模型主导（WOWService 式）
     画布专项审核整改（2026-11-10）：
     ① 循环口径统一：policy.max_turns=8 与节点 maxLoops 冲突——maxLoops 删除，
        统一只认 policy.max_turns（引擎轮次护栏本来就读它）
     ② 转人工不再归为成功：g_end 拆成 g_end_ok(确认+登记后 success)与
        g_transfer 已自带 handoff（transfer_human 工具路径），正常结束指向 g_end_ok
     ③ desc 修正「无预置流程」表述为「硬壳+自主区」——与画布 4 节点一致
     ④ 修复 knowledge 对象重复 keywords 键（JS 对象字面量后键覆盖前键的隐患） */
  seeds.push({
    id: 'SCR_AGENT_001',
    name: '高价值唤醒 · 模型主导',
    stage: 'agent', scene: '消费活跃度下降', owner: '零售经营部', status: 'active', version: 2,
    desc: '硬壳 + 自主区：开场合规披露与转人工是引擎硬闸，中间大模型对话区自主决策说什么、问什么、何时结束；必需槽位（offer_presented/intent/confirmed）由确认闸强制校验，未集齐不得记成功。',
    created_at: '2026-11-03T10:00:00+08:00', updated_at: now(),
    nodes: [
      { id: 'g_open', name: '开场', type: 'gen', prompt: '以客服身份自然开场，说明本月消费返现权益来意。合规硬要求：第一句必须先声明 AI 身份（「本通话由智能语音助手为您服务，不是人工坐席」），随后说明「本次通话将录音」', text: '', knowledge: ['权益要点'], to: 'g_dialog', branches: [] },
      { id: 'g_dialog', name: '大模型对话', type: 'gen', prompt: '自主对话：听懂客户意图（想了解/拒绝/忙碌/投诉），依据知识库口径答疑，需要时提取分期金额，意向明确后确认办理；连续两次拒绝即礼貌收尾', text: '', knowledge: ['权益要点', '异议应对', '退订合规'], use_knowledge: true, branches: [
        { on: 'complain', to: 'g_transfer' }, { on: 'done', to: 'g_end_ok' } ] },
      { id: 'g_transfer', name: '转人工', type: 'tool', tool: 'transfer_human', to: 'g_end_handoff', branches: [] },
      { id: 'g_end_ok', name: '办理成功结束', type: 'end', end_reason: 'success', text: '', branches: [] },
      { id: 'g_end_handoff', name: '转人工结束', type: 'end', end_reason: 'handoff', text: '', branches: [] },
    ],
    policy: {
      objective: '让消费下降的高价值客户重新用卡：讲清本期消费返现权益，拿到开通意向并确认',
      required_slots: ['offer_presented', 'intent', 'confirmed'],
      knowledge: [
        { title: '权益要点', keywords: ['返现', '活动', '门槛'], content: '本期返现活动：本月刷满 6 笔返 30 元刷卡金，直接进下期账单，无需报名，不额外收费。' },
        { title: '异议应对', keywords: ['推销', '不需要', '顾虑'], content: '权益是账户自带的，不收钱、不用可随时关；本月用不上也不影响任何费用。' },
        { title: '退订合规', keywords: ['投诉', '骚扰'], content: '若客户明确拒绝营销，立即致歉收尾并登记免打扰，不再重复推销。' },
      ],
      guard: ['不承诺费率与权益之外的条件', '单次通话不超过 8 轮', '客户连续两次拒绝即礼貌收尾', '提及投诉/人工立即转接'],
      style: 'warm',
      max_turns: 8,
    },
  });
  return seeds;
}

/* ────────────────────────── 导出 ────────────────────────── */

module.exports = {
  STAGES, RUNTIMES, OPENJIUWEN_MAP, TOOL_RISKS, PERSONAS, USER_INTENTS, COMPLIANCE_RULES, BANNED_WORDS, RECORDING_HINT,
  seedScripts, validateScript,
  createSession, openSession, stepSession, autoRun, sessionMetrics,
  parseUserInput, personaUtterance, complianceCheck, reflectRewrite, turnRecord, evidenceOf, normalizeKnowledge, ruleIntentMatch,
  ruleStep, llmStep, agentDecide, agentAct, knowledgeRetrieve, knowledgeRetrieveHybrid, llmIntentScore,
  stepSessionAsync, realLlm, realBranchMatch, BUILTIN_ON, cnNumToArabic,
  evalConditionExpr, routeCondition,
  setScriptResolver, resolveScript, runAssignments, validateFlowNodes,
  runGlobalHandlers, handlersOf, realGlobalHandlerMatch, runParallelNode, validateParallelAndHandlers,
  HANDLER_EVENTS, PARALLEL_SILENT_TYPES,
  agentTurn, stepSessionAgentAsync, agentLlm,
};
