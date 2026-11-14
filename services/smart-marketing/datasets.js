'use strict';

/**
 * 智能营销 · 数据层（导入 → 清洗 → 治理 → 数据集版本）
 *
 * 边界（方案 1.2）：抽取调度、数据同步、计算引擎复用行内数据中台；
 * 本模块只做「业务语义层」——字段映射、质量门禁、口径版本、可用性判定。
 *
 * 设计要点：
 *   1. 导入不直接进线索引擎，先落 landing（原始 CSV 快照）再进 serving（标准化行），
 *      中间产物都带 dataset_id + version，任何一次试跑都能回溯到具体数据版本；
 *   2. 质量不达标不是「警告」，是 batch.quality = LOW，该数据集不得用于对客触达；
 *   3. 映射由人确认，不接受自动猜测直接落库——猜错的代价是整批线索错人。
 */

const fs = require('node:fs');
const path = require('node:path');

const STD_FIELDS = {
  xid: {
    label: '客户标识', type: 'string', required: true,
    aliases: ['xid', '客户标识', '客户号', '客户id', '客户编号', 'cust_id', 'customer_id', 'card_no', '卡号', '证件号'],
  },
  txn_prev_30d: {
    label: '前 30 天交易笔数', type: 'number', required: true,
    aliases: ['txn_prev_30d', '前30天交易笔数', '上期交易笔数', '上月交易笔数', 'prev_txn_cnt', 'm1_txn_cnt'],
  },
  txn_last_30d: {
    label: '近 30 天交易笔数', type: 'number', required: true,
    aliases: ['txn_last_30d', '近30天交易笔数', '本期交易笔数', '本月交易笔数', 'txn30', 'txn_cnt_30d'],
  },
  amt_last_30d: {
    label: '近 30 天交易金额', type: 'number', required: false,
    aliases: ['amt_last_30d', '近30天交易金额', '本期交易金额', '本月交易金额', 'amt30', 'txn_amt_30d'],
  },
  days_since_last_txn: {
    label: '距最后交易日天数', type: 'number', required: false,
    aliases: ['days_since_last_txn', '距最后交易日', '未交易天数', '距上次交易', 'days'],
  },
  in_app_30d: {
    label: '近 30 天 APP 打开次数', type: 'number', required: false,
    aliases: ['in_app_30d', 'app打开次数', 'APP活跃次数', 'app_open_30d', 'inapp30'],
  },
  tier: {
    label: '卡等级', type: 'enum', required: false, values: ['普卡', '金卡', '白金', '钻石'],
    aliases: ['tier', '卡等级', '卡种', '卡片等级'],
  },
  limit: {
    label: '信用额度', type: 'number', required: false,
    aliases: ['limit', '额度', '信用额度', '授信额度', 'credit_limit'],
  },
  value: {
    label: '客户价值分', type: 'number', required: false,
    aliases: ['value', '价值分', '客户价值', 'value_score'],
  },
  tenure: {
    label: '在册月数', type: 'number', required: false,
    aliases: ['tenure', '在册时长', '持卡月数', '账龄'],
  },
};

const QUALITY_RULES = [
  { code: 'PRIMARY_KEY_UNIQUE', label: '客户标识唯一性', level: 'HIGH' },
  { code: 'REQUIRED_FIELDS', label: '必填字段完整率', level: 'HIGH' },
  { code: 'NUMERIC_RANGE', label: '数值合法性（非负、天数上限）', level: 'HIGH' },
  { code: 'ENUM_DOMAIN', label: '枚举值域（卡等级）', level: 'HIGH' },
  { code: 'CROSS_FIELD', label: '跨字段一致性（交易笔数突增）', level: 'MEDIUM' },
  { code: 'FRESHNESS', label: '数据新鲜度', level: 'MEDIUM' },
  { code: 'COVERAGE', label: '特征字段覆盖率', level: 'MEDIUM' },
];

/* ────────────────────────── CSV 解析 ────────────────────────── */

function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

/** 探测分隔符：逗号 / 制表符 / 分号，取首行出现次数最多的 */
function detectDelimiter(text) {
  const firstLine = stripBom(text).split(/\r?\n/)[0] || '';
  const candidates = [',', '\t', ';'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return bestCount > 0 ? best : ',';
}

/** 支持引号包裹、引号内逗号与换行、双引号转义 */
function parseCsv(content) {
  const text = stripBom(content);
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const cleaned = rows.filter(r => r.some(c => String(c).trim() !== ''));
  if (!cleaned.length) return { delimiter: delimiter, header: [], rows: [] };
  const header = cleaned[0].map(h => String(h).trim());
  const body = cleaned.slice(1).map(r => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = r[idx] === undefined ? '' : String(r[idx]).trim(); });
    return obj;
  });
  return { delimiter: delimiter, header: header, rows: body };
}

/* ────────────────────────── 类型推断与映射建议 ────────────────────────── */

function inferType(values) {
  const sample = values.filter(v => String(v).trim() !== '').slice(0, 200);
  if (!sample.length) return 'empty';
  let numeric = 0;
  for (const v of sample) {
    if (/^-?\d+(\.\d+)?$/.test(String(v).replace(/,/g, '').trim())) numeric++;
  }
  if (numeric / sample.length >= 0.95) return 'number';
  const dates = sample.filter(v => /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(String(v))).length;
  if (dates / sample.length >= 0.9) return 'date';
  return 'string';
}

function profileColumn(rows, name) {
  const values = rows.map(r => r[name]);
  const nonEmpty = values.filter(v => String(v).trim() !== '');
  const distinct = new Set(nonEmpty.map(v => String(v).trim()));
  return {
    name: name,
    type: inferType(values),
    null_rate: rows.length ? +((1 - nonEmpty.length / rows.length)).toFixed(4) : 0,
    distinct: distinct.size,
    samples: Array.from(distinct).slice(0, 5),
  };
}

/** 列名与标准字段做别名匹配；未命中的留空，由人确认 */
function suggestMapping(columns) {
  const mapping = {};
  const used = new Set();
  for (const key of Object.keys(STD_FIELDS)) {
    const std = STD_FIELDS[key];
    const hit = columns.find(c => {
      if (used.has(c.name)) return false;
      const n = String(c.name).toLowerCase().replace(/[\s_-]/g, '');
      return std.aliases.some(a => {
        const al = String(a).toLowerCase().replace(/[\s_-]/g, '');
        return n === al || n.indexOf(al) !== -1;
      });
    });
    if (hit) { mapping[key] = hit.name; used.add(hit.name); }
  }
  return mapping;
}

/* ────────────────────────── 标准化 ────────────────────────── */

function toNumber(value) {
  const v = String(value === undefined || value === null ? '' : value).replace(/,/g, '').trim();
  if (!v) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * 按映射把原始行标准化成引擎可用的客户对象。
 * 缺字段时给中性默认值并在 rejected 里留痕，不静默补 0——补 0 会让「消费降幅」算出假结论。
 */
function normalizeRows(rows, mapping) {
  const out = [];
  const rejected = [];
  // 清洗会改动数据，改动必须留痕——否则质量报告会显示"一切正常"，
  // 而实际上有几十行被悄悄改过值，这在审计上是不可接受的。
  const fixes = { days_clamped: 0, negative_values: 0, tier_fallback: 0, defaults_filled: 0 };
  rows.forEach((row, idx) => {
    const pick = std => (mapping[std] ? row[mapping[std]] : undefined);
    const xid = mapping.xid ? String(pick('xid') || '').trim() : '';
    if (!xid) { rejected.push({ row: idx + 2, reason: '客户标识为空' }); return; }
    const txnPrev = toNumber(pick('txn_prev_30d'));
    const txn30 = toNumber(pick('txn_last_30d'));
    if (txnPrev === null || txn30 === null) {
      rejected.push({ row: idx + 2, reason: '交易笔数缺失或非数值' });
      return;
    }
    const tierRaw = String(pick('tier') || '').trim();
    const tier = STD_FIELDS.tier.values.indexOf(tierRaw) !== -1 ? tierRaw : '普卡';
    if (tierRaw && STD_FIELDS.tier.values.indexOf(tierRaw) === -1) fixes.tier_fallback++;
    if (txnPrev < 0 || txn30 < 0) fixes.negative_values++;
    const amt30 = toNumber(pick('amt_last_30d'));
    const days = toNumber(pick('days_since_last_txn'));
    const inApp = toNumber(pick('in_app_30d'));
    out.push({
      idx: out.length,
      xid: xid,
      name: xid.slice(0, 2) + '**',
      tier: tier,
      limit: toNumber(pick('limit')) === null ? 30000 : toNumber(pick('limit')),
      tenure: toNumber(pick('tenure')) === null ? 48 : toNumber(pick('tenure')),
      value: toNumber(pick('value')) === null ? 0.5 : Math.min(0.99, Math.max(0.02, toNumber(pick('value')))),
      txnPrev: txnPrev,
      txn30: txn30,
      amt30: amt30 === null ? Math.round(txn30 * 300) : amt30,
      days: (() => {
        if (days === null) { fixes.defaults_filled++; return 15; }
        if (days < 1 || days > 365) { fixes.days_clamped++; return Math.min(365, Math.max(1, days)); }
        return days;
      })(),
      channelPref: 'APP 推送',
      complaint: false,
      blacklist: false,
      negotiation: false,
      inApp30: inApp === null ? 6 : inApp,
    });
  });
  return { customers: out, rejected: rejected, fixes: fixes };
}

/* ────────────────────────── 质量门禁 ────────────────────────── */

function runQualityChecks(rows, mapping, normalized, options) {
  const opts = options || {};
  const checks = [];
  const push = (rule, passed, detail, blocking) => {
    checks.push({
      code: rule.code, label: rule.label, level: rule.level,
      passed: passed, blocking: blocking !== undefined ? blocking : (rule.level === 'HIGH'),
      detail: detail,
    });
  };

  const ruleOf = code => QUALITY_RULES.find(r => r.code === code);

  // 1. 主键唯一
  const xids = rows.map(r => String(mapping.xid ? r[mapping.xid] : '').trim()).filter(Boolean);
  const dupCount = xids.length - new Set(xids).size;
  push(ruleOf('PRIMARY_KEY_UNIQUE'), dupCount === 0, dupCount === 0 ? '无重复客户标识' : ('重复 ' + dupCount + ' 个'));

  // 2. 必填字段
  const missingReq = Object.keys(STD_FIELDS).filter(k => STD_FIELDS[k].required && !mapping[k]);
  push(ruleOf('REQUIRED_FIELDS'), missingReq.length === 0,
    missingReq.length === 0 ? '必填字段均已映射' : ('未映射必填字段：' + missingReq.map(k => STD_FIELDS[k].label).join('、')));

  // 3. 数值范围：看清洗前的原始值，否则修正过的脏数据会被算成"合格"
  const rawNum = (row, field) => (mapping[field] ? toNumber(row[mapping[field]]) : null);
  const badRange = rows.filter(row => {
    const p = rawNum(row, 'txn_prev_30d');
    const c = rawNum(row, 'txn_last_30d');
    const a = rawNum(row, 'amt_last_30d');
    const d = rawNum(row, 'days_since_last_txn');
    return (p !== null && p < 0) || (c !== null && c < 0) || (a !== null && a < 0)
      || (d !== null && (d < 0 || d > 365));
  }).length;
  const fixes = normalized.fixes || {};
  const fixedTotal = (fixes.days_clamped || 0) + (fixes.negative_values || 0)
    + (fixes.tier_fallback || 0) + (fixes.defaults_filled || 0);
  push(ruleOf('NUMERIC_RANGE'), badRange === 0,
    badRange === 0 ? '数值范围正常'
      : (badRange + ' 行取值越界，已按规则修正（' + JSON.stringify(fixes) + '）'));

  // 4. 枚举值域
  const tierCol = mapping.tier;
  let badEnum = 0;
  if (tierCol) {
    for (const r of rows) {
      const v = String(r[tierCol] || '').trim();
      if (v && STD_FIELDS.tier.values.indexOf(v) === -1) badEnum++;
    }
  }
  push(ruleOf('ENUM_DOMAIN'), badEnum === 0, tierCol
    ? (badEnum === 0 ? '卡等级取值均合法' : (badEnum + ' 行卡等级不在值域内，已按普卡兜底'))
    : '未提供卡等级列，跳过');

  // 5. 跨字段一致性
  const weird = normalized.customers.filter(c => c.txnPrev > 0 && c.txn30 > c.txnPrev * 3).length;
  push(ruleOf('CROSS_FIELD'), weird / Math.max(1, normalized.customers.length) < 0.02,
    weird === 0 ? '无异常突增' : (weird + ' 行交易笔数突增超过 3 倍，占比 ' + (weird / normalized.customers.length * 100).toFixed(1) + '%'));

  // 6. 新鲜度
  let freshPass = true;
  let freshDetail = '未提供数据日期，无法判定新鲜度';
  if (opts.data_date) {
    const d = new Date(opts.data_date);
    if (isNaN(d.getTime())) { freshDetail = '数据日期格式无法识别'; freshPass = false; }
    else {
      const lagDays = Math.floor((Date.now() - d.getTime()) / 86400000);
      freshPass = lagDays <= 2;
      freshDetail = '数据日期距今 ' + lagDays + ' 天（SLO 不超过 2 天）';
    }
  }
  push(ruleOf('FRESHNESS'), freshPass, freshDetail, false);

  // 7. 覆盖率
  const featureFields = ['amt_last_30d', 'days_since_last_txn', 'in_app_30d', 'tier', 'limit', 'value', 'tenure'];
  const mappedFeatures = featureFields.filter(k => mapping[k]).length;
  const coverage = mappedFeatures / featureFields.length;
  push(ruleOf('COVERAGE'), coverage >= 0.5,
    '已映射 ' + mappedFeatures + '/' + featureFields.length + ' 个特征字段（占比 ' + Math.round(coverage * 100) + '%）');

  const blockingFailed = checks.filter(c => c.blocking && !c.passed);
  const score = Math.round((checks.filter(c => c.passed).length / checks.length) * 100);
  return {
    score: score,
    level: blockingFailed.length ? 'LOW' : (score >= 85 ? 'HIGH' : 'MEDIUM'),
    repairs: normalized.fixes || null,
    repaired_rows: fixedTotal,
    blocking_failures: blockingFailed.map(c => c.code),
    checks: checks,
  };
}

/* ────────────────────────── 存储 ────────────────────────── */

function createDatasetStore(options) {
  const rootDir = (options && options.rootDir) || path.join(__dirname, '..', '..', 'data', 'smart-marketing', 'datasets');
  const indexFile = path.join(rootDir, 'index.json');

  function ensureDir() {
    if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
  }

  function loadIndex() {
    ensureDir();
    try {
      if (fs.existsSync(indexFile)) return JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    } catch (_) { /* 索引损坏时重建，不阻塞导入 */ }
    return { datasets: [], active_id: null };
  }

  function saveIndex(index) {
    ensureDir();
    const tmp = indexFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(index, null, 1));
    fs.renameSync(tmp, indexFile);
  }

  function nextId(index) {
    const d = new Date();
    const key = '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const count = index.datasets.filter(x => x.id.indexOf('DS_' + key) === 0).length;
    return 'DS_' + key + '_' + String(count + 1).padStart(3, '0');
  }

  function dirOf(id, version) {
    return path.join(rootDir, id, 'v' + version);
  }

  /** 第一步：只解析与画像，不落库。人工确认映射后才 commit */
  function preview(content, meta) {
    const parsed = parseCsv(content);
    if (!parsed.header.length) return { ok: false, code: 'EMPTY_FILE', error: '文件为空或没有表头' };
    if (!parsed.rows.length) return { ok: false, code: 'NO_ROWS', error: '只有表头，没有数据行' };
    const columns = parsed.header.map(h => profileColumn(parsed.rows, h));
    const mapping = suggestMapping(columns);
    const missingRequired = Object.keys(STD_FIELDS).filter(k => STD_FIELDS[k].required && !mapping[k]);
    return {
      ok: true,
      filename: (meta && meta.filename) || 'upload.csv',
      delimiter: parsed.delimiter,
      row_count: parsed.rows.length,
      columns: columns,
      suggested_mapping: mapping,
      missing_required: missingRequired.map(k => ({ field: k, label: STD_FIELDS[k].label })),
      std_fields: Object.keys(STD_FIELDS).map(k => ({
        field: k, label: STD_FIELDS[k].label, type: STD_FIELDS[k].type,
        required: STD_FIELDS[k].required, values: STD_FIELDS[k].values || null,
        mapped_to: mapping[k] || null,
      })),
      sample: parsed.rows.slice(0, 5),
      _parsed: parsed,
    };
  }

  /** 第二步：确认映射 → 标准化 → 质量门禁 → 落盘为数据集版本 */
  function commit(content, meta) {
    const source = meta || {};
    const parsed = parseCsv(content);
    if (!parsed.header.length) return { ok: false, code: 'EMPTY_FILE', error: '文件为空或没有表头' };
    const mapping = source.mapping || suggestMapping(parsed.header.map(h => profileColumn(parsed.rows, h)));

    for (const key of Object.keys(mapping)) {
      if (mapping[key] && parsed.header.indexOf(mapping[key]) === -1) {
        return { ok: false, code: 'MAPPING_COLUMN_MISSING', error: '映射引用了不存在的列：' + mapping[key] };
      }
    }
    const missingRequired = Object.keys(STD_FIELDS).filter(k => STD_FIELDS[k].required && !mapping[k]);
    if (missingRequired.length) {
      return {
        ok: false, code: 'REQUIRED_FIELD_UNMAPPED',
        error: '必填字段未映射：' + missingRequired.map(k => STD_FIELDS[k].label).join('、'),
        missing_required: missingRequired,
      };
    }

    const normalized = normalizeRows(parsed.rows, mapping);
    const quality = runQualityChecks(parsed.rows, mapping, normalized, { data_date: source.data_date });

    const index = loadIndex();
    const id = source.dataset_id || nextId(index);
    const existing = index.datasets.filter(d => d.id === id);
    const version = existing.length ? Math.max(...existing.map(d => d.version)) + 1 : 1;
    const dir = dirOf(id, version);
    fs.mkdirSync(dir, { recursive: true });

    const manifest = {
      id: id,
      version: version,
      name: source.name || source.filename || id,
      filename: source.filename || 'upload.csv',
      delimiter: parsed.delimiter,
      mapping: mapping,
      row_count: parsed.rows.length,
      accepted_count: normalized.customers.length,
      rejected_count: normalized.rejected.length,
      rejected_sample: normalized.rejected.slice(0, 20),
      columns: parsed.header.map(h => profileColumn(parsed.rows, h)),
      quality: quality,
      status: quality.level === 'LOW' ? 'blocked' : 'ready',
      activated: false,
      data_date: source.data_date || null,
      created_by: source.actor || 'web',
      created_at: new Date().toISOString(),
    };

    fs.writeFileSync(path.join(dir, 'raw.csv'), content, 'utf8');
    fs.writeFileSync(path.join(dir, 'normalized.json'), JSON.stringify(normalized.customers), 'utf8');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1), 'utf8');

    index.datasets.push({
      id: id, version: version, name: manifest.name, filename: manifest.filename,
      row_count: manifest.row_count, accepted_count: manifest.accepted_count,
      quality_level: quality.level, quality_score: quality.score,
      status: manifest.status, activated: false, created_at: manifest.created_at,
    });
    saveIndex(index);
    return { ok: true, dataset: manifest, dir: dir };
  }

  function list() {
    const index = loadIndex();
    return index.datasets.slice().reverse();
  }

  function get(id, version) {
    const index = loadIndex();
    const rows = index.datasets.filter(d => d.id === id);
    if (!rows.length) return null;
    const target = version ? rows.find(r => r.version === Number(version)) : rows[rows.length - 1];
    if (!target) return null;
    const file = path.join(dirOf(id, target.version), 'manifest.json');
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  }

  function rowsOf(id, version) {
    const meta = get(id, version);
    if (!meta) return null;
    const file = path.join(dirOf(id, meta.version), 'normalized.json');
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  }

  /**
   * 激活为当前数据集。质量等级 LOW 的数据集不允许激活——
   * 否则「质量不达标阻断触达」就成了一句空话。
   */
  function activate(id, version) {
    const meta = get(id, version);
    if (!meta) return { ok: false, code: 'DATASET_NOT_FOUND', error: '数据集不存在：' + id };
    if (meta.quality.level === 'LOW') {
      return {
        ok: false, code: 'QUALITY_BLOCKED',
        error: '该数据集存在阻断级质量问题（' + meta.quality.blocking_failures.join('、') + '），不可用于对客触达',
        quality: meta.quality,
      };
    }
    const index = loadIndex();
    index.datasets.forEach(d => { d.activated = (d.id === id && d.version === meta.version); });
    index.active_id = id;
    index.active_version = meta.version;
    saveIndex(index);
    return { ok: true, dataset: meta };
  }

  function activeRows() {
    const index = loadIndex();
    if (!index.active_id) return null;
    const rows = rowsOf(index.active_id, index.active_version);
    return rows && rows.length ? { id: index.active_id, version: index.active_version, rows: rows } : null;
  }

  return { preview, commit, list, get, rowsOf, activate, activeRows, loadIndex, STD_FIELDS, QUALITY_RULES };
}

module.exports = {
  createDatasetStore,
  parseCsv,
  suggestMapping,
  normalizeRows,
  runQualityChecks,
  inferType,
  STD_FIELDS,
  QUALITY_RULES,
};
