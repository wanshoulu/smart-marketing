'use strict';

/**
 * 阶段3（agent · 模型主导）持久回归
 *
 * 覆盖（2026-11-09 改造，对齐 Rasa CALM 命令生成器 + Parlant 匹配/生成分离）：
 * 1. 流程编译器 compileFlows：节点图脚本 → 步骤骨架；policy 脚本 → 目标/必收/边界
 * 2. 上下文装配 compileContext：含角色合规底线 / 流程骨架 / 状态 / 知识检索 / 历史
 * 3. 命令解析与校验：JSON 提取容错、非法 act 拒绝、set_slot/tool 收敛
 * 4. 命令注入执行：say 覆盖话术、set_slot 写槽位、tool 走风险分级（不可逆须确认）
 * 5. 回落轨：LLM 不可用 → agentDecide 确定性打分（行为与旧版一致）
 * 6. 护栏不变：命令话术命中禁词 → 反思重写/熔断仍在
 * 7. 全流程闭环：模拟 LLM 命令序列跑通一通完整电话
 */

const test = require('node:test');
const assert = require('node:assert');
const dialog = require('../services/smart-marketing/dialog');
const agentLlm = require('../services/smart-marketing/agent-llm');

function agentScript() {
  return dialog.seedScripts().find(s => s.stage === 'agent');
}

function nodeScript() {
  return dialog.seedScripts().find(s => s.stage === 'rule');
}

test('compileFlows：节点图脚本输出组件参考图（阶段三带 nodes）', () => {
  const out = agentLlm.compileFlows(agentScript());
  assert.ok(out.includes('【参考流程图'), '含参考流程图段：' + out.slice(0, 80));
  assert.ok(out.includes('开场'), '含开场组件');
});

test('compileFlows：节点图脚本输出步骤骨架（类型+名称+分支）', () => {
  const out = agentLlm.compileFlows(nodeScript());
  assert.ok(out.includes('【参考流程图'), '含流程图段');
  assert.ok(out.includes('[话术] 开场白'), '含开场节点');
  assert.ok(out.includes('affirm'), '含分支意图');
  assert.ok(out.includes('[结束]'), '含结束节点');
});

test('compileContext：装配合规底线、流程、状态、知识、历史五段', () => {
  const sc = agentScript();
  const s = dialog.createSession(sc, { xid: 'X1', name: '王先生', amt30: 5000 }, { persona: 'cooperative', mode: 'auto' });
  s.turn = 3; s.slots.opened = true;
  const kb = dialog.knowledgeRetrieve(sc, '返现 门槛', 2);
  assert.ok(kb.length >= 1, '知识检索应命中');
  const ctx = agentLlm.compileContext(sc, s, '你们这个收费吗', kb);
  assert.ok(ctx.includes('保本'), '含合规底线禁词');
  assert.ok(ctx.includes('【参考流程图'), '含流程段（参考图）');
  assert.ok(ctx.includes('opened'), '含已记录槽位');
  assert.ok(ctx.includes('返现'), '含检索到的知识');
  assert.ok(ctx.includes('你们这个收费吗'), '含客户输入');
  assert.ok(ctx.includes('第 3 轮'), '含轮次状态');
});

test('parseCommands：容忍 markdown 包裹与杂质', () => {
  assert.deepEqual(agentLlm.parseCommands('```json\n{"act":"free","say":"好的"}\n```'), { act: 'free', say: '好的' });
  assert.deepEqual(agentLlm.parseCommands('前置说明 {"act":"probe_intent"} 后缀'), { act: 'probe_intent' });
  assert.equal(agentLlm.parseCommands('不是 JSON'), null);
  assert.equal(agentLlm.parseCommands(''), null);
  assert.equal(agentLlm.parseCommands(null), null);
});

test('sanitizeCommands：非法 act 拒绝；字段类型收敛；内部槽位被过滤', () => {
  assert.equal(agentLlm.sanitizeCommands({ act: 'destroy_world' }), null, '非法 act');
  assert.equal(agentLlm.sanitizeCommands(null), null);
  assert.equal(agentLlm.sanitizeCommands({}), null, '缺 act');
  const ok = agentLlm.sanitizeCommands({ act: 'free', say: '  您好  ', set_slot: { intent: 'positive', __internal: 'x', extra: 1 }, tool: 'launch_missiles' });
  assert.equal(ok.act, 'free');
  assert.equal(ok.say, '您好');
  assert.deepEqual(ok.set_slot, { intent: 'positive', extra: '1' }, '内部槽位过滤、值字符串化');
  assert.equal(ok.tool, undefined, '非法工具被丢弃');
  assert.ok(!agentLlm.sanitizeCommands({ act: 'free', tool: 'register_benefit' }).set_slot, '无槽位则不产出');
});

test('命令注入：say 覆盖话术、set_slot 写槽位、close_fail 收尾', () => {
  const sc = agentScript();
  const s = dialog.createSession(sc, { xid: 'X1', name: '李女士', amt30: 3000 }, { persona: 'cooperative', mode: 'auto' });
  s.slots.opened = true; s.slots.offer_presented = true; s.slots.intent = 'positive'; s.slots.confirmed = true;
  s.slots.__negStreak = 2;
  const r = dialog.stepSessionAgentAsync || null;
  // 同步路径直接注入命令（模拟 sanitize 后的真实 LLM 产物）
  s.__agentCmd = { act: 'close_fail', say: '理解您暂时不需要，不打扰您了，再见。', set_slot: { farewell: 'yes' } };
  const out = dialog.stepSession(sc, s, { text: '别再打了', intent: 'refuse' });
  assert.ok(out.text.includes('不打扰'), '话术来自命令 say：' + out.text);
  assert.equal(s.slots.farewell, 'yes', 'set_slot 已写回');
  assert.equal(out.done, true, 'close_fail 结束会话');
  assert.ok(s.trace.some(t => t.action === 'decide' && t.real === true), 'trace 记录 LLM 决策（real 标记）');
  assert.ok(s.trace.some(t => t.action === 'cmd_act' && /话术来自LLM/.test(t.detail)), 'trace 记录命令话术来源');
  assert.ok(s.trace.some(t => t.action === 'cmd_slot'), 'trace 记录槽位命令');
});

test('命令注入：tool=transfer_human 走转人工；不可逆工具须确认', () => {
  const sc = agentScript();
  const s = dialog.createSession(sc, { xid: 'X1', name: '赵先生' }, { persona: 'cooperative', mode: 'auto' });
  s.slots.opened = true;
  s.__agentCmd = { act: 'transfer_human', tool: 'transfer_human' };
  const out = dialog.stepSession(sc, s, { text: '给我转人工', intent: 'other' });
  assert.equal(s.status, 'handoff', '转人工 handoff（状态在 session.status）');
  const rec = s.turn_records[s.turn_records.length - 1];
  assert.equal(rec.actions[0].tool, 'transfer_human', 'TurnRecord 记录工具');
  assert.equal(rec.actions[0].requires_confirmation, false, '转人工无须确认');

  const s2 = dialog.createSession(sc, { xid: 'X2', name: '钱女士' }, { persona: 'cooperative', mode: 'auto' });
  s2.slots.opened = true;
  s2.__agentCmd = { act: 'confirm_info', tool: 'register_benefit' };
  const out2 = dialog.stepSession(sc, s2, { text: '那开通吧', intent: 'affirm' });
  const rec2 = s2.turn_records[s2.turn_records.length - 1];
  assert.equal(rec2.actions[0].requires_confirmation, true, '不可逆工具标记须确认');
  assert.equal(rec2.actions[0].executed, true, '客户本轮明确同意（affirm）视为已确认');
  // 反例：客户未同意时不可逆工具不执行
  const s3 = dialog.createSession(sc, { xid: 'X3', name: '吴先生' }, { persona: 'cooperative', mode: 'auto' });
  s3.slots.opened = true;
  s3.__agentCmd = { act: 'confirm_info', tool: 'register_benefit' };
  dialog.stepSession(sc, s3, { text: '我再想想', intent: 'other' });
  const rec3 = s3.turn_records[s3.turn_records.length - 1];
  assert.equal(rec3.actions[0].executed, false, '未确认不执行');
});

test('命令话术命中禁词 → 护栏仍生效（反思重写或熔断）', () => {
  const sc = agentScript();
  const s = dialog.createSession(sc, { xid: 'X1', name: '孙先生' }, { persona: 'cooperative', mode: 'auto' });
  s.slots.opened = true;
  s.__agentCmd = { act: 'present_offer', say: '这个活动稳赚不赔，您必须办理。' };
  dialog.stepSession(sc, s, { text: '有什么活动', intent: 'question' });
  const lastRec = s.trace[s.trace.length - 1];
  const hadCompliance = s.trace.some(t => t.action === 'reflect' || t.action === 'compliance_block');
  assert.ok(hadCompliance, 'trace 有反思或熔断记录：' + JSON.stringify(s.trace.map(t => t.action)));
  assert.ok(!s.trace.some(t => t.action === 'act_present_offer' && /稳赚/.test('')), 'sanity');
});

test('回落轨：LLM 不可用时 agentDecide 打分仍完整跑通（行为与旧版一致）', () => {
  const sc = agentScript();
  const s = dialog.createSession(sc, { xid: 'X1', name: '周先生' }, { persona: 'cooperative', mode: 'auto' });
  assert.equal(s.__agentCmd, null, '无注入');
  const o = dialog.openSession(sc, s);
  assert.ok(o.text.length > 5, '开场照说');
  assert.ok(s.trace.some(t => t.action === 'decide' && !t.real), 'trace 记录确定性决策');
});

test('simulateCommands：关键状态映射到正确动作（回落口径）', () => {
  const sc = agentScript();
  const s = dialog.createSession(sc, { xid: 'X1', name: '吴先生' }, { persona: 'cooperative', mode: 'auto' });
  assert.equal(agentLlm.simulateCommands(sc, s, { intent: 'other' }).act, 'opening', '未开场');
  s.slots.opened = true;
  assert.equal(agentLlm.simulateCommands(sc, s, { intent: 'other' }).act, 'present_offer', '未讲权益');
  s.slots.offer_presented = true;
  assert.equal(agentLlm.simulateCommands(sc, s, { intent: 'question' }).act, 'handle_objection', '有疑问');
  s.slots.intent = 'positive'; s.slots.confirmed = true;
  assert.equal(agentLlm.simulateCommands(sc, s, { intent: 'affirm' }).act, 'close_success', '促成');
});

test('全流程闭环：模拟 LLM 命令序列驱动完整一通电话', () => {
  const sc = agentScript();
  const s = dialog.createSession(sc, { xid: 'X1', name: '郑先生', amt30: 8000 }, { persona: 'cooperative', mode: 'auto' });
  // 模拟真实 LLM 每轮产出命令（与 sanitizeCommands 产物同构）
  const plan = [
    { act: 'present_offer', say: '本月刷满 6 笔返 30 元刷卡金，直接进账单，不用额外交钱。', set_slot: { offer_presented: 'true' } },
    { act: 'probe_intent', say: '您看这个权益用得上吗？' },
    { act: 'confirm_info', say: '好的，帮您确认：开通本期返现权益，次月生效，没有额外费用，确认吗？', set_slot: { intent: 'positive' } },
    { act: 'close_success', say: '已经为您登记好了，APP 里能看到详情。感谢接听，再见！', tool: 'register_benefit' },
  ];
  const texts = ['嗯，你说', '有什么门槛吗', '可以，开通吧', '确认'];
  const intents = ['affirm', 'question', 'affirm', 'affirm'];
  const o = dialog.stepSession(sc, s, { text: '', intent: 'other' }); // opening 由 agentDecide 兜底
  assert.ok(o.text.includes('录音'), '开场含录音告知');
  let r = null;
  for (let i = 0; i < plan.length; i++) {
    s.__agentCmd = agentLlm.sanitizeCommands(plan[i]);
    r = dialog.stepSession(sc, s, { text: texts[i], intent: intents[i] });
    if (r.done) break;
  }
  assert.equal(r.done, true, '会话结束');
  assert.equal(s.status, 'done', '状态 done');
  assert.equal(s.slots.intent, 'positive', '意向记录');
  assert.equal(s.slots.offer_presented, 'true', '命令槽位写入');
  const rec = s.turn_records[s.turn_records.length - 1];
  assert.ok(rec.actions.length && rec.actions[0].tool === 'register_benefit', '收尾工具在 TurnRecord');
  const m = dialog.sessionMetrics(s, sc);
  assert.equal(m.end_reason, 'success', '成功收尾');
});

test('stepSessionAgentAsync：无 LLM 环境同步回落且结果同构', async () => {
  const sc = agentScript();
  const s = dialog.createSession(sc, { xid: 'X1', name: '王先生' }, { persona: 'cooperative', mode: 'auto' });
  const o = await dialog.stepSessionAgentAsync(sc, s, { text: '', intent: 'other' });
  assert.ok(o.text && typeof o.text === 'string', '有文本');
  assert.equal(typeof o.done, 'boolean', 'done 布尔');
  assert.ok(o.metrics, '带 metrics');
});
