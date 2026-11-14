'use strict';

/**
 * 智能营销工作台 · 引擎契约测试
 *
 * 覆盖四类不可回归的约束：
 *  1. 数据确定性 —— 同一种子必须产出同一批客户与线索（前后端共享引擎，任何
 *     rnd() 调用顺序变化都会让线上指标与离线报表对不上）
 *  2. DSL 编译 —— 阈值/复杂度/权重/字段白名单四类校验必须拦得住
 *  3. 状态机 —— 非法迁移、跨级迁移、闸门拦截必须被拒绝，且给得出原因
 *  4. 统计口径 —— p 值与置信区间必须是真算的，不是写死的
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ENGINE_PATH = path.resolve(__dirname, '../tools/smart-marketing/engine.js');
const E = require(ENGINE_PATH);

/* ── 1. 数据确定性 ── */

test('数据集规模与引擎版本固定', () => {
  assert.strictEqual(E.CUSTOMERS.length, 6000);
  assert.strictEqual(E.LEADS.length, 240);
  assert.strictEqual(E.ENGINE_VERSION, '1.0.0');
});

test('同一进程内重复取数结果完全一致（纯函数，无隐式状态漂移）', () => {
  const a = E.datasetSummary();
  const b = E.datasetSummary();
  assert.deepStrictEqual(a.aggregate, b.aggregate);
  assert.deepStrictEqual(a.status_counts, b.status_counts);
});

test('重新加载模块（模拟服务重启）产出同一批线索', () => {
  delete require.cache[require.resolve(ENGINE_PATH)];
  const E2 = require(ENGINE_PATH);
  assert.strictEqual(E2.LEADS.length, E.LEADS.length);
  assert.strictEqual(E2.LEADS[0].id, E.LEADS[0].id);
  assert.strictEqual(E2.LEADS[0].xid, E.LEADS[0].xid);
  assert.strictEqual(E2.LEADS[0].score, E.LEADS[0].score);
  assert.strictEqual(E2.LEADS[239].id, E.LEADS[239].id);
  assert.deepStrictEqual(E2.aggregate(), E.aggregate());
});

test('线索 ID 唯一，且每条线索都能被 leadById 取到', () => {
  const ids = new Set(E.LEADS.map(l => l.id));
  assert.strictEqual(ids.size, E.LEADS.length);
  E.LEADS.forEach(l => assert.ok(E.leadById(l.id), '取不到 ' + l.id));
});

test('分组切分正确：实验组 + 对照组 = 全量', () => {
  const a = E.aggregate();
  assert.strictEqual(a.tSize + a.cSize, a.total);
  assert.strictEqual(a.cSize, Math.ceil(240 / 7));
});

/* ── 2. DSL 编译 ── */

test('默认 DSL 编译通过且命中数稳定', () => {
  const out = E.compile(E.DEFAULT_DSL);
  assert.strictEqual(out.ok, true, out.errs.join('; '));
  assert.strictEqual(out.metrics.hits, 425);
  assert.strictEqual(out.metrics.sampleTotal, 6000);
  assert.strictEqual(out.metrics.afterCap, Math.min(out.metrics.full, 50000));
  assert.strictEqual(out.dag.length, 6);
});

test('threshold 越界被拒', () => {
  const bad = E.DEFAULT_DSL.replace('threshold: 0.55', 'threshold: 1.4');
  const out = E.compile(bad);
  assert.strictEqual(out.ok, false);
  assert.ok(out.errs.some(e => e.includes('threshold')), out.errs.join('; '));
});

test('filter 超过 8 条被拒（复杂度上限）', () => {
  const extra = ['    - txnPrev >= 2', '    - txn30 >= 0', '    - amt30 >= 0', '    - days <= 90'].join('\n');
  const bad = E.DEFAULT_DSL.replace('  scoring:', extra + '\n  scoring:');
  const out = E.compile(bad);
  assert.strictEqual(out.ok, false);
  assert.ok(out.errs.some(e => e.includes('filters 最多 8 条')), out.errs.join('; '));
});

test('scoring 权重之和不为 1 被拒', () => {
  const bad = E.DEFAULT_DSL.replace('weight: 0.45', 'weight: 0.9');
  const out = E.compile(bad);
  assert.strictEqual(out.ok, false);
  assert.ok(out.errs.some(e => e.includes('权重之和')), out.errs.join('; '));
});

test('未知特征与未知字段都被拒（防止运行期静默返回空集）', () => {
  const bad = E.DEFAULT_DSL
    .replace('feature: dropRatio', 'feature: dropRatioX')
    .replace('txn30 <= txnPrev * 0.6', 'txn33 <= txnPrev * 0.6');
  const out = E.compile(bad);
  assert.strictEqual(out.ok, false);
  assert.ok(out.errs.some(e => e.includes('未知特征')));
  assert.ok(out.errs.some(e => e.includes('未知字段')));
  assert.ok(out.unknown_fields.includes('txn33'));
});

test('空 filters 被拒', () => {
  const lines = E.DEFAULT_DSL.split('\n').filter(l => !/^    - (txn30|amt30|days|not)/.test(l));
  const out = E.compile(lines.join('\n'));
  assert.strictEqual(out.ok, false);
  assert.ok(out.errs.some(e => e.includes('filters 不得为空')));
});

test('提高阈值后命中数单调下降', () => {
  const low = E.compile(E.DEFAULT_DSL.replace('threshold: 0.55', 'threshold: 0.50'));
  const high = E.compile(E.DEFAULT_DSL.replace('threshold: 0.55', 'threshold: 0.70'));
  assert.ok(high.metrics.hits <= low.metrics.hits, '阈值提高后命中数不应增加');
  assert.ok(high.metrics.hits >= 0);
});

test('注入了不存在的 filter 语法会返回空集而不是抛异常', () => {
  const bad = E.DEFAULT_DSL.replace('    - amt30 >= 500', '    - amt30 >= 500\n    - 乱七八糟的条件');
  const out = E.compile(bad);
  if (out.ok) {
    // 语法未识别但字段合法时，求值返回 false，命中数应为 0
    assert.strictEqual(out.metrics.hits, 0);
  } else {
    assert.ok(out.errs.length > 0);
  }
});

/* ── 3. 状态机 ── */

function findLead(pred) {
  return E.LEADS.filter(pred)[0];
}

test('非法迁移被拒绝并给出可达目标', () => {
  const l = findLead(x => x.status === '已下发');
  assert.ok(l, '缺少已下发线索');
  const r = E.setLeadStatus(l.id, '已下发');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'illegal_transition');
  assert.ok(r.error.includes('已触达'), '错误信息应列出可迁移目标');
});

test('跨级迁移被拒绝（已下发 → 已转化）', () => {
  const l = findLead(x => x.status === '已下发');
  const r = E.setLeadStatus(l.id, '已转化');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'illegal_transition');
});

test('已关闭是终态，不可再迁移', () => {
  const l = findLead(x => x.status === '已下发');
  const closed = E.setLeadStatus(l.id, '已关闭');
  assert.strictEqual(closed.ok, true);
  const again = E.setLeadStatus(l.id, '已下发');
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.code, 'illegal_transition');
  // 复原，避免影响后续用例
  l.status = '已下发';
});

test('存在闸门拦截的线索不可下发', () => {
  const blocked = findLead(x => x.status === '待指认' && E.gatesOf(x).some(g => !g.ok));
  if (!blocked) {
    // 数据集中若没有「待指认 + 被拦截」样本，用一条协商还款线索现场构造
    const anyBlocked = findLead(x => E.gatesOf(x).some(g => !g.ok));
    assert.ok(anyBlocked, '数据集中应至少有一条被拦截线索');
    const prev = anyBlocked.status;
    anyBlocked.status = '待指认';
    const r = E.setLeadStatus(anyBlocked.id, '已下发');
    anyBlocked.status = prev;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'gate_blocked');
    assert.ok(r.failed.length > 0);
    return;
  }
  const r = E.setLeadStatus(blocked.id, '已下发');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'gate_blocked');
  assert.deepStrictEqual(r.failed, ['G5']);
});

test('合法迁移会同步派生字段（contacted / responded / converted）', () => {
  const l = findLead(x => x.status === '待指认' && !E.gatesOf(x).some(g => !g.ok));
  assert.ok(l, '缺少可下发的待指认线索');
  const original = l.status;
  assert.strictEqual(E.setLeadStatus(l.id, '已下发').ok, true);
  assert.strictEqual(E.setLeadStatus(l.id, '已触达').ok, true);
  assert.strictEqual(l.contacted, true);
  assert.strictEqual(E.setLeadStatus(l.id, '已响应').ok, true);
  assert.strictEqual(l.responded, true);
  assert.strictEqual(E.setLeadStatus(l.id, '已转化').ok, true);
  assert.strictEqual(l.converted, true);
  // 复原
  l.status = original; l.contacted = false; l.responded = false; l.converted = false;
});

test('不存在的线索返回 not_found 而不是抛错', () => {
  const r = E.setLeadStatus('LD_NOT_EXIST', '已下发');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'not_found');
});

/* ── 4. 统计口径 ── */

test('p 值是真算的：完全相同的两组 p=1，差异极大的两组 p 趋近 0', () => {
  assert.strictEqual(E.pValue(0.5, 100, 0.5, 100), 1);
  const extreme = E.pValue(0.9, 5000, 0.1, 5000);
  assert.ok(extreme < 1e-10, '极大差异应给出近似 0 的 p 值，实际 ' + extreme);
});

test('p 值对称：交换两组结果不变', () => {
  const a = E.pValue(0.18, 800, 0.12, 300);
  const b = E.pValue(0.12, 300, 0.18, 800);
  assert.ok(Math.abs(a - b) < 1e-12);
});

test('Wilson 置信区间包含点估计且落在 [0,1]', () => {
  const [lo, hi] = E.wilson(60, 400);
  assert.ok(lo <= 0.15 && 0.15 <= hi);
  assert.ok(lo >= 0 && hi <= 1);
  assert.ok(hi - lo > 0);
});

test('30 天实验口径的样本量 = 单日 × 30，转化数四舍五入一致', () => {
  const a = E.aggregate();
  const ex = E.experiment(a);
  assert.strictEqual(ex.sampleT, a.tSize * 30);
  assert.strictEqual(ex.sampleC, a.cSize * 30);
  assert.strictEqual(ex.convT, Math.round(ex.sampleT * a.tConv));
  assert.ok(Math.abs(ex.uplift - a.inc) < 1e-9);
});

test('线索有效率的分母是有效触达，不是线索量', () => {
  const a = E.aggregate();
  assert.ok(Math.abs(a.effRate - a.conv / a.contacts) < 1e-12);
  assert.notStrictEqual(a.effRate, a.conv / a.total);
});

/* ── 5. 线索池查询 ── */

test('分页边界：越界页码夹到最后一页，不返回空数组', () => {
  const out = E.listLeads({ page: 9999, size: 20 });
  assert.strictEqual(out.page, out.pages);
  assert.ok(out.rows.length > 0);
});

test('筛选口径互不冲突：各筛选条数之和 = 全量（除 prio 维度外不重叠）', () => {
  const all = E.listLeads({ size: 200 }).total;
  const p1 = E.listLeads({ filter: '1', size: 200 }).total;
  const p2 = E.listLeads({ filter: '2', size: 200 }).total;
  const p3 = E.listLeads({ filter: '3', size: 200 }).total;
  assert.strictEqual(p1 + p2 + p3, all);
  const wait = E.listLeads({ filter: 'wait', size: 200 }).total;
  const done = E.listLeads({ filter: 'done', size: 200 }).total;
  assert.ok(wait + done <= all);
});

test('size 上限被夹到 200，避免一次拉全量拖垮服务', () => {
  assert.strictEqual(E.listLeads({ size: 100000 }).size, 200);
});

/* ── 6. 证据链与决策卡 ── */

test('每条线索的证据链都是 3 FACT + 2 DERIVED + 1 INFERRED', () => {
  const ev = E.evidenceOf(E.LEADS[0]);
  const count = ev.reduce((m, e) => (m[e.type] = (m[e.type] || 0) + 1, m), {});
  assert.deepStrictEqual(count, { FACT: 3, DERIVED: 2, INFERRED: 1 });
  ev.forEach(e => {
    assert.ok(e.conf > 0 && e.conf <= 1, '可信度必须在 (0,1]');
    assert.ok(e.src && e.conf_note, '证据必须带来源与可信度推导说明');
  });
});

test('决策卡结构固定，且合规结论来自闸门实算', () => {
  const l = E.LEADS[0];
  const card = E.decisionCardOf(l);
  ['lead_id', 'xid', 'priority', 'recommended_action', 'compliance_check', 'versions', 'valid_until']
    .forEach(k => assert.ok(k in card, '决策卡缺字段 ' + k));
  const blocked = E.gatesOf(l).filter(g => !g.ok);
  assert.strictEqual(card.compliance_check.passed, blocked.length === 0);
  assert.deepStrictEqual(card.compliance_check.failed_rules, blocked.map(g => g.id));
});

test('闸门 G1 对禁呼名单与投诉静默期同时生效', () => {
  const withComplaint = Object.assign({}, E.LEADS[0], { risk: ['90 天内有投诉'] });
  const withBlack = Object.assign({}, E.LEADS[0], { risk: ['禁呼名单'] });
  assert.strictEqual(E.gatesOf(withComplaint)[0].ok, false);
  assert.strictEqual(E.gatesOf(withBlack)[0].ok, false);
  assert.strictEqual(E.gatesOf(Object.assign({}, E.LEADS[0], { risk: [] }))[0].ok, true);
});

test('闸门 G5 对协商还款中客户判不匹配', () => {
  const g = E.gatesOf(Object.assign({}, E.LEADS[0], { risk: ['协商还款中'] }));
  assert.strictEqual(g[4].ok, false);
});

test('闸门上下文可选：频控与时段由调用方传入，缺省视为通过', () => {
  const l = Object.assign({}, E.LEADS[0], { risk: [] });
  assert.strictEqual(E.gatesOf(l, { frequency_exceeded: true })[1].ok, false);
  assert.strictEqual(E.gatesOf(l, { quiet_hours_blocked: true })[2].ok, false);
  assert.strictEqual(E.gatesOf(l, { template_not_whitelisted: true })[5].ok, false);
  assert.strictEqual(E.gatesOf(l)[1].ok, true);
});

/* ── 7. 算子可解释性 ── */

test('可解释性为 NONE 的算子被标记不得进入对客场景', () => {
  const none = E.OPS.filter(o => o.e === 'NONE');
  assert.ok(none.length > 0);
  none.forEach(o => {
    assert.ok(E.opMeta(o).rule.includes('不得进入任何对客场景'), o.id);
  });
});

test('算子元数据字段齐全（可注册）', () => {
  E.OPS.forEach(o => {
    const m = E.opMeta(o);
    ['op_id', 'input_contract', 'output_contract', 'explainability_level',
      'compliance_level', 'last_backtest_date', 'status'].forEach(k => {
      assert.ok(k in m, o.id + ' 缺字段 ' + k);
    });
  });
});
