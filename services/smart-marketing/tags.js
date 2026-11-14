/**
 * 标签体系（Tag Service）
 *
 * 设计依据（银行同业实践）：
 *   - 标签分四类：基础类（直接取自数仓）、统计类（聚合加工）、规则类（业务口径判定）、
 *     模型预测类（分类/回归/聚类产出）。本文件按 BASE / STAT / RULE / PREDICT 四类登记。
 *   - 每个标签必须带「血缘」（依赖哪些原始字段）+「口径」（可读判定条件），
 *     否则标签无法审计、无法解释、无法下线——这是同业标签平台最常见的失败点。
 *   - 标签是「服务」不是「表」：营销定义 DSL 里引用的字段，应能追溯到标签或原始字段。
 *
 * 重要边界：PREDICT 类标签在本系统用确定性打分函数实现，属于「规则化的预测标签」，
 * 不是训练出来的模型。接口返回里 model_kind 会标明 builtin_score，避免把打分说成模型。
 */

'use strict';

const VERSION = 'tag-2026-11-v1';

/* ─────────── 标签定义 ───────────
 * compute(c, ctx) 返回 { value, band?, score? }；value 为展示值。
 * lineage 列出依赖的客户字段，用于血缘追溯。
 */
const TAGS = [
  /* ── 基础属性（BASE）：直接来自源系统，不加工 ── */
  {
    id: 'T_TIER', name: '卡等级', group: '基础属性', type: 'BASE', dtype: 'enum',
    rule: '取信用卡当前卡等级', lineage: ['tier'],
    compute: c => ({ value: c.tier || '未知' }),
  },
  {
    id: 'T_TENURE_BAND', name: '账龄分层', group: '基础属性', type: 'BASE', dtype: 'enum',
    rule: '持卡月数：<12 新客 / 12–36 成长期 / 36–72 成熟期 / ≥72 忠诚期', lineage: ['tenure'],
    compute: c => {
      const t = Number(c.tenure) || 0;
      const band = t < 12 ? '新客' : t < 36 ? '成长期' : t < 72 ? '成熟期' : '忠诚期';
      return { value: band, note: `持卡 ${t} 个月` };
    },
  },
  {
    id: 'T_LIMIT_BAND', name: '额度分层', group: '基础属性', type: 'BASE', dtype: 'enum',
    rule: '信用额度：<2万 低 / 2–5万 中 / 5–10万 高 / ≥10万 超高', lineage: ['limit'],
    compute: c => {
      const l = Number(c.limit) || 0;
      const band = l < 20000 ? '低额度' : l < 50000 ? '中额度' : l < 100000 ? '高额度' : '超高额度';
      return { value: band, note: `额度 ${Math.round(l / 1000)}k` };
    },
  },
  {
    id: 'T_CHANNEL_PREF', name: '渠道偏好', group: '基础属性', type: 'BASE', dtype: 'enum',
    rule: '历史响应最好的触达渠道', lineage: ['channelPref'],
    compute: c => ({ value: c.channelPref || '短信' }),
  },

  /* ── 交易行为（STAT / RULE）：聚合与业务口径判定 ── */
  {
    id: 'T_TXN30', name: '近 30 天交易笔数', group: '交易行为', type: 'STAT', dtype: 'number',
    rule: '统计窗口内成功交易笔数之和', lineage: ['txn30'],
    compute: c => ({ value: Number(c.txn30) || 0 }),
  },
  {
    id: 'T_AMT30', name: '近 30 天交易金额', group: '交易行为', type: 'STAT', dtype: 'number',
    rule: '统计窗口内成功交易金额之和', lineage: ['amt30'],
    compute: c => ({ value: Number(c.amt30) || 0 }),
  },
  {
    id: 'T_AVG_TICKET', name: '笔均金额', group: '交易行为', type: 'STAT', dtype: 'number',
    rule: '近 30 天交易金额 ÷ 近 30 天交易笔数（笔数为 0 时不计算）', lineage: ['amt30', 'txn30'],
    compute: c => {
      const n = Number(c.txn30) || 0;
      if (!n) return { value: null, note: '笔数为 0，不计算' };
      return { value: Math.round((Number(c.amt30) || 0) / n) };
    },
  },
  {
    id: 'T_DROP', name: '消费降幅', group: '交易行为', type: 'STAT', dtype: 'percent',
    rule: '1 − 近 30 天笔数 ÷ 前 30 天笔数', lineage: ['txn30', 'txnPrev'],
    compute: c => {
      const prev = Number(c.txnPrev) || 0;
      if (!prev) return { value: null, note: '上期无交易，不计算' };
      const v = Math.max(0, Math.min(1, 1 - (Number(c.txn30) || 0) / prev));
      return { value: +v.toFixed(3) };
    },
  },
  {
    id: 'T_ACTIVE_DROP', name: '消费活跃度下降', group: '交易行为', type: 'RULE', dtype: 'boolean',
    rule: '上期笔数 ≥3 且 降幅 ≥40%', lineage: ['txnPrev', 'txn30', 'drop'],
    compute: c => {
      const prev = Number(c.txnPrev) || 0;
      const drop = prev ? 1 - (Number(c.txn30) || 0) / prev : 0;
      return { value: prev >= 3 && drop >= 0.4, note: `上期 ${prev} 笔，降幅 ${(drop * 100).toFixed(0)}%` };
    },
  },
  {
    id: 'T_DORMANT', name: '疑似沉睡', group: '交易行为', type: 'RULE', dtype: 'boolean',
    rule: '距最后交易日 ≥30 天', lineage: ['days'],
    compute: c => ({ value: (Number(c.days) || 0) >= 30, note: `距上次交易 ${c.days} 天` }),
  },
  {
    id: 'T_APP_ACTIVE', name: 'APP 活跃', group: '交易行为', type: 'RULE', dtype: 'boolean',
    rule: '近 30 天 APP 打开 ≥8 次', lineage: ['inApp30'],
    compute: c => ({ value: (Number(c.inApp30) || 0) >= 8, note: `打开 ${c.inApp30} 次` }),
  },
  {
    id: 'T_HIGH_FREQ', name: '高频用卡', group: '交易行为', type: 'RULE', dtype: 'boolean',
    rule: '近 30 天交易 ≥10 笔', lineage: ['txn30'],
    compute: c => ({ value: (Number(c.txn30) || 0) >= 10 }),
  },

  /* ── 价值贡献（STAT / RULE）── */
  {
    id: 'T_VALUE', name: '客户价值分', group: '价值贡献', type: 'STAT', dtype: 'number',
    rule: '综合贡献度评分（0–1，含交易、额度、账龄）', lineage: ['value'],
    compute: c => ({ value: +Number(c.value || 0).toFixed(3) }),
  },
  {
    id: 'T_VALUE_BAND', name: '价值分层', group: '价值贡献', type: 'RULE', dtype: 'enum',
    rule: '价值分 ≥0.7 高价值 / 0.4–0.7 中价值 / <0.4 长尾', lineage: ['value'],
    compute: c => {
      const v = Number(c.value) || 0;
      return { value: v >= 0.7 ? '高价值' : v >= 0.4 ? '中价值' : '长尾' };
    },
  },
  {
    id: 'T_LIMIT_UTIL', name: '额度使用率', group: '价值贡献', type: 'STAT', dtype: 'percent',
    rule: '近 30 天交易金额 ÷ 信用额度', lineage: ['amt30', 'limit'],
    compute: c => {
      const l = Number(c.limit) || 0;
      if (!l) return { value: null, note: '额度为 0，不计算' };
      return { value: +Math.min(1, (Number(c.amt30) || 0) / l).toFixed(3) };
    },
  },

  /* ── 模型预测（PREDICT）：确定性打分，标注 builtin_score ── */
  {
    id: 'T_CHURN_RISK', name: '流失风险分', group: '模型预测', type: 'PREDICT', dtype: 'number',
    rule: '0.6×消费降幅 + 0.3×静默天数归一 + 0.1×(1−APP 活跃归一)，取值 0–1',
    lineage: ['txn30', 'txnPrev', 'days', 'inApp30'],
    compute: c => {
      const prev = Number(c.txnPrev) || 0;
      const drop = prev ? Math.min(1, Math.max(0, 1 - (Number(c.txn30) || 0) / prev)) : 0;
      const silent = Math.min(1, (Number(c.days) || 0) / 60);
      const inactive = 1 - Math.min(1, (Number(c.inApp30) || 0) / 20);
      return { value: +(0.6 * drop + 0.3 * silent + 0.1 * inactive).toFixed(3) };
    },
  },
  {
    id: 'T_CHURN_LEVEL', name: '流失风险等级', group: '模型预测', type: 'PREDICT', dtype: 'enum',
    rule: '流失风险分 ≥0.6 高 / 0.35–0.6 中 / <0.35 低', lineage: ['churn_risk'],
    compute: c => {
      const prev = Number(c.txnPrev) || 0;
      const drop = prev ? Math.min(1, Math.max(0, 1 - (Number(c.txn30) || 0) / prev)) : 0;
      const silent = Math.min(1, (Number(c.days) || 0) / 60);
      const inactive = 1 - Math.min(1, (Number(c.inApp30) || 0) / 20);
      const s = 0.6 * drop + 0.3 * silent + 0.1 * inactive;
      return { value: s >= 0.6 ? '高' : s >= 0.35 ? '中' : '低', note: `风险分 ${s.toFixed(2)}` };
    },
  },
  {
    id: 'T_RESPONSE', name: '响应倾向分', group: '模型预测', type: 'PREDICT', dtype: 'number',
    rule: '0.5×APP 活跃归一 + 0.3×渠道偏好权重 + 0.2×(1−触达疲劳)',
    lineage: ['inApp30', 'channelPref'],
    compute: c => {
      const app = Math.min(1, (Number(c.inApp30) || 0) / 20);
      const chW = c.channelPref === 'APP推送' ? 1 : c.channelPref === '短信' ? 0.8 : 0.6;
      return { value: +(0.5 * app + 0.3 * chW + 0.2 * 0.8).toFixed(3) };
    },
  },
  {
    id: 'T_UPSELL', name: '提额潜力分', group: '模型预测', type: 'PREDICT', dtype: 'number',
    rule: '0.4×价值归一 + 0.3×额度使用率 + 0.3×账龄归一',
    lineage: ['value', 'limit', 'amt30', 'tenure'],
    compute: c => {
      const val = Math.min(1, Number(c.value) || 0);
      const util = Math.min(1, (Number(c.amt30) || 0) / Math.max(1, Number(c.limit) || 1));
      const ten = Math.min(1, (Number(c.tenure) || 0) / 120);
      return { value: +(0.4 * val + 0.3 * util + 0.3 * ten).toFixed(3) };
    },
  },
  {
    id: 'T_COMPLAINT_RISK', name: '投诉倾向', group: '模型预测', type: 'PREDICT', dtype: 'boolean',
    rule: '历史投诉标记或协商还款标记为真', lineage: ['complaint', 'negotiation'],
    compute: c => ({ value: !!(c.complaint || c.negotiation), note: c.complaint ? '有历史投诉' : c.negotiation ? '协商还款中' : '' }),
  },
  {
    id: 'T_REACHABLE', name: '是否可触达', group: '模型预测', type: 'PREDICT', dtype: 'boolean',
    rule: '非禁呼名单且非协商还款客户', lineage: ['blacklist', 'negotiation'],
    compute: c => ({ value: !(c.blacklist || c.negotiation), note: c.blacklist ? '在禁呼名单' : '' }),
  },
];

/* ─────────── 计算 ─────────── */

/** 把字段名归一成标签血缘里用的中文/字段名 */
function lineageLabel(f) {
  return f;
}

/** 计算单个客户的全部标签 */
function computeTags(customer) {
  const out = [];
  for (const t of TAGS) {
    let r;
    try { r = t.compute(customer) || {}; } catch (e) { r = { value: null, note: '计算异常：' + e.message }; }
    out.push({
      id: t.id, name: t.name, group: t.group, type: t.type, dtype: t.dtype,
      rule: t.rule, lineage: t.lineage, version: VERSION,
      value: r.value === undefined ? null : r.value,
      note: r.note || '',
    });
  }
  return out;
}

/** 按分组归集，供画像页直接渲染 */
function groupTags(tags) {
  const groups = [];
  const order = ['基础属性', '交易行为', '价值贡献', '模型预测'];
  for (const g of order) {
    const items = tags.filter(t => t.group === g);
    if (items.length) groups.push({ group: g, items });
  }
  return groups;
}

/** 标签目录 + 覆盖率（覆盖率是标签治理的核心指标：没人用的标签该下线） */
function catalog(customers) {
  const list = customers || [];
  const total = list.length || 1;
  const stats = {};
  TAGS.forEach(t => { stats[t.id] = { filled: 0, hit: 0 }; });
  list.forEach(c => {
    for (const t of TAGS) {
      const r = t.compute(c) || {};
      const s = stats[t.id];
      if (r.value !== null && r.value !== undefined) s.filled++;
      if (r.value === true) s.hit++;
    }
  });
  const groups = {};
  TAGS.forEach(t => {
    const s = stats[t.id];
    const g = groups[t.group] || (groups[t.group] = []);
    g.push({
      id: t.id, name: t.name, group: t.group, type: t.type, dtype: t.dtype,
      rule: t.rule, lineage: t.lineage, version: VERSION,
      coverage: s.filled, coverage_pct: +(s.filled / total * 100).toFixed(1),
      hit: s.hit, hit_pct: +(s.hit / total * 100).toFixed(1),
    });
  });
  return {
    version: VERSION,
    total_customers: list.length,
    count: TAGS.length,
    groups: order(groups),
    items: order(groups),
    model_kind: 'builtin_score',
    note: '预测类标签为确定性打分函数，非训练模型；上线前需用历史样本回测校准',
  };
}

function order(g) {
  const seq = ['基础属性', '交易行为', '价值贡献', '模型预测'];
  return Object.keys(g).sort((a, b) => seq.indexOf(a) - seq.indexOf(b)).map(k => ({ group: k, items: g[k] }));
}

/* ─────────── 画像雷达 ───────────
 * 雷达图六个维度全部由标签口径推导（与标签共用同一字段来源，可回溯），
 * 归一规则显式写死在 desc 里，避免「图上是个什么数」无法解释。
 */
const RADAR_DIMS = [
  { key: 'txn', label: '交易活跃', desc: '近 30 天交易笔数 ÷ 20（≥20 笔记满分），对应标签 T_TXN30 / T_HIGH_FREQ' },
  { key: 'util', label: '消费动能', desc: '近 30 天交易金额 ÷ 信用额度，即额度使用率（封顶 1），对应标签 T_LIMIT_UTIL' },
  { key: 'value', label: '价值贡献', desc: '客户价值分（0–1），对应标签 T_VALUE / T_VALUE_BAND' },
  { key: 'app', label: '渠道活跃', desc: '近 30 天 APP 打开次数 ÷ 20（≥20 次记满分），对应标签 T_APP_ACTIVE' },
  { key: 'tenure', label: '账龄成熟', desc: '持卡月数 ÷ 120（≥10 年记满分），对应标签 T_TENURE_BAND' },
  { key: 'stable', label: '稳健度', desc: '1 − 流失风险分，对应标签 T_CHURN_RISK / T_CHURN_LEVEL' },
];

/** 单客户六个雷达维度的归一得分（0–1） */
function radarScores(c) {
  const clamp = v => Math.max(0, Math.min(1, Number(v) || 0));
  const churnTag = TAGS.find(t => t.id === 'T_CHURN_RISK');
  const churn = Number((churnTag.compute(c) || {}).value) || 0;
  return {
    txn: clamp((Number(c.txn30) || 0) / 20),
    util: clamp((Number(c.amt30) || 0) / Math.max(1, Number(c.limit) || 0)),
    value: clamp(Number(c.value) || 0),
    app: clamp((Number(c.inApp30) || 0) / 20),
    tenure: clamp((Number(c.tenure) || 0) / 120),
    stable: clamp(1 - churn),
  };
}

/**
 * 雷达 + 同群基准：客户自身得分 vs 全量客户均值与分位。
 * peers 传入当前生效数据集的全量客户（画像页用 currentCustomers()），
 * 分位 = 全量中「≤ 该客户得分」的比例，分母不含客户本人。
 */
function radarProfile(customer, peers) {
  const mine = radarScores(customer);
  const others = (peers || []).filter(o => o.xid !== customer.xid);
  const dims = RADAR_DIMS.map(d => {
    const item = { key: d.key, label: d.label, desc: d.desc, value: +mine[d.key].toFixed(3), mean: null, pct: null };
    if (others.length) {
      let sum = 0, le = 0;
      for (const o of others) {
        const v = radarScores(o)[d.key];
        sum += v;
        if (v <= mine[d.key]) le++;
      }
      item.mean = +(sum / others.length).toFixed(3);
      item.pct = Math.round(le / others.length * 100);
    }
    return item;
  });
  return { dims, peer_count: others.length };
}

/** 单客户画像「一页纸」：现状—趋势—需求—建议—风险，全部由标签推导，可回溯 */
function profileOf(customer, peers) {
  const tags = computeTags(customer);
  const get = id => (tags.find(t => t.id === id) || {}).value;
  const note = id => (tags.find(t => t.id === id) || {}).note || '';
  const c = customer;
  const drop = Number(get('T_DROP')) || 0;
  const churn = Number(get('T_CHURN_RISK')) || 0;

  const cur = [
    `${get('T_TIER')} 客户，持卡 ${c.tenure} 个月（${get('T_TENURE_BAND')}），额度 ${Math.round((c.limit || 0) / 1000)}k。`,
    `近 30 天交易 ${c.txn30} 笔 / ${Math.round(c.amt30)} 元，笔均 ${get('T_AVG_TICKET') || '—'} 元，额度使用率 ${((get('T_LIMIT_UTIL') || 0) * 100).toFixed(1)}%。`,
    `距最后交易日 ${c.days} 天，近 30 天 APP 打开 ${c.inApp30} 次。`,
  ];

  const trend = [
    `消费笔数由前 30 天的 ${c.txnPrev} 笔变为 ${c.txn30} 笔，${drop > 0 ? `降幅 ${(drop * 100).toFixed(0)}%` : '未下降'}。`,
    get('T_ACTIVE_DROP') ? '命中「消费活跃度下降」规则标签。' : '未命中消费下滑规则。',
    get('T_APP_ACTIVE') ? 'APP 仍活跃，属「有需求未转化」而非单纯流失。' : 'APP 活跃度同步走低，流失前兆特征明显。',
  ];

  const need = [];
  if (churn >= 0.6) need.push('首要需求是挽留：以低门槛权益唤回交易，避免直接降价损伤价值。');
  else if (get('T_HIGH_FREQ')) need.push('高频用卡客户，需求偏向权益升级与积分加速。');
  else need.push('常规经营需求，适合场景化权益拉动频次。');
  if ((get('T_UPSELL') || 0) >= 0.6) need.push(`提额潜力分 ${get('T_UPSELL')}，可纳入额度提升名单。`);
  if ((get('T_LIMIT_UTIL') || 0) >= 0.6) need.push('额度使用率高，存在分期或临时额度需求。');

  const act = [
    `渠道：${get('T_CHANNEL_PREF')}（响应倾向分 ${get('T_RESPONSE')}）。`,
    `动作：${churn >= 0.6 ? '挽留型权益 + 短周期二次触达' : get('T_HIGH_FREQ') ? '权益升级推荐' : '场景化消费券'}。`,
    `频控：单客每月不超过 2 次，触达计入频控额度。`,
  ];

  const risk = [];
  if (get('T_COMPLAINT_RISK')) risk.push(`投诉倾向：${note('T_COMPLAINT_RISK') || '有投诉或协商记录'}，须人工复核话术。`);
  if (!get('T_REACHABLE')) risk.push(`不可触达：${note('T_REACHABLE') || '禁呼名单或协商还款'}。`);
  if (!risk.length) risk.push('无禁呼、投诉、协商记录，闸门预检通过。');
  if (get('T_DORMANT')) risk.push('疑似沉睡客户，唤醒成本高于常规客户，需评估投入产出。');

  return {
    xid: c.xid,
    name: c.name,
    generated_from: 'TAG_RULES',
    /* 行为对照图需要的原始字段（只暴露展示用字段，不带黑名单等敏感位） */
    fields: {
      tier: c.tier, tenure: c.tenure, limit: c.limit, value: c.value,
      txn30: c.txn30, txnPrev: c.txnPrev, amt30: c.amt30,
      days: c.days, inApp30: c.inApp30, channelPref: c.channelPref,
    },
    tags,
    groups: groupTags(tags),
    radar: radarProfile(c, peers),
    one_pager: [
      { key: '现状', items: cur },
      { key: '趋势', items: trend },
      { key: '需求', items: need },
      { key: '建议', items: act },
      { key: '风险', items: risk },
    ],
  };
}

module.exports = {
  VERSION, TAGS, computeTags, groupTags, catalog, profileOf, lineageLabel,
  RADAR_DIMS, radarScores, radarProfile,
};
