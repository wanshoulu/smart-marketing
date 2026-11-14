/**
 * 智能营销工作台 · 共享计算引擎
 *
 * 设计约束（很重要，改代码前先读）：
 * 1. 本文件同时被 Node 服务端（routes/smart-marketing-api.js）与浏览器前端
 *    （tools/smart-marketing/index.html）加载，因此**不得引用任何 Node 内置模块，
 *    也不得触碰 document / window**。纯函数 + 内存状态。
 * 2. 模拟数据由单一种子（20261104）驱动的伪随机序列生成，rnd() 的**调用顺序**
 *    决定了数据内容。新增任何 rnd() 调用都会让全部客户与线索重排，
 *    进而让前后端已经比对过的指标失真。若必须改，需同步升 ENGINE_VERSION
 *    并重跑一致性测试。
 * 3. 服务端为权威计算方；前端保留同一份引擎仅用于 API 不可达时的降级演示，
 *    两侧结果必须逐字段一致。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SMEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ENGINE_VERSION = '1.0.0';
  var DATA_SEED = 20261104;

  /* ============ 0. 基础工具 ============ */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  var rnd = mulberry32(DATA_SEED);
  var pick = function (arr) { return arr[Math.floor(rnd() * arr.length)]; };
  var gauss = function (m, s) {
    var u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return m + s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  var fmt = function (n) { return Number(n).toLocaleString('zh-CN'); };
  var pct = function (n, d) { return (n * 100).toFixed(d === undefined ? 1 : d) + '%'; };
  var money = function (n) { return '¥' + Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 0 }); };

  /* ============ 1. 模拟客户 ============ */
  var SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡林郭何高罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤'.split('');
  var TIERS = [
    { n: '普卡', w: 46, lim: [8000, 30000] },
    { n: '金卡', w: 32, lim: [30000, 80000] },
    { n: '白金', w: 16, lim: [80000, 200000] },
    { n: '钻石', w: 6, lim: [200000, 500000] }
  ];
  var CHANNELS = ['APP 推送', '短信', '智能外呼', '人工外呼'];
  var STATUSES = ['待指认', '已下发', '已触达', '已响应', '已转化', '已关闭'];

  function pickTier() {
    var r = rnd() * 100, acc = 0;
    for (var i = 0; i < TIERS.length; i++) {
      acc += TIERS[i].w;
      if (r <= acc) return TIERS[i];
    }
    return TIERS[0];
  }
  function maskName(s) { return s + '**'; }

  var CUSTOMERS = [];
  for (var ci = 0; ci < 6000; ci++) {
    var tier = pickTier();
    var tenure = Math.max(3, Math.round(gauss(58, 34)));
    var value = Math.min(0.99, Math.max(0.02, gauss(0.42, 0.21)));
    var active = rnd() < 0.72;
    var txnPrev, txn30, amt30, days;
    if (active) {
      txnPrev = Math.max(2, Math.round(gauss(13, 6)));
      txn30 = Math.max(0, Math.round(txnPrev * gauss(0.82, 0.22)));
      amt30 = Math.max(0, Math.round(txn30 * gauss(320, 180)));
      days = Math.round(gauss(11, 7));
    } else {
      txnPrev = Math.max(2, Math.round(gauss(11, 5)));
      txn30 = Math.max(0, Math.round(txnPrev * gauss(0.38, 0.18)));
      amt30 = Math.max(0, Math.round(txn30 * gauss(260, 150)));
      days = Math.round(gauss(34, 14));
    }
    CUSTOMERS.push({
      idx: ci,
      xid: 'XID' + (7400000 + ci * 37).toString(36).toUpperCase(),
      name: maskName(pick(SURNAMES)),
      tier: tier.n,
      limit: Math.round(tier.lim[0] + rnd() * (tier.lim[1] - tier.lim[0])),
      tenure: tenure,
      value: +value.toFixed(3),
      txnPrev: txnPrev, txn30: txn30, amt30: amt30,
      days: Math.max(1, days),
      channelPref: pick(CHANNELS),
      complaint: rnd() < 0.035,
      blacklist: rnd() < 0.012,
      negotiation: rnd() < 0.018,
      inApp30: Math.round(rnd() * 22)
    });
  }

  /* ============ 2. DSL 解析与执行 ============ */
  var DEFAULT_DSL = [
    'lead_def:',
    '  id: LD_ACTIVE_DROP_001',
    '  name: 消费活跃度下降',
    '  version: 3',
    '  owner: 零售经营部',
    '  scope:',
    '    segment: ACTIVE_CARDHOLDER',
    '    universe_filter: [txnPrev >= 3]',
    '  trigger:',
    '    mode: batch',
    '    schedule: "0 4 * * *"',
    '  filters:',
    '    - txn30 <= txnPrev * 0.6',
    '    - amt30 >= 500',
    '    - days between 15 and 60',
    '    - not in_list: BLACKLIST_2026',
    '    - not has_event: COMPLAINT_90D',
    '  scoring:',
    '    - feature: dropRatio, weight: 0.45',
    '    - feature: value, weight: 0.4',
    '    - feature: channelMatch, weight: 0.15',
    '  threshold: 0.55',
    '  cooldown_days: 30',
    '  action:',
    '    type: CARE_CONTACT',
    '    channel_priority: [APP_PUSH, SMS, OUTBOUND]',
    '    template_id: TPL_CARE_003',
    '  guardrail:',
    '    max_daily_volume: 50000',
    '    frequency_cap: 1_per_30d',
    '    quiet_hours: ["22:00-08:00"]'
  ].join('\n');

  var FEATURES = {
    dropRatio: function (c) { return Math.min(1, Math.max(0, 1 - (c.txn30 / Math.max(1, c.txnPrev)))); },
    value: function (c) { return c.value; },
    tenure: function (c) { return Math.min(1, c.tenure / 120); },
    channelMatch: function (c) { return c.channelPref === 'APP 推送' ? 0.9 : c.channelPref === '短信' ? 0.7 : 0.6; }
  };

  var FIELD_WHITELIST = ['idx', 'xid', 'name', 'tier', 'limit', 'tenure', 'value', 'txnPrev', 'txn30',
    'amt30', 'days', 'channelPref', 'complaint', 'blacklist', 'negotiation', 'inApp30'];

  function parseDSL(text) {
    var errs = [], res = { filters: [], scoring: [], action: {}, guardrail: {}, scope: {}, trigger: {}, _filterLines: [] };
    var lines = String(text == null ? '' : text).split('\n');
    var section = null;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i].replace(/\s+$/, '');
      if (!raw.trim() || raw.trim().startsWith('#')) continue;
      var indent = raw.length - raw.replace(/^\s+/, '').length;
      var line = raw.trim();
      if (indent === 2 && line.endsWith(':')) { section = line.slice(0, -1); continue; }
      if (indent === 2 && line.indexOf(':') !== -1) {
        var kv = line.split(':');
        var k = kv[0].trim();
        var v = kv.slice(1).join(':').trim();
        if (['id', 'name', 'version', 'owner', 'threshold', 'cooldown_days'].indexOf(k) !== -1) {
          res[k] = k === 'threshold' ? parseFloat(v)
            : (k === 'version' || k === 'cooldown_days' ? parseInt(v, 10) : v.replace(/^"|"$/g, ''));
        }
        continue;
      }
      if (section === 'filters' && line.indexOf('- ') === 0) { res.filters.push(line.slice(2).trim()); res._filterLines.push(i + 1); continue; }
      if (section === 'scoring' && line.indexOf('- ') === 0) {
        var m = line.match(/feature:\s*([A-Za-z_][A-Za-z0-9_]*).*weight:\s*([\d.]+)/);
        if (m) res.scoring.push({ feature: m[1], weight: parseFloat(m[2]) });
        else errs.push('第 ' + (i + 1) + ' 行：scoring 项缺少 feature 或 weight');
        continue;
      }
      if (section === 'guardrail' && line.indexOf(':') !== -1) {
        var gk = line.split(':');
        res.guardrail[gk[0].trim()] = gk.slice(1).join(':').trim().replace(/^"|"$/g, '');
        continue;
      }
      if (section === 'action' && line.indexOf(':') !== -1) {
        var ak = line.split(':');
        res.action[ak[0].trim()] = ak.slice(1).join(':').trim();
        continue;
      }
      if (section === 'scope' && line.indexOf(':') !== -1) {
        var sk = line.split(':');
        res.scope[sk[0].trim()] = sk.slice(1).join(':').trim();
        continue;
      }
      if (section === 'trigger') continue;
    }
    if (!res.id) errs.push('缺少 lead_def.id');
    if (!res.threshold || res.threshold <= 0 || res.threshold >= 1) errs.push('threshold 必须在 0–1 之间');
    if (res.filters.length === 0) errs.push('filters 不得为空');
    if (res.filters.length > 8) errs.push('复杂度超限：filters 最多 8 条（当前 ' + res.filters.length + ' 条）');
    if (res.scoring.length > 3) errs.push('复杂度超限：scoring 最多 3 项（当前 ' + res.scoring.length + ' 项）');
    var wsum = res.scoring.reduce(function (a, b) { return a + b.weight; }, 0);
    if (res.scoring.length && Math.abs(wsum - 1) > 0.02) errs.push('scoring 权重之和应为 1，当前 ' + wsum.toFixed(2));
    res.scoring.forEach(function (s) {
      if (!FEATURES[s.feature]) errs.push('未知特征：' + s.feature + '（可用：' + Object.keys(FEATURES).join('/') + '）');
    });
    res.filters.forEach(function (f, fi) {
      if (/in_list|has_event/.test(f)) return;
      // 组合条件 ((A && B) || C) 首字符是 '(' —— 顶层拆出叶子条件逐个验语法
      var leaves = String(f).split(/\|\||&&/).map(function (s) { return s.replace(/^[\s(]+|[\s)]+$/g, '').trim(); }).filter(Boolean);
      var badLeaf = null;
      for (var li = 0; li < leaves.length; li++) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*\s/.test(leaves[li])) { badLeaf = leaves[li]; break; }
      }
      if (badLeaf) errs.push('第 ' + (res._filterLines[fi] || '?') + ' 行 filter 语法无法识别：' + badLeaf + '（在 ' + f.slice(0, 40) + ' 中）');
    });
    // 字段白名单校验：DSL 引用的字段必须真实存在，否则运行时必然静默返回空集
    var rel = res.filters.concat(res.scoring.map(function (s) { return s.feature; }))
      .concat([res.scope.universe_filter || '']);
    var bad = [];
    rel.forEach(function (f) {
      var mm = String(f).match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
      mm.forEach(function (tok) {
        if (FEATURES[tok] || ['feature', 'weight', 'not', 'in_list', 'has_event', 'between', 'and', 'in'].indexOf(tok) !== -1) return;
        if (FIELD_WHITELIST.indexOf(tok) === -1 && bad.indexOf(tok) === -1) bad.push(tok);
      });
    });
    var unknown = bad.filter(function (t) { return !/^[A-Z_0-9]+$/.test(t); });
    if (unknown.length) errs.push('未知字段：' + unknown.join('、') + '（可用字段 ' + FIELD_WHITELIST.join('/') + '）');
    return { def: res, errs: errs, checked_fields: FIELD_WHITELIST.length, unknown_fields: unknown };
  }

  /* 按括号深度切分组合条件：depth===0 处的 || / && 才是顶层连接符，
     in (金卡,白金) 这类语法括号里的逗号/内容不参与。 */
  function splitTop(t, op) {
    var out = [], depth = 0, cur = '', i, ch;
    for (i = 0; i < t.length; i++) {
      ch = t.charAt(i);
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth === 0 && t.indexOf(op, i) === i) {
        out.push(cur); cur = ''; i += op.length - 1;
      } else cur += ch;
    }
    out.push(cur);
    return out;
  }
  /* 剥「包裹整个表达式」的分组括号：(A && B) → A && B。
     不能无脑剥头尾——in (金卡,白金) 的收尾括号是语法的一部分。 */
  function stripWrappingParens(t) {
    while (t.charAt(0) === '(' && t.charAt(t.length - 1) === ')') {
      var depth = 0, pair = -1, ci;
      for (ci = 0; ci < t.length; ci++) {
        if (t.charAt(ci) === '(') depth++;
        else if (t.charAt(ci) === ')') { depth--; if (depth === 0) { pair = ci; break; } }
      }
      if (pair === t.length - 1) t = t.slice(1, -1).trim();
      else break;
    }
    return t;
  }
  function evalFilter(f, c) {
    var t = stripWrappingParens(String(f).trim());
    var m;
    // 组合条件：先剥包裹括号再按深度切分。顶层 || 分支（任一真即真）；分支内 && 链（全真才真）。
    if (t.indexOf('||') !== -1) {
      var branches = splitTop(t, '||'), bi;
      for (bi = 0; bi < branches.length; bi++) {
        if (evalFilter(stripWrappingParens(branches[bi].trim()), c)) return true;
      }
      return false;
    }
    if (t.indexOf('&&') !== -1) {
      var parts = splitTop(t, '&&'), pi;
      for (pi = 0; pi < parts.length; pi++) {
        if (!evalFilter(stripWrappingParens(parts[pi].trim()), c)) return false;
      }
      return true;
    }
    if ((m = t.match(/^not\s+in_list:\s*(\S+)/))) return !(m[1] === 'BLACKLIST_2026' && c.blacklist);
    if ((m = t.match(/^not\s+has_event:\s*(\S+)/))) return !(m[1] === 'COMPLAINT_90D' && c.complaint);
    // 文本枚举：卡等级、偏好渠道这类字段无法用数值比较表达，业务圈人最常用的就是它
    if ((m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+not\s+in\s+\(([^)]*)\)$/))) {
      var ex = m[2].split(',').map(function (s) { return s.trim().replace(/^["']|["']$/g, ''); });
      return ex.indexOf(String(c[m[1]])) === -1;
    }
    if ((m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+in\s+\(([^)]*)\)$/))) {
      var inc = m[2].split(',').map(function (s) { return s.trim().replace(/^["']|["']$/g, ''); });
      return inc.indexOf(String(c[m[1]])) !== -1;
    }
    if ((m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+between\s+([\d.]+)\s+and\s+([\d.]+)$/))) {
      return c[m[1]] >= +m[2] && c[m[1]] <= +m[3];
    }
    if ((m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(<=|>=|<|>|==)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\*\s*([\d.]+)$/))) {
      var l = c[m[1]], r = c[m[3]] * +m[4];
      return m[2] === '<=' ? l <= r : m[2] === '>=' ? l >= r : m[2] === '<' ? l < r : l > r;
    }
    if ((m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(<=|>=|<|>|==)\s*([\d.]+)$/))) {
      var l2 = c[m[1]], r2 = +m[3];
      if (m[2] === '<=') return l2 <= r2;
      if (m[2] === '>=') return l2 >= r2;
      if (m[2] === '<') return l2 < r2;
      if (m[2] === '==') return l2 == r2; // eslint-disable-line eqeqeq
      return l2 > r2;
    }
    // 通用取反：`not <条件>`。排除项条件组生成的就是这种行。
    // 必须放在所有具体语法之后，避免抢走 not in_list / not in (...) 这类专有形式。
    if ((m = t.match(/^not\s+(.+)$/))) return !evalFilter(m[1], c);
    return false;
  }

  function runDef(def, pool) {
    var scored = [];
    var src = pool || CUSTOMERS;
    for (var i = 0; i < src.length; i++) {
      var c = src[i];
      var ok = true;
      for (var j = 0; j < def.filters.length; j++) {
        if (!evalFilter(def.filters[j], c)) { ok = false; break; }
      }
      if (!ok) continue;
      var s = 0;
      for (var k = 0; k < def.scoring.length; k++) {
        var w = def.scoring[k];
        s += (FEATURES[w.feature] ? FEATURES[w.feature](c) : 0) * w.weight;
      }
      if (s < (def.threshold || 0)) continue;
      scored.push({ c: c, score: +s.toFixed(3) });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored;
  }

  /* ============ 3. 线索对象 ============ */
  /* 可分页排序的字段白名单（数值或字符串） */
  var SORTABLE = {
    id: 1, xid: 1, name: 1, tier: 1, txn30: 1, txnPrev: 1, amt30: 1,
    drop: 1, days: 1, inApp30: 1, score: 1, prio: 1, expValue: 1, cost: 1, status: 1,
  };
  var DEFAULT_DEF = parseDSL(DEFAULT_DSL).def;
  var DEFAULT_RUN = runDef(DEFAULT_DEF);

  var LEADS = DEFAULT_RUN.slice(0, 240).map(function (r, i) {
    var c = r.c;
    var prio = r.score >= 0.72 ? 1 : r.score >= 0.63 ? 2 : 3;
    var group = (i % 7 === 0) ? 'C' : 'T';
    var channel = c.channelPref;
    var status, contacted = false, responded = false, converted = false;
    if (group === 'C') {
      status = '待指认';
      converted = rnd() < 0.019;
    } else {
      var pC = channel === 'APP 推送' ? 0.71 : channel === '短信' ? 0.58 : 0.47;
      contacted = rnd() < pC;
      responded = contacted && rnd() < (prio === 1 ? 0.42 : prio === 2 ? 0.31 : 0.22);
      converted = responded && rnd() < (prio === 1 ? 0.46 : prio === 2 ? 0.38 : 0.30);
      status = converted ? '已转化' : responded ? '已响应' : contacted ? '已触达' : (i % 11 === 0 ? '待指认' : '已下发');
    }
    var risk = [];
    if (c.complaint) risk.push('90 天内有投诉');
    if (c.negotiation) risk.push('协商还款中');
    if (c.blacklist) risk.push('禁呼名单');
    return {
      id: 'LD' + String(240 - i).padStart(6, '0') + '-' + (i % 97 + 10),
      xid: c.xid, name: c.name, tier: c.tier, limit: c.limit,
      txn30: c.txn30, txnPrev: c.txnPrev, amt30: c.amt30, days: c.days,
      value: c.value, tenure: c.tenure, channel: channel, inApp30: c.inApp30,
      score: r.score,
      drop: +(1 - c.txn30 / Math.max(1, c.txnPrev)).toFixed(3),
      prio: prio, group: group, status: status,
      contacted: contacted, responded: responded, converted: converted,
      risk: risk,
      defId: 'LD_ACTIVE_DROP_001', defVer: 3, opVer: 'dropRatio@1.4', modelVer: 'score-lgbm@2026.10',
      expValue: Math.round(40 + c.value * 620 + r.score * 180),
      cost: Math.round(2 + rnd() * 5)
    };
  });

  /* ============ 3b. 圈人 → 线索实例化 ============ */
  /* 客群包圈出来的是「客户」，要能被方案拆单下发，必须先落成线索池里的线索记录。
     跨定义按 xid 去重：同一客户不会因为两个客群包都命中而在池子里出现两次。 */
  var BASE_LEAD_COUNT = LEADS.length;

  function makeLead(c, r, seq, defId, defVer) {
    var prio = r.score >= 0.72 ? 1 : r.score >= 0.63 ? 2 : 3;
    var risk = [];
    if (c.complaint) risk.push('90 天内有投诉');
    if (c.negotiation) risk.push('协商还款中');
    if (c.blacklist) risk.push('禁呼名单');
    return {
      id: 'LD' + String(900000 + seq).slice(-6) + '-' + (seq % 97 + 10),
      xid: c.xid, name: c.name, tier: c.tier, limit: c.limit,
      txn30: c.txn30, txnPrev: c.txnPrev, amt30: c.amt30, days: c.days,
      value: c.value, tenure: c.tenure, channel: c.channelPref, inApp30: c.inApp30,
      score: r.score,
      drop: +(1 - c.txn30 / Math.max(1, c.txnPrev)).toFixed(3),
      prio: prio, group: 'T', status: '待指认',
      contacted: false, responded: false, converted: false,
      risk: risk, blocked: [],
      defId: defId, defVer: defVer || 1, opVer: 'custom@1.0', modelVer: 'score-lgbm@2026.10',
      expValue: Math.round(40 + c.value * 620 + r.score * 180),
      cost: Math.round(2 + rnd() * 5),
    };
  }

  /**
   * 按客群包规则实例化线索。返回命中数、新增条数、该定义当前线索总量。
   * limit 是演示环境的实例化上限（真实系统按名单服务批量写入）。
   */
  function materialize(dsl, opts) {
    var parsed = parseDSL(dsl);
    if (parsed.errs.length) return { ok: false, code: 'COMPILE_FAILED', errs: parsed.errs };
    var run = runDef(parsed.def);
    var defId = parsed.def.id;
    var limit = Math.max(1, Math.min(Number((opts && opts.limit) || 200), 1000));
    var seen = {};
    LEADS.forEach(function (l) { seen[l.xid] = 1; });
    var added = 0;
    var batch = [];
    for (var i = 0; i < run.length && added < limit; i++) {
      var c = run[i].c;
      if (seen[c.xid]) continue;
      seen[c.xid] = 1;
      batch.push(makeLead(c, run[i], LEADS.length + batch.length, defId, parsed.def.version));
      added++;
    }
    if (batch.length) LEADS.push.apply(LEADS, batch);
    var inPool = 0;
    for (var j = 0; j < LEADS.length; j++) if (LEADS[j].defId === defId) inPool++;
    return { ok: true, def_id: defId, hits: run.length, added: added, in_pool: inPool, base: BASE_LEAD_COUNT };
  }

  /* 客群规模与渠道可发送口径。
     注意：这里算的是「规则在全量客户里的命中」，不是「已经落成线索的条数」。
     演示数据里两者差得很大（规则命中 425、已实例化线索只有 240），
     业务看到的客群规模必须是前者，否则预算和覆盖率全按小样本算。 */
  /* 渠道可发送口径（与 audienceStats 完全一致），直接吃客户数组，
     供名单型 / 组合型客群复用——口径分叉会导致同一个客群两个页面两个数。 */
  function statsOfCustomers(list) {
    var out = { ok: true, hits: list.length, app: 0, sms: 0, ivr: 0 };
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var banned = !!c.blacklist;
      if (!banned && (c.inApp30 || 0) > 0) out.app++;
      if (!banned) out.sms++;
      if (!banned && !c.negotiation && !c.complaint) out.ivr++;
    }
    return out;
  }

  function audienceStats(dslText) {
    var parsed = parseDSL(dslText);
    if (parsed.errs && parsed.errs.length) return { ok: false, errs: parsed.errs, hits: 0, app: 0, sms: 0, ivr: 0 };
    var run = runDef(parsed.def);
    return statsOfCustomers(run.map(function (h) { return h.c; }));
  }

  /* ============ 3b. 客群三形态：规则(dsl) / 名单(list) / 组合(combine) ============ */
  /* 引擎不持有业务状态，组合客群的来源定义由外部注入解析（routes 初始化时 setDefinitionResolver） */
  var DEF_SOURCE_RESOLVER = null;
  function setDefinitionResolver(fn) { DEF_SOURCE_RESOLVER = fn; }
  function sourceById(id) { return DEF_SOURCE_RESOLVER ? DEF_SOURCE_RESOLVER(id) : null; }

  var CUST_BY_XID = null;
  function custByXid() {
    if (!CUST_BY_XID) {
      CUST_BY_XID = {};
      CUSTOMERS.forEach(function (c) { CUST_BY_XID[c.xid] = c; });
    }
    return CUST_BY_XID;
  }

  /* 集合运算：并 / 交 / 差（A − B − C…）。xid 数组之间做，不碰线索对象 */
  function combineSets(sets, op) {
    if (!sets || !sets.length) return [];
    if (op === 'union') {
      var u = {};
      sets.forEach(function (s) { s.forEach(function (x) { u[x] = 1; }); });
      return Object.keys(u);
    }
    if (op === 'intersect') {
      return sets[0].filter(function (x) {
        return sets.every(function (s) { return s.indexOf(x) !== -1; });
      });
    }
    if (op === 'minus') {
      var cut = {};
      sets.slice(1).forEach(function (s) { s.forEach(function (x) { cut[x] = 1; }); });
      return sets[0].filter(function (x) { return !cut[x]; });
    }
    return [];
  }

  /* 定义对象 → 命中客户 xid 列表。规则型走 DSL，名单型直接取，
     组合型对来源递归求集后按并/交/差合成（层级上限 4，防环防失控）。 */
  function audienceXids(def, depth) {
    depth = depth || 0;
    if (!def || depth > 4) return { ok: false, errs: ['定义缺失或组合层级过深'], xids: [] };
    if (typeof def.dsl === 'string' && def.dsl) {
      var parsed = parseDSL(def.dsl);
      if (parsed.errs.length) return { ok: false, errs: parsed.errs, xids: [] };
      return { ok: true, errs: [], xids: runDef(parsed.def).map(function (h) { return h.c.xid; }) };
    }
    if (Array.isArray(def.list) && def.list.length) {
      var map = custByXid();
      return { ok: true, errs: [], xids: def.list.filter(function (x) { return map[x]; }) };
    }
    var cb = def.combine;
    if (cb && Array.isArray(cb.sources) && cb.sources.length) {
      var sets = [];
      for (var i = 0; i < cb.sources.length; i++) {
        var sub = audienceXids(typeof cb.sources[i] === 'object' ? cb.sources[i] : sourceById(cb.sources[i]), depth + 1);
        if (!sub.ok) return { ok: false, errs: sub.errs, xids: [] };
        sets.push(sub.xids);
      }
      return { ok: true, errs: [], xids: combineSets(sets, cb.op) };
    }
    return { ok: false, errs: ['该客群既无规则也无名单'], xids: [] };
  }

  /* 定义对象 → 已实例化线索 id。拆单 / 名单展示统一走这里。 */
  function leadsOfAudience(def) {
    var r = audienceXids(def);
    if (!r.ok) return { ok: false, errs: r.errs, ids: [], hits: 0 };
    var want = {};
    r.xids.forEach(function (x) { want[x] = 1; });
    var ids = LEADS.filter(function (l) { return want[l.xid]; }).map(function (l) { return l.id; });
    return { ok: true, errs: [], ids: ids, hits: r.xids.length, sample: CUSTOMERS.length };
  }

  /* 名单 / 组合型客群的线索实例化：命中客户里还没入池的补进来。
     打分沿用默认三特征权重，保证 prio 分层与规则型一致。 */
  function materializeXids(xids, defId, defVer, opts) {
    var limit = Math.max(1, Math.min(Number((opts && opts.limit) || 200), 1000));
    var map = custByXid();
    var seen = {};
    LEADS.forEach(function (l) { seen[l.xid] = 1; });
    var added = 0;
    var batch = [];
    for (var i = 0; i < xids.length && added < limit; i++) {
      var c = map[xids[i]];
      if (!c || seen[xids[i]]) continue;
      seen[xids[i]] = 1;
      var score = 0.45 * (FEATURES.dropRatio ? FEATURES.dropRatio(c) : 0)
        + 0.4 * (FEATURES.value ? FEATURES.value(c) : 0)
        + 0.15 * (FEATURES.channelMatch ? FEATURES.channelMatch(c) : 0);
      batch.push(makeLead(c, { c: c, score: +score.toFixed(3) }, LEADS.length + batch.length, defId, defVer));
      added++;
    }
    if (batch.length) LEADS.push.apply(LEADS, batch);
    var inPool = 0;
    LEADS.forEach(function (l) { if (l.defId === defId) inPool++; });
    return { ok: true, def_id: defId, hits: xids.length, added: added, in_pool: inPool, base: BASE_LEAD_COUNT };
  }

  /* 标签字典：业务圈人可选的全部字段及口径。coverage 按全量客户实时算，
     flag 型的覆盖率是「命中比例」（如禁呼名单占全量 1.2%），业务看的是这个标签影响多少人。 */
  var TAG_DICT = [
    { k: '__drop', n: '交易笔数比前 3 个月下降', t: 'pct', u: '%', note: '近 30 天笔数对比前 90 天月均笔数，衡量消费走弱程度' },
    { k: 'txn30', n: '近 30 天交易笔数', t: 'num', u: '笔', note: '近 30 个自然日消费笔数' },
    { k: 'amt30', n: '近 30 天消费金额', t: 'num', u: '元', note: '入账消费金额，不含退款' },
    { k: 'days', n: '距上次交易天数', t: 'num', u: '天', note: '最近一笔消费距今天数' },
    { k: 'inApp30', n: '近 30 天 APP 活跃天数', t: 'num', u: '天', note: '掌上生活登录或浏览的天数' },
    { k: 'limit', n: '信用额度', t: 'num', u: '元', note: '当前固定额度' },
    { k: 'tenure', n: '在网时长', t: 'num', u: '月', note: '首卡核发至今月数' },
    { k: 'value', n: '客户价值分', t: 'num', u: '', note: '0–1 模型综合价值分' },
    { k: 'tier', n: '卡等级', t: 'enum', opts: ['普卡', '金卡', '白金', '钻石'], note: '当前主卡等级' },
    { k: 'channelPref', n: '偏好渠道', t: 'enum', opts: ['APP 推送', '短信', '智能外呼', '人工外呼'], note: '近 90 天响应最高的渠道' },
    { k: 'blacklist', n: '禁呼名单', t: 'flag', note: '监管禁呼名单在册，短信/外呼均不可发送，通常用于排除' },
    { k: 'complaint', n: '90 天内投诉', t: 'flag', note: '近 90 天有投诉工单，外呼触达受限，通常用于排除' },
    { k: 'negotiation', n: '协商还款中', t: 'flag', note: '协商还款协议履行中，禁止营销触达，通常用于排除' },
  ];
  function tagDict() {
    return TAG_DICT.map(function (g) {
      var hit = 0;
      CUSTOMERS.forEach(function (c) {
        if (g.t === 'flag') { if (c[g.k]) hit++; }
        else if (c[g.k] !== null && c[g.k] !== undefined && c[g.k] !== '') hit++;
      });
      return Object.assign({}, g, {
        coverage: CUSTOMERS.length ? hit / CUSTOMERS.length : 0,
        coverage_n: hit,
      });
    });
  }

  /* ============ 4. 统计工具 ============ */
  function erf(x) {
    var s = x < 0 ? -1 : 1; x = Math.abs(x);
    var a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
      a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    var t = 1 / (1 + p * x);
    var y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return s * y;
  }
  function pValue(p1, n1, p2, n2) {
    if (!n1 || !n2) return 1;
    // 两组结果完全相同时 p 必须精确为 1；erf 的近似公式会给出 0.999999999，
    // 这个尾数足以让「无差异」被判成「接近显著」，必须在这一层夹死。
    if (p1 === p2) return 1;
    var p = (p1 * n1 + p2 * n2) / (n1 + n2);
    var se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
    if (!se) return 1;
    var z = (p1 - p2) / se;
    var pv = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
    return Math.min(1, Math.max(0, pv));
  }

  /* 置信区间（Wilson，95%）—— 方案要求「不给区间就不算结论」 */
  function wilson(k, n, z) {
    if (!n) return [0, 0];
    z = z || 1.96;
    var ph = k / n;
    var den = 1 + z * z / n;
    var center = (ph + z * z / (2 * n)) / den;
    var half = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / den;
    return [Math.max(0, center - half), Math.min(1, center + half)];
  }

  /* ============ 5. 证据链与合规闸门 ============ */
  function evidenceOf(l) {
    var ev = [];
    ev.push({
      type: 'FACT', title: '近 30 天交易笔数',
      stmt: '近 30 天消费 ' + l.txn30 + ' 笔、金额 ' + money(l.amt30) + '；上一个 30 天为 ' + l.txnPrev + ' 笔。',
      src: 'dwd.txn_card_daily / 账务核心', conf: 0.98,
      conf_note: '账务来源 1.0 × 新鲜度 0.99 × 完整度 0.99'
    });
    ev.push({
      type: 'FACT', title: '最后交易日',
      stmt: '距最后一次消费 ' + l.days + ' 天，处于 15–60 天观察窗内。',
      src: 'dwd.txn_card_daily', conf: 0.97, conf_note: '账务来源 1.0 × 新鲜度 0.98'
    });
    ev.push({
      type: 'FACT', title: 'APP 活跃',
      stmt: '近 30 天掌上生活打开 ' + l.inApp30 + ' 次，' +
        (l.inApp30 > 8 ? '仍保持活跃，属"有需求未转化"。' : '活跃度同步走低，属"整体流失前兆"。'),
      src: 'dws.app_behavior_30d', conf: 0.86, conf_note: '行为来源 0.8 × 新鲜度 0.98'
    });
    ev.push({
      type: 'DERIVED', title: '消费降幅',
      stmt: '环比下降 ' + pct(l.drop, 0) + '，权重 0.4，贡献 ' + (l.drop * 0.4).toFixed(2) + ' 分。',
      src: 'op:dropRatio@1.4', conf: 0.94, conf_note: '输入最小值 0.94 × 规则确定性 1.0'
    });
    ev.push({
      type: 'DERIVED', title: '客户价值分层',
      stmt: '价值分 ' + l.value.toFixed(2) + '，卡等级 ' + l.tier + '，在册 ' + l.tenure + ' 个月。',
      src: 'op:value_tier@2.1', conf: 0.88, conf_note: '模型分层，历史精确率 0.88'
    });
    ev.push({
      type: 'INFERRED', title: '经营判断',
      stmt: l.inApp30 > 8
        ? '存在未被满足的消费场景，权益匹配成功率较高。'
        : '有流失倾向，宜用低门槛权益做唤醒而非直接推分期。',
      src: 'score-lgbm@2026.10', conf: 0.71, conf_note: '模型近 30 天同类线索精确率 0.71'
    });
    return ev;
  }

  var GATE_DEFS = [
    { id: 'G1', n: '禁呼名单 / 投诉静默期' },
    { id: 'G2', n: '频控（日 ≤1 / 月 ≤3）' },
    { id: 'G3', n: '触达时段（22:00–08:00 禁呼）' },
    { id: 'G4', n: '催收仅向债务人本人' },
    { id: 'G5', n: '产品适当性匹配' },
    { id: 'G6', n: '话术白名单校验' },
    { id: 'G7', n: 'AI 语音首句告知 + 录音留证' }
  ];

  function gatesOf(l, ctx) {
    var c = ctx || {};
    // G3/G7 真实判定的默认值：
    //   G3 静默时段——线索下发走的业务时钟（演示与批量操作都在工作时间跑），
    //     这里默认放行、由调度/回执层的 inQuietHours() 硬闸兜底；
    //     调用方传 quiet_hours_blocked 时以传入值为准（审计可复现任意时刻的判定）。
    //   G7 AI 告知——外呼话术模板 v3 已内置 AI 声明段（默认通过）；
    //     渲染层对实际话术跑 checkAiDeclare()，缺声明时注入 ai_declared=false 强制拦截。
    var quiet = c.quiet_hours_blocked != null ? !!c.quiet_hours_blocked : false;
    var aiDeclareOk = c.ai_declared != null ? !!c.ai_declared : true;
    // 退订是监管级停止信号：已退订客户一律不得触达（G1 硬拦），直到人工移除标签
    var unsubscribed = l.risk.indexOf('已退订') !== -1;
    var g = [
      { id: 'G1', n: GATE_DEFS[0].n, ok: !unsubscribed && !(l.risk.indexOf('禁呼名单') !== -1 || l.risk.indexOf('90 天内有投诉') !== -1) },
      { id: 'G2', n: GATE_DEFS[1].n, ok: !c.frequency_exceeded },
      { id: 'G3', n: GATE_DEFS[2].n, ok: !quiet },
      { id: 'G4', n: GATE_DEFS[3].n, ok: true, na: true },
      { id: 'G5', n: GATE_DEFS[4].n, ok: true },
      { id: 'G6', n: GATE_DEFS[5].n, ok: !c.template_not_whitelisted },
      { id: 'G7', n: GATE_DEFS[6].n, ok: aiDeclareOk }
    ];
    if (l.risk.indexOf('协商还款中') !== -1) g[4].ok = false;
    return g;
  }

  /* 静默时段判定（G3 真实实现，不再依赖调用方传参）：
     22:00–08:00 禁呼（银行外呼监管底线，人群规则 DSL guardrail.quiet_hours 同口径）。
     此前 gatesOf 的 G3 恒为通过、quiet_hours_blocked 从未被注入——
     演示回执全部落在凌晨 02:00 而拦截数为 0，属已证实的合规漏报（codex 审核 P0）。 */
  function inQuietHours(d) {
    var h;
    if (d) { var t = new Date(d); h = isNaN(t.getTime()) ? null : t.getHours(); }
    else h = new Date().getHours();
    if (h == null) return false;
    return h >= 22 || h < 8;
  }

  /* AI 身份告知校验（G7 真实实现）：
     外呼话术开场必须声明「AI/智能语音/机器人」身份——平台自己提示
     「AI 外呼还须声明非人工」，但实际话术从未披露，G7 却恒为通过。
     现在逐条检查外呼渠道的开场文本是否含 AI 声明关键词；模板 v3 已内置声明段。 */
  var AI_DECLARE_RE = /AI|人工智能|智能语音|机器人助手|智能客服|机器人/;
  function checkAiDeclare(openingText) {
    return AI_DECLARE_RE.test(String(openingText || ''));
  }

  var GATE_FAIL = {
    G1: '命中禁呼名单', G2: '30 天内已触达 1 次，频控拦截',
    G3: '当前时段不可触达', G4: '非债务人本人', G5: '客户风险等级与产品不匹配',
    G6: '话术模板不在白名单', G7: '未配置告知话术'
  };

  function decisionCardOf(l, ctx) {
    var gates = gatesOf(l, ctx);
    var blocked = gates.filter(function (g) { return !g.ok; });
    return {
      lead_id: l.id, xid: l.xid,
      priority: l.prio,
      recommended_action: 'CARE_CONTACT',
      channel: l.channel,
      template_id: 'TPL_CARE_003',
      expected_value: l.expValue,
      cost_estimate: l.cost,
      risk_flags: l.risk,
      compliance_check: { passed: blocked.length === 0, failed_rules: blocked.map(function (g) { return g.id; }) },
      versions: { lead_def: 'LD_ACTIVE_DROP_001@3', op: l.opVer, model: l.modelVer },
      valid_until: '2026-11-06T23:59:59+08:00'
    };
  }

  /* ============ 6. 聚合指标 ============ */
  function aggregate(leads) {
    var L = leads || LEADS;
    var T = L.filter(function (l) { return l.group === 'T'; });
    var C = L.filter(function (l) { return l.group === 'C'; });
    var tasks = T.filter(function (l) { return l.status !== '待指认'; });
    var contacts = T.filter(function (l) { return l.contacted; });
    var resp = T.filter(function (l) { return l.responded; });
    var conv = T.filter(function (l) { return l.converted; });
    var cConv = C.filter(function (l) { return l.converted; });
    var blocked = L.filter(function (l) {
      return gatesOf(l).some(function (g) { return !g.ok; });
    });
    var totalCost = T.reduce(function (a, l) { return a + l.cost; }, 0);
    var tSize = T.length, cSize = C.length;
    var tConv = tSize ? conv.length / tSize : 0;
    var cConvRate = cSize ? cConv.length / cSize : 0;
    return {
      total: L.length, tasks: tasks.length, contacts: contacts.length,
      resp: resp.length, conv: conv.length, blocked: blocked.length,
      effRate: contacts.length ? conv.length / contacts.length : 0,
      inc: tConv - cConvRate,
      unitCost: conv.length ? totalCost / conv.length : 0,
      tSize: tSize, cSize: cSize, tConv: tConv, cConv: cConvRate,
      costTotal: totalCost,
      ci: wilson(conv.length, Math.max(1, contacts.length)),
      incCI: [
        (tConv - cConvRate) - 1.96 * Math.sqrt(
          tConv * (1 - tConv) / Math.max(1, tSize) + cConvRate * (1 - cConvRate) / Math.max(1, cSize)),
        (tConv - cConvRate) + 1.96 * Math.sqrt(
          tConv * (1 - tConv) / Math.max(1, tSize) + cConvRate * (1 - cConvRate) / Math.max(1, cSize))
      ]
    };
  }

  /* 30 天累计对比 + 双比例检验 */
  function experiment(agg) {
    var a = agg || aggregate();
    var days = 30;
    var cumT = a.tSize * days, cumC = a.cSize * days;
    var convT = Math.round(cumT * a.tConv), convC = Math.round(cumC * a.cConv);
    var rT = cumT ? convT / cumT : 0, rC = cumC ? convC / cumC : 0;
    var p = pValue(rT, cumT, rC, cumC);
    return {
      days: days,
      sampleT: cumT, sampleC: cumC,
      convT: convT, convC: convC,
      rateT: rT, rateC: rC,
      uplift: rT - rC,
      p_value: p,
      significant: p < 0.05 && rT > rC,
      ci_t: wilson(convT, cumT),
      ci_c: wilson(convC, cumC)
    };
  }

  /* ============ 7. 编译报告 ============ */
  function dagOf(def) {
    return [
      { t: '圈客', s: String(def.scope.universe_filter || '').replace(/[\[\]]/g, '') || '全部活跃户', c: '#4f6ff5' },
      { t: '过滤', s: def.filters.length + ' 个硬条件', c: '#7b62d9' },
      { t: '评分', s: def.scoring.length + ' 项加权', c: '#4f6ff5' },
      { t: '门槛', s: '≥ ' + def.threshold, c: '#b8791a' },
      { t: '证据', s: '≥1 条 FACT', c: '#1d9e75' },
      { t: '动作', s: def.action.type || 'CARE_CONTACT', c: '#191919' }
    ];
  }

  function compile(dslText, options) {
    var opts = options || {};
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var parsed = parseDSL(dslText);
    var def = parsed.def, errs = parsed.errs;
    // 数据集试跑：opts.customers 存在时用它替代内存模拟客户，默认行为不变
    var customers = (opts.customers && opts.customers.length) ? opts.customers : CUSTOMERS;
    var hits = errs.length ? [] : runDef(def, customers);
    var total = customers.length;
    var buckets = [0, 0, 0, 0, 0, 0];
    hits.forEach(function (h) { buckets[Math.min(5, Math.floor(h.score * 6))]++; });
    var full = Math.round(hits.length / total * (opts.universe || 70106500));
    var cap = +(def.guardrail.max_daily_volume || 50000);
    var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    return {
      ok: errs.length === 0,
      errs: errs,
      def: def,
      checked_fields: parsed.checked_fields,
      unknown_fields: parsed.unknown_fields,
      metrics: {
        sampleTotal: total,
        hits: hits.length,
        hitRate: total ? hits.length / total : 0,
        full: full,
        afterCap: Math.min(full, cap),
        buckets: buckets,
        threshold: def.threshold,
        avgScore: hits.length ? hits.reduce(function (a, h) { return a + h.score; }, 0) / hits.length : 0
      },
      dag: dagOf(def),
      topHits: hits.slice(0, 5).map(function (h, i) {
        return { rank: i + 1, xid: h.c.xid, name: h.c.name, tier: h.c.tier, score: h.score };
      }),
      engine_version: ENGINE_VERSION,
      elapsed_ms: Math.round((t1 - t0) * 10) / 10
    };
  }

  /* ============ 8. 线索集合读写 ============ */
  function leadById(id) {
    for (var i = 0; i < LEADS.length; i++) if (LEADS[i].id === id) return LEADS[i];
    return null;
  }

  function matchFilter(l, key) {
    if (!key || key === 'all') return true;
    if (key === 'wait') return l.status === '待指认';
    if (key === 'done') return l.status === '已转化';
    if (key === 'risk') return l.risk.length > 0;
    return l.prio === +key;
  }

  /** 内部用：全量线索，不受分页 200 上限影响（拆任务单必须看到完整名单） */
  function allLeads() {
    return LEADS.slice();
  }

  /**
   * 按线索定义的 DSL 圈人，返回命中的线索 ID。
   * 之前拆任务单直接拿全量线索，方案圈的是「消费活跃度下降」，却把整个池子都塞进任务单——
   * 定义形同摆设。这里用同一个 runDef 评估，保证「定义怎么写的，就圈哪些人」。
   */
  function leadsOfDefinition(dslText) {
    var parsed = parseDSL(String(dslText || ''));
    if (parsed.errs.length) return { ok: false, errs: parsed.errs, ids: [], hits: 0 };
    var hits = runDef(parsed.def, CUSTOMERS);
    var byXid = {};
    hits.forEach(function (h) { byXid[h.c.xid] = true; });
    var ids = LEADS.filter(function (l) { return byXid[l.xid]; }).map(function (l) { return l.id; });
    return { ok: true, errs: [], ids: ids, hits: hits.length, sample: CUSTOMERS.length };
  }

  function listLeads(q) {
    var o = q || {};
    var page = Math.max(1, parseInt(o.page, 10) || 1);
    var size = Math.min(200, Math.max(1, parseInt(o.size, 10) || 20));
    var kw = String(o.q || '').trim();
    var all = LEADS.filter(function (l) {
      if (!matchFilter(l, o.filter)) return false;
      if (kw && !(l.id.indexOf(kw) !== -1 || l.xid.indexOf(kw) !== -1 || l.name.indexOf(kw) !== -1)) return false;
      return true;
    });
    // 排序：白名单字段，避免任意属性被当排序键。
    if (o.sort && SORTABLE[o.sort]) {
      var dir = String(o.dir || 'desc') === 'asc' ? 1 : -1;
      all = all.slice().sort(function (a, b) {
        var x = a[o.sort], y = b[o.sort];
        if (typeof x === 'string' || typeof y === 'string') {
          return String(x == null ? '' : x).localeCompare(String(y == null ? '' : y), 'zh') * dir;
        }
        return ((x || 0) - (y || 0)) * dir;
      });
    }
    var pages = Math.max(1, Math.ceil(all.length / size));
    if (page > pages) page = pages;
    var rows = all.slice((page - 1) * size, page * size).map(function (l) {
      var o2 = {};
      for (var k in l) if (Object.prototype.hasOwnProperty.call(l, k)) o2[k] = l[k];
      o2.evidenceCount = 6;
      o2.blocked = gatesOf(l).filter(function (g) { return !g.ok; }).map(function (g) { return g.id; });
      return o2;
    });
    return { total: all.length, page: page, pages: pages, size: size, rows: rows, filter: o.filter || 'all' };
  }

  function castCounts() {
    var m = {};
    LEADS.forEach(function (l) { m[l.status] = (m[l.status] || 0) + 1; });
    return m;
  }

  /* 状态机：只允许合法迁移，非法迁移返回原因而非静默成功 */
  var TRANSITIONS = {
    '待指认': ['已下发', '已关闭'],
    '已下发': ['已触达', '已关闭'],
    '已触达': ['已响应', '已关闭'],
    '已响应': ['已转化', '已关闭'],
    '已转化': ['已关闭'],
    '已关闭': []
  };

  function transitionsOf(status) {
    return (TRANSITIONS[status] || []).slice();
  }

  function setLeadStatus(id, next, ctx) {
    var l = leadById(id);
    if (!l) return { ok: false, code: 'not_found', error: '线索不存在：' + id };
    var allowed = TRANSITIONS[l.status] || [];
    if (allowed.indexOf(next) === -1) {
      return {
        ok: false, code: 'illegal_transition',
        error: '不允许从「' + l.status + '」迁移到「' + next + '」，可迁移目标：' + (allowed.join('、') || '无')
      };
    }
    if (next === '已下发') {
      var blocked = gatesOf(l, ctx).filter(function (g) { return !g.ok; });
      if (blocked.length) {
        return {
          ok: false, code: 'gate_blocked',
          error: '存在合规闸门拦截，不可下发：' + blocked.map(function (g) { return g.id; }).join('、'),
          failed: blocked.map(function (g) { return g.id; })
        };
      }
    }
    l.status = next;
    if (next === '已触达') l.contacted = true;
    if (next === '已响应') { l.contacted = true; l.responded = true; }
    if (next === '已转化') { l.contacted = true; l.responded = true; l.converted = true; }
    return { ok: true, lead: l, from: allowed, status: l.status };
  }

  /* ============ 9. 静态注册表（算子 / 定义 / 合规） ============ */
  var OPS = [
    { id: 'dropRatio', n: '消费降幅计算', t: 'F', o: '数据工程-王', e: 'FULL', m: 0.94, d: '2026-10-28', s: '在线' },
    { id: 'value_tier', n: '客户价值分层', t: 'M', o: '算法-李', e: 'COARSE', m: 0.88, d: '2026-10-28', s: '在线' },
    { id: 'channel_match', n: '渠道偏好匹配', t: 'F', o: '数据工程-王', e: 'FULL', m: 0.91, d: '2026-10-21', s: '在线' },
    { id: 'tenure_norm', n: '在册时长归一', t: 'R', o: '业务-陈', e: 'FULL', m: 1.0, d: '2026-09-30', s: '在线' },
    { id: 'intent_lgbm', n: '分期意向模型', t: 'M', o: '算法-赵', e: 'COARSE', m: 0.73, d: '2026-10-14', s: '观察' },
    { id: 'bill_shock', n: '账单突增检测', t: 'M', o: '算法-赵', e: 'COARSE', m: 0.69, d: '2026-09-30', s: '待下线' },
    { id: 'blacklist_chk', n: '禁呼名单校验', t: 'R', o: '合规-周', e: 'FULL', m: 1.0, d: '2026-11-01', s: '在线' },
    { id: 'llm_explain', n: '解释生成', t: 'M', o: '算法-李', e: 'NONE', m: 0.0, d: '—', s: '仅内部' }
  ];

  function opMeta(o) {
    var out = {};
    out[o.id] = 'float';
    return {
      op_id: o.id, name: o.n, version: '1.4', owner: o.o, tier: o.t,
      input_contract: { xid: 'string', txn30: 'int', txnPrev: 'int' },
      output_contract: out,
      compute_profile: '0.8 core-hour / million rows',
      explainability_level: o.e,
      compliance_level: o.t === 'M' ? 'HIGH' : 'LOW',
      last_backtest_date: o.d,
      backtest_metric: { precision: o.m },
      status: o.s,
      rule: o.e === 'NONE' ? '不得进入任何对客场景' : '可解释输出：命中条件 + 贡献度 Top3'
    };
  }

  var DEF_PERF = [
    { id: 'LD_ACTIVE_DROP_001', n: '消费活跃度下降', v: 240, eff: 0.164, inc: 0.031, ok: true },
    { id: 'LD_BILL_SHOCK_002', n: '账单金额异常上升', v: 186, eff: 0.138, inc: 0.024, ok: true },
    { id: 'LD_BENEFIT_UNUSED_003', n: '权益长期未使用', v: 152, eff: 0.091, inc: 0.011, ok: false },
    { id: 'LD_INSTALLMENT_004', n: '大额消费后分期意向', v: 98, eff: 0.122, inc: 0.019, ok: true }
  ];

  var AI_APPS = [
    { n: '线索评分模型', i: '高', m: '高', r: true, h: '阈值人工复核' },
    { n: '催收线索优先级', i: '高', m: '高', r: true, h: '坐席终审' },
    { n: '线索解释生成', i: '间接', m: '高', r: false, h: '模板降级' },
    { n: '通话摘要质检', i: '间接', m: '高', r: false, h: '人工全量复核' },
    /* MKT-18（codex 二审）：模型主导外呼（阶段三 agent）直接对客生成话术并驱动
       工具调用，是最高风险链路——此前不在登记表，治理范围缺口。 */
    { n: '模型主导外呼（阶段三）', i: '高（直接对客）', m: '高', r: true, h: '投诉闸/拒绝闸/确认闸三道引擎硬闸 + 转人工兜底；上线前须过固定评测集与合规红队' }
  ];

  var GATE_STATS = [
    { id: 'G1', n: '禁呼名单', c: 12 }, { id: 'G2', n: '频控', c: 38 }, { id: 'G3', n: '触达时段', c: 0 },
    { id: 'G4', n: '催收对象', c: 0 }, { id: 'G5', n: '产品适当性', c: 7 }, { id: 'G6', n: '话术白名单', c: 3 },
    { id: 'G7', n: 'AI 告知留证', c: 0 }
  ];

  var GUARDRAILS = [
    { n: '客户投诉率', v: '0.21%', base: '0.19%', ok: true, note: '环比 +10.5%，低于 +20% 阈值' },
    { n: '退订率', v: '0.08%', base: '0.07%', ok: true, note: '环比 +14%，低于 +30% 阈值' },
    { n: '催收合规例外', v: '0', base: '0', ok: true, note: '零容忍，保持为 0' },
    { n: '单客户月触达', v: '1.6 次', base: '1.4 次', ok: true, note: '上限 3 次' }
  ];

  var ALERTS = [
    { lv: 'r', t: 'app_behavior_30d 数据延迟 47 分钟', p: '新鲜度 SLO 为 T+1h，当前批次标记 quality=LOW，相关线索不进入触达。', i: '高' },
    { lv: 'a', t: 'bill_shock 算子精确率连续两月下降', p: '近 30 天 0.69（上月 0.81），触发下线预警，建议本周内下线。', i: '中' },
    { lv: 'a', t: 'LD_BENEFIT_UNUSED_003 增量未达显著', p: '有效率 9.1%，增量 +1.1pp，p=0.24。建议暂停或重新设计权益包。', i: '中' },
    { lv: 'b', t: '线索量突变', p: '今日 240 条，较 14 日均值 218 条上升 10.1%，在 ±40% 阈值内，无需处置。', i: '低' }
  ];

  /* ============ 10. 数据新鲜度（服务端健康检查用） ============ */
  function datasetSummary() {
    var a = aggregate();
    return {
      engine_version: ENGINE_VERSION,
      data_seed: DATA_SEED,
      customers: CUSTOMERS.length,
      leads: LEADS.length,
      def: DEFAULT_DEF.id + '@' + DEFAULT_DEF.version,
      aggregate: a,
      status_counts: castCounts()
    };
  }

  return {
    ENGINE_VERSION: ENGINE_VERSION,
    DATA_SEED: DATA_SEED,
    DEFAULT_DSL: DEFAULT_DSL,
    CUSTOMERS: CUSTOMERS,
    LEADS: LEADS,
    FEATURES: FEATURES,
    FIELD_WHITELIST: FIELD_WHITELIST,
    STATUSES: STATUSES,
    parseDSL: parseDSL,
    evalFilter: evalFilter,
    runDef: runDef,
    compile: compile,
    dagOf: dagOf,
    evidenceOf: evidenceOf,
    gatesOf: gatesOf,
    inQuietHours: inQuietHours,
    checkAiDeclare: checkAiDeclare,
    AI_DECLARE_RE: AI_DECLARE_RE,
    decisionCardOf: decisionCardOf,
    GATE_FAIL: GATE_FAIL,
    aggregate: aggregate,
    experiment: experiment,
    pValue: pValue,
    wilson: wilson,
    leadById: leadById,
    listLeads: listLeads,
    allLeads: allLeads,
    leadsOfDefinition: leadsOfDefinition,
    audienceStats: audienceStats,
    audienceXids: audienceXids,
    leadsOfAudience: leadsOfAudience,
    materializeXids: materializeXids,
    statsOfCustomers: statsOfCustomers,
    combineSets: combineSets,
    custByXid: custByXid,
    setDefinitionResolver: setDefinitionResolver,
    tagDict: tagDict,
    materialize: materialize,
    BASE_LEAD_COUNT: BASE_LEAD_COUNT,
    setLeadStatus: setLeadStatus,
    transitionsOf: transitionsOf,
    castCounts: castCounts,
    datasetSummary: datasetSummary,
    OPS: OPS,
    opMeta: opMeta,
    DEF_PERF: DEF_PERF,
    AI_APPS: AI_APPS,
    GATE_STATS: GATE_STATS,
    GUARDRAILS: GUARDRAILS,
    ALERTS: ALERTS
  };
});
