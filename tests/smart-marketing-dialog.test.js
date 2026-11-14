'use strict';

/**
 * 智能营销工作台 · 多轮对话编排引擎契约测试
 *
 * 这些断言来自「第一/第二阶段流程画布能力审计」，覆盖此前实证复现过的真实缺陷，
 * 目的是防止画布「能画能存」但引擎「跑不出来」的回归：
 *
 *  1. 两代只差意图识别 —— 同一张用户自画流程图（say/intent/slot/condition/tool/end），
 *     rule 与 llm 必须给出同样的业务结果，且都能通过校验器。
 *  2. 节点链 —— say/slot/tool 的 to 链必须被两代引擎跟随（旧版 ruleStep 完全忽略 node.to）。
 *  3. 静默路由器 —— condition/intent 到达即分流，不播报话术、不占一轮。
 *  4. 状态护栏 —— slot 无 to 时不得无限重问；不可逆工具必须经确认闸门。
 *  5. 表达式求值器 —— 未知变量、尾部多余 token、0/false 不得误判。
 *  6. 自定义分支条件 —— LLM 可用时，任意中文 on 条件必须可达（旧版被 unrecognized 兜底吞掉）。
 *  7. 种子脚本 —— 两代预置流程在有限轮内能收尾，不产生死循环。
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

/* 打桩真实 LLM 适配层：测试不依赖外网 / API key。
   必须在 require(dialog.js) 之前注入，否则 dialog.js 已缓存真实模块。
   chat 恒返回 match:1，用于验证自定义分支条件的 LLM 判定链路确实被调用。 */
const RL_PATH = path.resolve(__dirname, '../services/smart-marketing/real-llm.js');
require.cache[RL_PATH] = {
  id: RL_PATH, filename: RL_PATH, loaded: true,
  exports: {
    llmAvailable: () => true,
    realIntentScore: async () => null,
    realGenText: async () => null,
    chat: async () => ({ ok: true, text: '{"match":1,"score":0.95}' }),
  },
};

const D = require('../services/smart-marketing/dialog.js');

const CUSTOMER = { xid: 'X1', name: '王先生', amt30: 12000, txn30: 8 };

function mk(stage, nodes, extra) {
  return Object.assign({ id: 'T_' + stage, name: 'contract', stage, version: 1, nodes, knowledge: [] }, extra || {});
}
function session(sc) {
  const s = D.createSession(sc, CUSTOMER, { mode: 'manual' });
  D.openSession(sc, s);
  return s;
}
function turn(sc, s, text, intent) {
  return D.stepSession(sc, s, { text, intent });
}

/* 用户可自画的一张通用流程图：同一份节点数据同时喂给两代引擎。
   intent 候选同时带 keywords（第一代词表）与 examples（第二代语义示例），
   差异只落在「引擎按哪种依据判意图」，而不是流程拓扑。 */
function fullFlowNodes() {
  return [
    { id: 'a', name: '开场', type: 'say', text: '您好${name}，本次通话将录音，介绍下账单分期活动。', to: 'i' },
    { id: 'i', name: '意图路由', type: 'intent', slot_into: 'intent', candidates: [
      { intent: 'interested', keywords: ['想了解', '感兴趣', '说说'], examples: ['想了解', '介绍一下', '说说看'], to: 's' },
      { intent: 'not_interested', keywords: ['不需要', '没兴趣'], examples: ['不需要', '不感兴趣'], to: 'e_low' },
    ], fallback: { text: '不好意思没听清，您是想了解一下吗？', to: 'i' } },
    { id: 's', name: '金额抽取', type: 'slot', slot: 'amount', text: '您想分多少元？',
      patterns: ['(\\d{3,6})\\s*元', '(\\d{3,6})'], ack: '好的，记下 ${amount} 元。', retry: '金额没听清，再说一遍？', to: 'c' },
    { id: 'c', name: '额度分流', type: 'condition',
      conditions: [{ expr: 'amount > 3000', to: 't' }], elseTo: 'e_low' },
    { id: 't', name: '查账单', type: 'tool', tool: 'query_bill', ack: '查到本期账单 ${amt30} 元。', to: 'e_ok' },
    { id: 'e_ok', name: '成功结束', type: 'end', end_reason: 'success', text: '感谢接听，再见！' },
    { id: 'e_low', name: '婉拒结束', type: 'end', end_reason: 'refused', text: '那不打扰您了，再见。' },
  ];
}

/* ── 1. 两代只差意图识别：同一张图的业务结果必须一致 ── */

for (const stage of ['rule', 'llm']) {
  test(`[${stage}] 校验器认可通用节点组合（画布能画能存）`, () => {
    const v = D.validateScript(mk(stage, fullFlowNodes()));
    assert.deepStrictEqual(v.errors, [], '校验器拦住了合法通用流程图');
  });

  test(`[${stage}] 用户自画流程：意图→槽位→条件→工具→结束 全链路可跑通`, () => {
    const sc = mk(stage, fullFlowNodes());
    const s = session(sc);
    turn(sc, s, '我想了解一下', 'question');   // 命中 interested → 提出槽位问题
    assert.strictEqual(s.status, 'active', '意图路由后会话不应结束');
    assert.ok(s.history.some(h => h.role === 'bot' && /多少元/.test(h.text)), '槽位节点应先提问');

    for (let i = 0; i < 4 && s.status === 'active'; i++) turn(sc, s, '我想分 5000 元');
    assert.strictEqual(s.end_reason, 'success', '应走到成功结束节点');
    assert.strictEqual(String(s.slots.amount), '5000', '槽位抽取结果必须写回会话变量');
    assert.strictEqual(s.slots.bill_queried, true, '工具节点必须真正执行，而非只播报话术');
    assert.ok(s.trace.some(t => t.action === 'condition'), '条件节点必须被求值');
    assert.ok(s.trace.some(t => t.action === 'tool_call'), '工具节点必须留下执行轨迹');
  });
}

test('两代在同一张自画流程上给出相同的业务结果', () => {
  const out = ['rule', 'llm'].map(stage => {
    const sc = mk(stage, fullFlowNodes());
    const s = session(sc);
    turn(sc, s, '我想了解一下', 'question');
    for (let i = 0; i < 4 && s.status === 'active'; i++) turn(sc, s, '我想分 5000 元');
    return { stage, end_reason: s.end_reason, amount: String(s.slots.amount), bill: s.slots.bill_queried };
  });
  assert.deepStrictEqual(out[0], Object.assign({}, out[1], { stage: 'rule' }));
});

/* ── 2. 节点链：to 必须被两代引擎跟随 ── */

for (const stage of ['rule', 'llm']) {
  test(`[${stage}] say.to 链式推进到下游节点（旧版 ruleStep 忽略 node.to）`, () => {
    const sc = mk(stage, [
      { id: 'a', type: 'say', text: '您好，本次通话将录音', to: 'b' },
      { id: 'b', type: 'end', end_reason: 'success', text: '再见' },
    ]);
    const s = session(sc);
    turn(sc, s, '嗯', 'affirm');
    assert.strictEqual(s.end_reason, 'success');
  });

  test(`[${stage}] say.to 指向意图静默路由器时，只推进指针、等下一轮输入`, () => {
    const sc = mk(stage, [
      { id: 'a', type: 'say', text: '您好，本次通话将录音', to: 'i' },
      { id: 'i', type: 'intent', candidates: [
        { intent: 'yes', keywords: ['好'], examples: ['好的', '可以'], to: 'ok' },
      ], fallback: { to: 'no' } },
      { id: 'ok', type: 'end', end_reason: 'success', text: '成功' },
      { id: 'no', type: 'end', end_reason: 'refused', text: '婉拒' },
    ]);
    const s = session(sc);
    assert.strictEqual(s.slots.__node, 'i', '开场后应停在意图节点');
    turn(sc, s, '好的', 'affirm');
    assert.strictEqual(s.end_reason, 'success');
  });
}

/* ── 3. 静默路由器：condition 到达即分流 ── */

for (const stage of ['rule', 'llm']) {
  test(`[${stage}] condition 节点不播报话术，按变量直接分流（含 else）`, () => {
    const sc = mk(stage, [
      { id: 'a', type: 'say', text: '您好，本次通话将录音', to: 'c' },
      { id: 'c', type: 'condition', conditions: [{ expr: 'amt30 > 10000', to: 'hi' }], elseTo: 'lo' },
      { id: 'hi', type: 'end', end_reason: 'success', text: '高' },
      { id: 'lo', type: 'end', end_reason: 'refused', text: '低' },
    ]);
    const s = session(sc);
    assert.strictEqual(s.end_reason, 'success', 'amt30=12000 应命中条件出口');
    assert.ok(s.trace.some(t => t.action === 'condition'));
  });
}

/* ── 4. 状态护栏 ── */

for (const stage of ['rule', 'llm']) {
  test(`[${stage}] slot 无去向时，抽取失败重试耗尽后必须收尾（不得无限重问）`, () => {
    const sc = mk(stage, [
      { id: 'a', type: 'slot', slot: 'amt', text: '您想分多少元？', patterns: ['(\\d+)元'], retry: '没听清' },
    ]);
    const s = session(sc);
    for (let i = 0; i < 8; i++) turn(sc, s, '');
    assert.notStrictEqual(s.status, 'active', '连续静音必须触发护栏');
    assert.strictEqual(s.end_reason, 'slot_exhausted');
  });

  test(`[${stage}] 不可逆工具必须经确认闸门：拒绝不执行、同意才执行`, () => {
    const build = () => mk(stage, [
      { id: 'a', type: 'tool', tool: 'register_benefit', ack: '已登记', to: 'ok' },
      { id: 'ok', type: 'end', end_reason: 'success', text: '完成' },
    ]);
    const declined = build();
    const sd = session(declined);
    turn(declined, sd, '不用了', 'deny');
    assert.strictEqual(sd.end_reason, 'tool_declined');
    assert.notStrictEqual(sd.slots.confirmed, true);

    const accepted = build();
    const sa = session(accepted);
    turn(accepted, sa, '可以', 'affirm');
    assert.strictEqual(sa.end_reason, 'success', '同意后应真正执行工具并沿 to 收尾');
    assert.strictEqual(sa.slots.confirmed, true);
    assert.ok(sa.trace.some(t => t.action === 'tool_call'));
  });
}

/* ── 5. 表达式求值器边界 ── */

test('条件表达式：未知变量一律保守为 false，不得靠取反绕成 true', () => {
  assert.strictEqual(D.evalConditionExpr('!unknownVar', { vars: {}, slots: {} }), false);
  assert.strictEqual(D.evalConditionExpr('unknownVar == 0', { vars: {}, slots: {} }), false);
});

test('条件表达式：尾部多余 token 不得被静默忽略', () => {
  assert.strictEqual(D.evalConditionExpr('amt30 > 100', { vars: { amt30: 12000 }, slots: {} }), true);
  assert.strictEqual(D.evalConditionExpr('amt30 > 100 garbageTail', { vars: { amt30: 12000 }, slots: {} }), false);
});

test('条件表达式：0 / false 是有效值，不得被 || 短路吞掉', () => {
  const sess = { vars: { zero: 0, no: false, yes: true }, slots: {} };
  assert.strictEqual(D.evalConditionExpr('zero == 0', sess), true);
  assert.strictEqual(D.evalConditionExpr('no == false', sess), true);
  assert.strictEqual(D.evalConditionExpr('no || yes', sess), true);
  assert.strictEqual(D.evalConditionExpr('zero > 5 && yes', sess), false);
});

/* ── 6. 自定义分支条件在真实 LLM 路径下可达 ── */

test('自定义中文 on 条件即使存在 unrecognized 兜底，也能被 LLM 判定命中', async () => {
  const sc = mk('llm', [
    { id: 'a', type: 'say', text: '费率是多少', branches: [
      { on: '客户生气或不耐烦', to: 'c' },
      { on: 'unrecognized', to: 'b' },
    ] },
    { id: 'b', type: 'end', end_reason: 'refused', text: '兜底' },
    { id: 'c', type: 'end', end_reason: 'success', text: '命中' },
  ]);
  const s = session(sc);
  const r = await D.stepSessionAsync(sc, s, { text: '你们烦不烦啊' });
  assert.strictEqual(s.end_reason, 'success', '自定义条件必须优先于兜底被判定');
  assert.strictEqual(r.text, '命中');
});

/* ── 7. 种子脚本基线：有限轮内必须收尾 ── */

test('两代预置话术流程都能在有限轮内收尾，不产生死循环', () => {
  const seeds = D.seedScripts();
  for (const id of ['SCR_RULE_001', 'SCR_LLM_001']) {
    const sc = seeds.find(x => x.id === id);
    assert.ok(sc, '缺少种子脚本 ' + id);
    const s = session(sc);
    for (const u of ['好的', '什么活动', '要收费吗', '帮我登记', '嗯', '可以', '就这样']) {
      if (s.status === 'active') turn(sc, s, u);
    }
    assert.ok(s.turn <= 7, id + ' 轮次异常：' + s.turn);
    assert.ok(s.trace.length > 0, id + ' 无执行轨迹');
  }
});

/* ── 8. 变量赋值节点（Voiceflow Set / Dify Variable Assigner 基线） ── */

afterEach(() => D.setScriptResolver(null));   // 模块级 resolver 不跨用例串味

test('脚本级变量声明注入会话，默认值按类型强制转换', () => {
  const sc = mk('rule', [{ id: 'a', type: 'say', text: '您好，本次通话将录音', to: 'b' },
    { id: 'b', type: 'end', end_reason: 'success', text: '再见' }],
  { variables: [
    { name: 'counter', type: 'number', default: '7' },
    { name: 'flag', type: 'boolean', default: 'true' },
    { name: 'tier', type: 'string', default: 'vip' },
  ] });
  const s = D.createSession(sc, CUSTOMER, { mode: 'manual' });
  assert.strictEqual(s.vars.counter, 7);
  assert.strictEqual(s.vars.flag, true);
  assert.strictEqual(s.vars.tier, 'vip');
  assert.strictEqual(s.vars.name, '王先生', '客户画像变量不得被声明覆盖');
});

for (const stage of ['rule', 'llm']) {
  test(`[${stage}] assign 静默执行、多条按序生效，支持全部运算符与模板插值`, () => {
    const sc = mk(stage, [
      { id: 'a', type: 'say', text: '您好，本次通话将录音', to: 'as' },
      { id: 'as', type: 'assign', assignments: [
        { key: 'n', op: 'set', value: '10' },
        { key: 'n', op: 'add', value: '5' },
        { key: 'n', op: 'mul', value: '2' },
        { key: 'copy_of_n', op: 'copy', value: 'n' },
        { key: 'txt', op: 'set', value: '您好${name}' },
        { key: 'txt', op: 'append', value: '！' },
        { key: 'flag', op: 'set', value: 'true' },
        { key: 'blank', op: 'set', value: 'x' },
        { key: 'blank', op: 'clear' },
      ], to: 'c' },
      { id: 'c', type: 'condition', conditions: [
        { expr: 'n == 30 && copy_of_n == 30 && flag == true && blank == \'\' && txt == \'您好王先生！\'', to: 'ok' },
      ], elseTo: 'bad' },
      { id: 'ok', type: 'end', end_reason: 'success', text: '成功' },
      { id: 'bad', type: 'end', end_reason: 'refused', text: '失败' },
    ], { variables: [{ name: 'n', type: 'number', default: 0 }] });
    const s = session(sc);
    assert.strictEqual(s.end_reason, 'success', '赋值结果必须能被条件节点读到');
    assert.strictEqual(s.vars.n, 30);
    assert.strictEqual(s.vars.txt, '您好王先生！');
    const acts = s.trace.filter(t => t.action === 'assign');
    assert.strictEqual(acts.length, 1, '一次到达只执行一次赋值块');
  });
}

test('assign 结果两代一致', () => {
  const out = ['rule', 'llm'].map(stage => {
    const sc = mk(stage, [
      { id: 'a', type: 'say', text: '您好，本次通话将录音', to: 'as' },
      { id: 'as', type: 'assign', assignments: [{ key: 'c', op: 'set', value: '3' }, { key: 'c', op: 'add', value: '1' }], to: 'e' },
      { id: 'e', type: 'end', end_reason: 'success', text: '完成' },
    ]);
    const s = session(sc);
    return { end: s.end_reason, c: s.vars.c };
  });
  assert.deepStrictEqual(out[0], out[1]);
});

/* ── 9. 子流程节点（Voiceflow Workflow step / Botpress Flow Stack 基线） ── */

function flowPair(stage) {
  const child = {
    id: 'SUB_CALC', name: '倍数计算', stage, version: 1,
    variables: [{ name: 'base', type: 'number', default: 0 }, { name: 'result', type: 'number', default: 0 }],
    nodes: [
      { id: 's_calc', type: 'assign', assignments: [
        { key: 'result', op: 'copy', value: 'base' },
        { key: 'result', op: 'mul', value: '2' },
      ], to: 's_end' },
      { id: 's_end', type: 'end', end_reason: 'verified', text: '（子流程结束语不播报）' },
    ],
  };
  const main = mk(stage, [
    { id: 'm_open', type: 'say', text: '您好，本次通话将录音', to: 'm_set' },
    { id: 'm_set', type: 'assign', assignments: [{ key: 'base', op: 'set', value: '21' }], to: 'm_flow' },
    { id: 'm_flow', type: 'flow', script_id: 'SUB_CALC',
      inputs: [{ key: 'base', value: '21' }],
      outputs: [{ key: 'child_result', from: 'result' }, { key: 'child_end', from: '$end_reason' }],
      to: 'm_check' },
    { id: 'm_check', type: 'condition',
      conditions: [{ expr: 'child_result == 42 && child_end == \'verified\'', to: 'm_ok' }], elseTo: 'm_bad' },
    { id: 'm_ok', type: 'end', end_reason: 'success', text: '成功' },
    { id: 'm_bad', type: 'end', end_reason: 'refused', text: '失败' },
  ], { id: 'MAIN_FLOW', variables: [{ name: 'child_result', type: 'number', default: 0 }, { name: 'child_end', type: 'string', default: '' }] });
  return { main, child };
}

for (const stage of ['rule', 'llm']) {
  test(`[${stage}] 子流程：入参 → 调用 → 出参 → 返回主流程继续`, () => {
    const { main, child } = flowPair(stage);
    D.setScriptResolver(id => id === 'SUB_CALC' ? child : (id === 'MAIN_FLOW' ? main : null));
    const s = session(main);
    for (let i = 0; i < 3 && s.status === 'active'; i++) turn(main, s, '嗯');
    assert.strictEqual(s.end_reason, 'success');
    assert.strictEqual(s.vars.child_result, 42);
    assert.strictEqual(s.vars.child_end, 'verified');
    assert.strictEqual((s.__flowStack || []).length, 0, '返回后调用栈必须清空');
    assert.ok(s.trace.some(t => t.action === 'flow_call'));
    assert.ok(s.trace.some(t => t.action === 'flow_return'));
    assert.ok(!s.history.some(h => /（子流程结束语不播报）/.test(h.text)), '子流程结束语不应播报');
  });
}

test('子流程跨轮：等待用户输入时调用栈保持不变，下一轮仍能正确返回', () => {
  const child = {
    id: 'SUB_ASK', name: '身份核验', stage: 'rule', version: 1, nodes: [
      { id: 's_ask', type: 'say', text: '请问是否本人？', branches: [
        { on: 'affirm', to: 's_end' }, { on: 'unrecognized', to: 's_end' },
      ] },
      { id: 's_end', type: 'end', end_reason: 'verified', text: '（不播报）' },
    ],
  };
  const main = mk('rule', [
    { id: 'm_open', type: 'say', text: '您好，本次通话将录音', to: 'm_flow' },
    { id: 'm_flow', type: 'flow', script_id: 'SUB_ASK',
      outputs: [{ key: 'verified', from: '$end_reason' }], to: 'm_after' },
    { id: 'm_after', type: 'say', text: '核验通过，介绍下活动', branches: [
      { on: 'affirm', to: 'm_ok' }, { on: 'unrecognized', to: 'm_ok' },
    ] },
    { id: 'm_ok', type: 'end', end_reason: 'success', text: '感谢接听' },
  ], { id: 'MAIN_ASK' });
  D.setScriptResolver(id => id === 'SUB_ASK' ? child : (id === 'MAIN_ASK' ? main : null));
  const s = session(main);
  assert.strictEqual(s.slots.__node, 's_ask', '开场即进入子流程并等待用户输入');
  const r1 = turn(main, s, '是的', 'affirm');
  assert.strictEqual(s.vars.verified, 'verified');
  assert.match(r1.text, /核验通过/, '返回主流程后必须播报主流程节点话术');
  assert.strictEqual((s.__flowStack || []).length, 0);
  turn(main, s, '好的', 'affirm');
  assert.strictEqual(s.end_reason, 'success');
});

test('子流程递归护栏：自调用 / 循环调用 / 深度上限都不得死循环', () => {
  const nodes = (target) => [
    { id: 'a', type: 'say', text: '您好，本次通话将录音', to: 'f' },
    { id: 'f', type: 'flow', script_id: target, to: 'ok' },
    { id: 'ok', type: 'end', end_reason: 'success', text: '完成' },
  ];
  const selfRef = mk('rule', nodes('SELF'), { id: 'SELF' });
  D.setScriptResolver(id => id === 'SELF' ? selfRef : null);
  const s1 = session(selfRef);
  for (let i = 0; i < 4 && s1.status === 'active'; i++) turn(selfRef, s1, '嗯');
  assert.strictEqual(s1.end_reason, 'flow_recursion');

  const A = mk('rule', nodes('B'), { id: 'A' });
  const B = mk('rule', nodes('A'), { id: 'B' });
  D.setScriptResolver(id => id === 'A' ? A : (id === 'B' ? B : null));
  const s2 = session(A);
  for (let i = 0; i < 6 && s2.status === 'active'; i++) turn(A, s2, '嗯');
  assert.ok(s2.status !== 'active', 'A→B→A 必须被护栏终止');
  assert.ok(['flow_recursion', 'flow_loop'].indexOf(s2.end_reason) !== -1, s2.end_reason);
});

test('子流程目标不存在时保守收尾，不抛异常、不留悬空栈', () => {
  const sc = mk('rule', [
    { id: 'a', type: 'say', text: '您好，本次通话将录音', to: 'f' },
    { id: 'f', type: 'flow', script_id: 'NOT_EXIST', to: 'ok' },
    { id: 'ok', type: 'end', end_reason: 'success', text: '完成' },
  ]);
  D.setScriptResolver(() => null);
  const s = session(sc);
  assert.strictEqual(s.end_reason, 'flow_target_missing');
  assert.strictEqual((s.__flowStack || []).length, 0);
});

test('校验器拦住画布能画但运行时跑不了的子流程/赋值配置', () => {
  const base = [
    { id: 'a', type: 'say', text: '您好，本次通话将录音', to: 'x' },
  ];
  const badAssign = mk('rule', base.concat([
    { id: 'x', type: 'assign', assignments: [{ key: '1bad', op: 'set', value: '1' }] },
  ]));
  const va = D.validateScript(badAssign);
  assert.ok(va.errors.some(e => /变量名不合法/.test(e)));
  assert.ok(va.errors.some(e => /执行后去/.test(e)));

  const badFlow = mk('rule', base.concat([
    { id: 'x', type: 'flow', script_id: 'MISSING', to: null },
  ]), { id: 'BAD_FLOW' });
  D.setScriptResolver(() => null);
  const vf = D.validateScript(badFlow);
  assert.ok(vf.errors.some(e => /返回后去/.test(e)));
  assert.ok(vf.warnings.some(w => /不可解析/.test(w)));

  const selfFlow = mk('rule', base.concat([
    { id: 'x', type: 'flow', script_id: 'BAD_SELF', to: 'a' },
  ]), { id: 'BAD_SELF' });
  const vs = D.validateScript(selfFlow);
  assert.ok(vs.errors.some(e => /不能调用自身/.test(e)));
});

/* ── 10. 并行分支（Dify Serial/Parallel Execution 基线） ──
   一通电话同时只能播报一句，所以并行 = fan-out 静默任务，不是多条话术并发。
   铁律：各分支从同一份进入快照启动、互相读不到对方新写的变量；
   汇聚点下游按 <branchId>.<key> 可读全部分支产出。 */
function parallelNodes() {
  return [
    { id: 'o', name: '开场', type: 'say', text: '您好，本次通话将录音，先帮您核验。', to: 'p' },
    { id: 'p', name: '并行核验', type: 'parallel', join: 'j', joinMode: 'all', maxSteps: 12,
      branches: [{ id: 'aa', name: '分支A', to: 'a1' }, { id: 'bb', name: '分支B', to: 'b1' }],
      outputs: [{ key: 'total', from: 'x', branch: 'aa' }] },
    { id: 'a1', name: '额度A', type: 'assign', assignments: [{ key: 'x', op: 'set', value: '42' }] },
    { id: 'b1', name: '额度B', type: 'assign', assignments: [
      { key: 'saw_other', op: 'copy', value: 'x' },   // 快照里没有 x → 隔离生效时为空
      { key: 'x', op: 'set', value: '7' }] },
    { id: 'j', name: '汇聚判定', type: 'condition',
      conditions: [{ expr: 'aa.x == 42 && bb.x == 7', to: 'e_ok' }], elseTo: 'e_bad' },
    { id: 'e_ok', name: '成功', type: 'end', end_reason: 'success', text: '汇聚 ${total} / ${aa.x} / ${bb.x}' },
    { id: 'e_bad', name: '失败', type: 'end', end_reason: 'refused', text: '汇聚读不到' },
  ];
}

for (const stage of ['rule', 'llm']) {
  test(`[${stage}] 并行分支：变量快照隔离、显式出参、汇聚点可读全部产出`, () => {
    const sc = mk(stage, parallelNodes());
    assert.deepStrictEqual(D.validateScript(sc).errors, [], '合法并行流程不该被校验器拦住');
    const s = session(sc);
    assert.strictEqual(s.end_reason, 'success', '汇聚条件应读到两条分支的产出');
    assert.strictEqual(s.vars.total, 42, '显式出参映射必须取指定分支的变量');
    assert.strictEqual(s.vars['aa.x'], 42);
    assert.strictEqual(s.vars['bb.x'], 7);
    assert.strictEqual(s.vars['bb.saw_other'], '', '分支B 不得读到分支A 新写的变量');
    assert.match(s.history[s.history.length - 1].text, /汇聚 42 \/ 42 \/ 7/, '话术要能插值带点变量名');
    assert.ok(s.trace.some(t => t.action === 'parallel_fork'));
    assert.ok(s.trace.some(t => t.action === 'parallel_join'));
  });
}

test('并行结果两代一致', () => {
  const out = ['rule', 'llm'].map(stage => {
    const s = session(mk(stage, parallelNodes()));
    return { end: s.end_reason, vars: JSON.stringify(s.vars), text: s.history[s.history.length - 1].text };
  });
  assert.deepStrictEqual(out[0], out[1]);
});

test('并行分支：joinMode=any 首个成功分支即汇聚，不再跑剩余分支', () => {
  const nodes = parallelNodes();
  nodes[1].joinMode = 'any';
  const s = session(mk('rule', nodes));
  const branches = s.trace.filter(t => t.action === 'parallel_branch');
  assert.strictEqual(branches.length, 1, 'any 模式只应执行一条分支');
  assert.strictEqual(s.end_reason, 'refused', '只读到一条分支时汇聚条件不成立，应走 else');
});

test('并行校验器：拦住交互节点 / 嵌套并行 / 缺汇聚 / 分支不足 / 分支内调子流程', () => {
  const bad = extra => {
    const nodes = parallelNodes();
    nodes.splice(extra.at, 0, extra.node);
    if (extra.mutate) extra.mutate(nodes);
    return D.validateScript(mk('rule', nodes)).errors;
  };
  assert.ok(bad({ at: 3, node: { id: 'talk', type: 'say', text: '不该播报' },
    mutate: ns => { ns.find(n => n.id === 'p').branches[0].to = 'talk'; } })
    .some(e => /含交互节点/.test(e)), '分支里的 say 必须被拦住');
  assert.ok(bad({ at: 3, node: { id: 'nested', type: 'parallel', join: 'j', branches: [{ id: 'x', to: 'a1' }, { id: 'y', to: 'b1' }] },
    mutate: ns => { ns.find(n => n.id === 'p').branches[0].to = 'nested'; } })
    .some(e => /禁止嵌套并行|含交互节点/.test(e)), '嵌套并行必须被拦住');
  const noJoin = parallelNodes(); delete noJoin[1].join; noJoin[1].to = null;
  assert.ok(D.validateScript(mk('rule', noJoin)).errors.some(e => /缺少有效汇聚节点/.test(e)));
  const one = parallelNodes(); one[1].branches = [{ id: 'aa', to: 'a1' }];
  assert.ok(D.validateScript(mk('rule', one)).errors.some(e => /至少需要 2 条分支/.test(e)));
  const sub = parallelNodes(); sub[2] = { id: 'a1', type: 'flow', script_id: 'OTHER', to: null };
  assert.ok(D.validateScript(mk('rule', sub)).errors.some(e => /不支持调用子流程|含交互节点/.test(e)));
});

test('并行分支链末端可以不配「执行后去」，不在链上的 assign 仍必须配', () => {
  const nodes = parallelNodes();
  assert.deepStrictEqual(D.validateScript(mk('rule', nodes)).errors, []);
  nodes.push({ id: 'orphan', type: 'assign', assignments: [{ key: 'z', op: 'set', value: '1' }] });
  assert.ok(D.validateScript(mk('rule', nodes)).errors.some(e => /orphan/.test(e) && /执行后去/.test(e)));
});

/* ── 11. 全局 handler（Dialogflow CX State handlers / Botpress Hooks） ── */
function waitNodes() {
  return [
    { id: 'q', name: '询问', type: 'say', text: '您好，本次通话将录音，需要办理吗？',
      branches: [{ on: 'affirm', to: 'ok' }, { on: 'unrecognized', to: 'q' }] },
    { id: 'ok', name: '办完', type: 'end', end_reason: 'success', text: '办好了，再见。' },
  ];
}

for (const stage of ['rule', 'llm']) {
  test(`[${stage}] 全局打断意图：任意节点优先命中，first-match 按 priority 降序`, () => {
    const sc = mk(stage, waitNodes(), { handlers: [
      { id: 'gh_low', event: 'intent', priority: 10, keywords: ['转人工'], text: '低优先级不该出现', end: true },
      { id: 'gh_hi', event: 'intent', priority: 100, keywords: ['转人工'],
        text: '好的，为您转接人工坐席，请稍候。', end: true, end_reason: 'handoff' },
    ] });
    assert.deepStrictEqual(D.validateScript(sc).errors, []);
    const s = session(sc);
    const r = turn(sc, s, '我要转人工');
    assert.strictEqual(r.text, '好的，为您转接人工坐席，请稍候。');
    assert.strictEqual(r.handoff, true);
    assert.strictEqual(s.end_reason, 'handoff');
    assert.strictEqual(s.history.filter(h => h.role === 'bot' && h.turn === s.turn).length, 1,
      '覆盖回复不得在 history 里留下两条 bot 消息');
  });
}

test('全局 handler：enabled=false 不生效；cooldownTurns 防抖；resume 不改当前节点', () => {
  const disabled = mk('rule', waitNodes(), { handlers: [
    { id: 'off', event: 'intent', keywords: ['转人工'], text: '不该出现', end: true, enabled: false }] });
  const s1 = session(disabled);
  assert.notStrictEqual(turn(disabled, s1, '转人工').text, '不该出现');

  const cooling = mk('rule', waitNodes(), { handlers: [
    { id: 'cool', event: 'intent', keywords: ['随便'], cooldownTurns: 3,
      text: '插话一次', resume: true, end: false }] });
  const s2 = session(cooling);
  turn(cooling, s2, '随便');
  assert.strictEqual(s2.slots.__node, 'q', 'resume 必须保持原节点');
  const cnt = (s2.slots.__ghCount || {}).cool || 0;
  turn(cooling, s2, '随便');
  assert.strictEqual((s2.slots.__ghCount || {}).cool, cnt, '冷却期内不得重复计数');

  const resumed = mk('rule', waitNodes(), { handlers: [
    { id: 'jump', event: 'intent', keywords: ['转人工'], to: 'ok', resume: false }] });
  const s3 = session(resumed);
  const r3 = turn(resumed, s3, '转人工');
  assert.strictEqual(s3.end_reason, 'success', '纯跳转 handler 应用 to 后继续走局部引擎');
  assert.ok(s3.trace.some(t => t.action === 'global_handler'), '静默跳转也要留下轨迹');
  assert.strictEqual(r3.text, '办好了，再见。');
});

test('全局 no_match / no_input：连续 N 次才触发，且能覆盖局部引擎的挂机', () => {
  const sc = mk('rule', waitNodes(), { handlers: [
    { id: 'nm', event: 'no_match', afterCount: 2, text: '没听清，为您转人工。', end: true, end_reason: 'handoff' },
    { id: 'ni', event: 'no_input', afterCount: 1, text: '听不到您说话，先挂了。', end: true, end_reason: 'no_input' },
  ] });
  assert.deepStrictEqual(D.validateScript(sc).errors, []);
  const s = session(sc);
  const r1 = turn(sc, s, '呃啊啊');
  assert.notStrictEqual(r1.text, '没听清，为您转人工。', '第 1 次不触发');
  const r2 = turn(sc, s, '呃啊啊');
  assert.strictEqual(r2.text, '没听清，为您转人工。');
  assert.strictEqual(s.end_reason, 'handoff', '全局 handler 必须能覆盖局部 unrecognized_x2 挂机');

  const s2 = session(sc);
  const q = turn(sc, s2, '');
  assert.strictEqual(q.text, '听不到您说话，先挂了。');
});

test('session_end 是生命周期副作用，不覆盖回复、不被 first-match 吞掉', () => {
  const sc = mk('rule', waitNodes(), { handlers: [
    { id: 'end_hook', event: 'session_end', name: '会话结束埋点' },
    { id: 'nm', event: 'no_match', afterCount: 1, text: '兜底', end: true },
  ] });
  const s = session(sc);
  const r = turn(sc, s, '呃啊啊');
  assert.strictEqual(r.text, '兜底');
  assert.ok(s.trace.some(t => t.action === 'global_handler_end'), '会话结束钩子必须执行');
});

test('第二代全局打断意图走真实 LLM，失败回落词表；注入标记用完即清', async () => {
  const sc = mk('llm', waitNodes(), { handlers: [
    { id: 'gh_llm', event: 'intent', priority: 50, examples: ['我要找真人'],
      keywords: [], text: 'LLM 判定转人工', end: true, end_reason: 'handoff' },
  ] });
  const s = session(sc);
  const r = await D.stepSessionAsync(sc, s, { text: '能不能换个真人来接' });
  assert.strictEqual(r.text, 'LLM 判定转人工', '词表没命中时应由 LLM 判定命中');
  assert.strictEqual(s.__realGlobalHandler, null, '注入标记必须清理，避免污染下一轮');

  const sc2 = mk('llm', waitNodes(), { handlers: [
    { id: 'gh_kw', event: 'intent', priority: 50, keywords: ['转人工'],
      text: '词表命中', end: true, end_reason: 'handoff' },
  ] });
  const s2 = session(sc2);
  const r2 = await D.stepSessionAsync(sc2, s2, { text: '我要转人工' });
  assert.strictEqual(r2.text, '词表命中', '没有 examples 时不调 LLM，纯词表命中');
});

test('全局 handler 校验器：拦住无效事件 / 无判据的打断意图 / 悬空跳转 / 重复 id', () => {
  const v = D.validateScript(mk('rule', waitNodes(), { handlers: [
    { id: 'bad_event', event: 'whatever' },
    { id: 'no_rule', event: 'intent' },
    { id: 'bad_to', event: 'no_match', to: 'NO_SUCH_NODE', text: 'x' },
    { id: 'bad_to', event: 'session_end' },
  ] }));
  assert.ok(v.errors.some(e => /事件类型无效/.test(e)));
  assert.ok(v.errors.some(e => /永远不会命中/.test(e)));
  assert.ok(v.errors.some(e => /指向不存在节点/.test(e)));
  assert.ok(v.errors.some(e => /id 重复/.test(e)));
});


