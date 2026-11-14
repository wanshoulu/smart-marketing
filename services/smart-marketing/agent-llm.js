'use strict';

/**
 * 智能营销 · 阶段3（agent）LLM 命令生成层
 *
 * 对齐机制（2026-11-09 官方原文调研留痕）：
 * - Rasa CALM「命令生成器」：prompt = 会话历史 + 当前流程骨架 + 候选流程描述 + 会话状态，
 *   模型输出结构化命令（start_flow / set_slot / ...），由确定性 Dialogue Manager 执行。
 *   https://rasa.com/docs/pro/build/writing-flows/
 * - Parlant「匹配与生成分离」：每轮只注入当前适用的少量 guideline（避免「指令的诅咒」），
 *   合规关键话术用固定文案（canned response），其余场景自由生成。
 *   https://www.parlant.io/docs/engine-internals/overview/
 *
 * 模型知道的不是「全部流程」，而是「当前轮次该知道的部分」：
 *   ① 流程编译器 compileFlows：画布图/策略 → flow DSL（id+name+desc+步骤骨架）
 *   ② 上下文装配 compileContext：静态角色+合规底线 / 当前状态 / 动态检索(knowledge+guideline)
 *   ③ 命令生成 genCommands：LLM 输出 JSON 命令序列（act + say + set_slot + tool）
 *   ④ 解析与回落：非法 JSON / 网络失败 → simulateCommands（与真实接口同构，行为永不中断）
 *
 * 执行层（dialog.js agentAct 改造）负责：命令校验、禁词护栏、槽位写回、工具副作用、trace。
 */

const realLlm = require('./real-llm');

/* ── ① 流程编译器：把脚本（画布图或 policy）编译为模型可读的 flow DSL ──
   CALM 官方经验：description 质量决定触发准确率。带节点图的脚本逐节点提炼骨架；
   纯 policy 脚本输出目标+必收信息+边界。输出文本直接进 prompt。 */
function compileFlows(script) {
  const lines = [];
  const p = script.policy || {};
  // 有节点图：编译为步骤骨架（say/gen 的话术只留前 40 字摘要 + 动作语义，不是全文）
  if (Array.isArray(script.nodes) && script.nodes.length) {
    lines.push('【参考流程图（已启用，可灵活偏离，但不可违背其合规出口）】');
    script.nodes.slice(0, 20).forEach(n => {
      const typeCn = { say: '话术', gen: '生成话术', intent: '意图路由', slot: '收集槽位', tool: '工具', end: '结束', assign: '赋值', parallel: '并行', subflow: '子流程' }[n.type] || n.type;
      let seg = '- [' + typeCn + '] ' + (n.name || n.id);
      if (n.type === 'end') seg += '（' + (n.end_reason || 'end') + '）';
      if (n.type === 'tool') seg += '：' + n.tool;
      if (n.type === 'slot') seg += '：' + (n.slot || '?');
      if ((n.branches || []).length) seg += ' → 分支: ' + n.branches.map(b => b.on).join('/');
      if (n.to) seg += ' → ' + n.to;
      lines.push(seg);
    });
    return lines.join('\n');
  }
  // 纯 policy（WOWService 式）：无预置流程，只给目标/必收/边界
  lines.push('【对话目标】' + (p.objective || '完成本次外呼沟通'));
  if ((p.required_slots || []).length) lines.push('【需获取并确认的信息】' + p.required_slots.join('、'));
  if ((p.guard || []).length) lines.push('【业务边界】\n' + p.guard.map(g => '- ' + g).join('\n'));
  return lines.join('\n');
}

/* ── ② 上下文装配：静态 + 状态 + 动态检索三段 ── */
function compileContext(script, s, userText, kbHits) {
  const p = script.policy || {};
  const segs = [];

  // 静态：角色 + 合规底线（每轮恒定，最短）
  segs.push([
    '你是招商银行信用卡中心的电话客服，客户是' + ((s.customer && s.customer.name) || '客户') + '。',
    '合规底线（任何话术不得违背）：不得承诺权益之外的条件；不得出现「保本、稳赚、肯定涨、内部消息、必须办理、不办就」等词；不得索要密码或验证码；开场第一句必须声明 AI 身份（告知客户本通话由智能语音助手/机器人接听，不是人工坐席），随后告知通话录音。',
    '只输出一个 JSON 对象，不要输出其他内容。',
  ].join('\n'));

  // 流程骨架（编译器产出）
  segs.push(compileFlows(script));

  // 当前状态：轮次/槽位/已说要点（模型决策的地基）
  const slots = {};
  Object.keys(s.slots || {}).forEach(k => { if (!k.startsWith('__')) slots[k] = s.slots[k]; });
  segs.push('【当前状态】第 ' + s.turn + ' 轮（上限 ' + (p.max_turns || 8) + '）；已记录信息：' + (JSON.stringify(slots) || '无') + (s.slots.__negStreak >= 1 ? '；客户已表达消极态度 ' + s.slots.__negStreak + ' 次' : ''));

  // 动态检索：知识库命中（Parlant 式只给相关条目）
  if ((kbHits || []).length) {
    segs.push('【相关知识（只可依据这些作答，不得超出承诺）】\n' + kbHits.map(k => '- ' + k.title + '：' + k.content).join('\n'));
  }

  // 对话历史（截尾，外呼延迟敏感）
  const hist = (s.history || []).slice(-8).map(h => (h.role === 'bot' ? '客服' : '客户') + '：' + h.text).join('\n');
  if (hist) segs.push('【对话记录】\n' + hist);
  segs.push('【客户刚说】' + (userText || '（尚未开口，请开场）'));

  return segs.join('\n\n');
}

/* ── ③ 命令生成（真实 LLM）：输出命令序列 ──
   命令协议（执行层校验）：
   { "act": "opening|present_offer|probe_intent|handle_objection|confirm_info|close_success|close_fail|transfer_human|hangup|free",
     "say": "话术正文",
     "set_slot": {"槽位名": "值"},
     "tool": "query_bill|register_callback|register_benefit|register_dnd|transfer_human" }
   act=free 时为完全自由应答（长尾场景）；其余 act 沿用既有动作语义，say 可覆盖默认话术。 */
async function genCommands(ctxText, opts) {
  const o = opts || {};
  const sys = '你是银行外呼对话的决策引擎。根据给定上下文（流程参考、状态、知识、对话记录）决定客服这一轮说什么。输出一个 JSON 对象：{"act":"动作","say":"这轮话术（中文口语，60字内）","set_slot":{"要记录的信息":...},"tool":"需要调用的工具或省略"}。动作可选：opening(开场) present_offer(讲权益) probe_intent(探询意向) handle_objection(处理异议) confirm_info(确认信息) close_success(促成收尾) close_fail(婉拒收尾) transfer_human(转人工) hangup(挂机) free(自由应答，配合say使用)。不确定时用 free。只输出 JSON。';
  const r = await realLlm.chat([
    { role: 'system', content: sys },
    { role: 'user', content: ctxText },
  ], { maxTokens: 400, temperature: 0.3 });
  if (!r.ok) return null;
  return parseCommands(r.text);
}

/* JSON 解析：容忍 markdown 包裹与前后杂质；失败返回 null（调用方回落） */
function parseCommands(text) {
  if (!text) return null;
  let t = String(text).trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (m) t = m[0];
  try {
    const j = JSON.parse(t);
    if (!j || typeof j !== 'object') return null;
    return j;
  } catch (e) { return null; }
}

const VALID_ACTS = ['opening', 'present_offer', 'probe_intent', 'handle_objection', 'confirm_info', 'close_success', 'close_fail', 'transfer_human', 'hangup', 'free'];

/* 命令校验：非法 act 丢弃整个命令（执行层回落模拟）；say/set_slot/tool 做类型收敛 */
function sanitizeCommands(cmd) {
  if (!cmd || typeof cmd !== 'object') return null;
  const act = VALID_ACTS.indexOf(cmd.act) !== -1 ? cmd.act : null;
  if (!act) return null;
  const out = { act };
  // 不可逆前提：close_success 依赖客户已确认（confirmed）。LLM 跳过确认直接促成时，
  // 降级为 confirm_info（发起确认），由下一轮客户 affirm 落账后才可能真正执行。
  // 执行层还会二次拦截（requires_confirmation + executed 判定），这里是第一道闸。
  if (!cmd.confirmed_ok && act === 'close_success') out._downgrade_to = 'confirm_info';
  if (typeof cmd.say === 'string' && cmd.say.trim()) out.say = cmd.say.trim().slice(0, 300);
  if (cmd.set_slot && typeof cmd.set_slot === 'object' && !Array.isArray(cmd.set_slot)) {
    const slots = {};
    Object.keys(cmd.set_slot).slice(0, 6).forEach(k => {
      if (!k.startsWith('__')) slots[String(k).slice(0, 30)] = String(cmd.set_slot[k]).slice(0, 120);
    });
    if (Object.keys(slots).length) out.set_slot = slots;
  }
  const TOOLS = ['query_bill', 'register_callback', 'register_benefit', 'register_dnd', 'transfer_human'];
  if (typeof cmd.tool === 'string' && TOOLS.indexOf(cmd.tool) !== -1) out.tool = cmd.tool;
  return out;
}

/* ── ④ 回落模拟：与真实接口同构。规则式动作选择 + 模板话术（复用既有确定性逻辑的口径） ──
   触发条件：LLM 网络失败 / JSON 解析失败 / SMART_MKT_REAL_LLM=off。 */
function simulateCommands(script, s, parsed) {
  const negStreak = s.slots.__negStreak || 0;
  const maxTurns = (script.policy || {}).max_turns || 8;
  let act = 'free';
  if (!s.slots.opened) act = 'opening';
  else if (negStreak >= 2 || (parsed && parsed.intent === 'refuse' && s.turn >= 2)) act = 'close_fail';
  else if (parsed && parsed.text && /投诉|银监|人工/.test(parsed.text)) act = 'transfer_human';
  else if (parsed && parsed.intent === 'affirm' && s.slots.offer_presented && !s.slots.confirmed) act = 'confirm_info';
  else if (s.slots.intent === 'positive' && s.slots.confirmed) act = 'close_success';
  else if (parsed && (parsed.sentiment === 'neg' || parsed.intent === 'question') && s.slots.opened) act = 'handle_objection';
  else if (s.slots.opened && !s.slots.offer_presented) act = 'present_offer';
  else if (s.turn >= maxTurns) act = 'close_fail';
  else act = 'probe_intent';
  return { act, say: null, set_slot: null, tool: null, _simulated: true };
}

/* 阶段3 LLM 可用性（透传 real-llm） */
function llmAvailable() { return realLlm.llmAvailable(); }

module.exports = {
  compileFlows, compileContext, genCommands, parseCommands, sanitizeCommands, simulateCommands, llmAvailable,
};
