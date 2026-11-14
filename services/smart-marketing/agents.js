'use strict';

/**
 * 智能营销 · Agent 调用层
 *
 * 三个设计约束（对应方案 V2.0 第七、八章）：
 *   1. 复用平台既有模型网关（/api/ai-bank/v1/internal/model/v1），不新增模型接入；
 *   2. 模型只负责「把结构化事实说成人话」，所有数字由程序回填并做白名单校验，
 *      输出里出现输入中不存在的数字即判违规并降级模板——这条是合规底线，不是优化项；
 *   3. Agent 输出永远是「建议」，不产生副作用；写操作必须经调用方 + 闸门 + 人工确认。
 *
 * 运行时不可用时全部降级为确定性模板，接口形态不变。
 */

const fs = require('node:fs');

const MODEL_ENDPOINT = process.env.SM_MODEL_ENDPOINT
  || 'http://127.0.0.1:3000/api/ai-bank/v1/internal/model/v1/chat/completions';
const TOKEN_FILE = process.env.AI_BANK_AGENT_RUNTIME_TOKEN_FILE || '/run/ai-bank-secrets/runtime-token';
const TOKEN_ENV = process.env.AI_BANK_AGENT_RUNTIME_TOKEN || '';
const PROMPT_VERSION = 'sm-agent-2026-11-v1';
const CALL_TIMEOUT_MS = Number(process.env.SM_MODEL_TIMEOUT_MS || 25000);

const CHANNEL_WHITELIST = ['APP 推送', '短信', '智能外呼', '人工外呼', '企微', '权益中心'];

/**
 * 结构性常量：时间窗口、档位数、百分比等语义数字。
 * 它们是对事实的「表述方式」，不是新信息；不放进白名单会把「近 30 天」误判为编造，
 * 导致所有正常输出都被降级——那是把校验做成摆设。金额、笔数、收益等业务数字仍必须来自事实。
 */
const STRUCTURAL_NUMBERS = [0, 1, 2, 3, 4, 7, 12, 24, 30, 90, 100, 365];
const FORBIDDEN_WORDS = ['保本', '稳赚', '无风险', '必过', '百分百', '承诺收益', '刚性兑付'];

/* ────────────────────────── 基础设施 ────────────────────────── */

let tokenCache = { value: '', at: 0 };

function loadServiceToken() {
  const now = Date.now();
  if (tokenCache.value && now - tokenCache.at < 60000) return tokenCache.value;
  if (TOKEN_ENV) {
    tokenCache = { value: TOKEN_ENV.trim(), at: now };
    return tokenCache.value;
  }
  try {
    const value = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    tokenCache = { value: value, at: now };
    return value;
  } catch (_) {
    return '';
  }
}

/** 从模型返回文本里抽出 JSON：容忍 ```json 围栏与前后废话 */
function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

async function callModel(options) {
  const source = options || {};
  const token = loadServiceToken();
  if (!token) {
    return { ok: false, code: 'MODEL_TOKEN_UNAVAILABLE', error: '内部模型身份不可用（未读到服务令牌）' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), source.timeoutMs || CALL_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const payload = {
      model: source.model || 'default',
      messages: [
        { role: 'system', content: source.system },
        { role: 'user', content: source.user },
      ],
      temperature: source.temperature === undefined ? 0.2 : source.temperature,
      max_tokens: source.maxTokens || 900,
    };
    if (source.tools) {
      payload.tools = source.tools;
      payload.tool_choice = source.toolChoice || 'auto';
    }
    const response = await fetch(MODEL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        code: 'MODEL_HTTP_' + response.status,
        error: '模型服务返回 ' + response.status,
        elapsed_ms: Date.now() - startedAt,
        raw: text.slice(0, 400),
      };
    }
    let body = null;
    try { body = JSON.parse(text); } catch (_) { body = null; }
    const message = body && body.choices && body.choices[0] && body.choices[0].message;
    const content = (message && message.content) || '';
    // 结构化输出优先：function calling 由 schema 约束形状，比让模型手写 JSON 稳定得多
    let tool = null;
    const call = message && Array.isArray(message.tool_calls) ? message.tool_calls[0] : null;
    if (call && call.function) {
      let args = null;
      let parseOk = false;
      try { args = JSON.parse(call.function.arguments || ''); parseOk = true; } catch (_) { parseOk = false; }
      tool = { name: call.function.name, args: args, parse_ok: parseOk };
    }
    return {
      ok: true,
      content: content,
      tool: tool,
      model: (body && body.model) || source.model || 'unknown',
      usage: (body && body.usage) || {},
      elapsed_ms: Date.now() - startedAt,
    };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    return {
      ok: false,
      code: aborted ? 'MODEL_TIMEOUT' : 'MODEL_UNAVAILABLE',
      error: aborted ? '模型调用超时' : ('模型服务不可用：' + (error && error.message)),
      elapsed_ms: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ────────────────────────── 数字白名单校验 ────────────────────────── */

function numberVariants(value) {
  const out = [value];
  out.push(value * 100);          // 比率 → 百分数（0.245 → 24.5）
  if (value !== 0) out.push(value / 100); // 百分数 → 比率
  return out;
}

/** 收集允许出现的数字集合：四舍五入到 0/1/2 位小数，容忍常见表述 */
function buildAllowedNumbers(values) {
  const set = new Set();
  for (const v of values) {
    if (typeof v !== 'number' || !isFinite(v)) continue;
    for (const variant of numberVariants(v)) {
      for (const digits of [0, 1, 2]) {
        set.add(Number(variant.toFixed(digits)));
      }
    }
  }
  return set;
}

/** 提取文本中所有数字（去掉千分位后解析），返回原样 token 以便定位 */
function numbersInText(text) {
  const cleaned = String(text || '').replace(/(\d),(?=\d{3})/g, '$1');
  const found = [];
  const re = /\d+(?:\.\d+)?/g;
  let match;
  while ((match = re.exec(cleaned)) !== null) {
    found.push({ raw: match[0], value: Number(match[0]) });
  }
  return found;
}

/**
 * 关键字段核对：结构性常量放行「30 天」这类窗口表述后，模型可能把窗口天数当成"距上次消费天数"。
 * 对「X 天前」这种有唯一正确值的事实表述单独核对，不一致即判违规。
 */
function checkDayClaims(text, facts) {
  const violations = [];
  if (!facts || typeof facts.days_since_last_txn !== 'number') return violations;
  const re = /(\d+)\s*天前/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const value = Number(m[1]);
    if (value !== facts.days_since_last_txn) {
      violations.push(m[0].trim() + '(应为 ' + facts.days_since_last_txn + ' 天)');
    }
  }
  return violations;
}

function checkNumberWhitelist(text, allowedNumbers) {
  const violations = [];
  for (const item of numbersInText(text)) {
    if (allowedNumbers.has(item.value)) continue;
    if (!isFinite(item.value)) continue;
    // 容差：允许 ±0.05 的舍入差（如 24.48 → 24.5）
    let matched = false;
    for (const allowed of allowedNumbers) {
      if (Math.abs(allowed - item.value) <= 0.05) { matched = true; break; }
    }
    if (!matched) violations.push(item.raw);
  }
  return violations;
}

/* ────────────────────────── Agent A1：线索解释 ────────────────────────── */

/** 把线索的全部事实整理成「允许模型引用的数字集合」+ 事实清单 */
function buildLeadFacts(lead, evidence) {
  const drop = lead.txnPrev > 0 ? lead.txn30 / lead.txnPrev : 1;
  const dropPct = Math.round((1 - drop) * 1000) / 10;
  const facts = {
    lead_id: lead.id,
    tier: lead.tier,
    xid: lead.xid,
    txn_prev_30d: lead.txnPrev,
    txn_last_30d: lead.txn30,
    amt_last_30d: lead.amt30,
    drop_pct: dropPct,
    days_since_last_txn: lead.days,
    in_app_opens_30d: lead.inApp30,
    limit: lead.limit,
    score: lead.score,
    exp_value: lead.expValue,
    cost: lead.cost,
    channel: lead.channel,
    evidence_count: (evidence || []).length,
  };
  const numbers = Object.keys(facts)
    .filter(k => typeof facts[k] === 'number')
    .map(k => facts[k]);
  const allowed = buildAllowedNumbers(numbers.concat(STRUCTURAL_NUMBERS));
  return { facts: facts, allowed: allowed };
}

function templateExplain(facts, blockedGates) {
  const parts = [];
  parts.push('该客户近 30 天消费 ' + facts.txn_last_30d + ' 笔、金额 ¥' + facts.amt_last_30d
    + '，较前 30 天的 ' + facts.txn_prev_30d + ' 笔下降 ' + facts.drop_pct + '%，最后一次消费在 '
    + facts.days_since_last_txn + ' 天前。');
  parts.push('同期掌上生活打开 ' + facts.in_app_opens_30d + ' 次，'
    + (facts.in_app_opens_30d > 8
      ? '说明消费场景仍在，属于「有需求未转化」，不是单纯流失。'
      : '活跃度同步走低，属于流失前兆，宜早介入。'));
  parts.push('建议：' + facts.channel + ' 推送 ' + facts.tier + ' 权益包，期望收益 ¥' + facts.exp_value
    + '，本次触达成本 ¥' + facts.cost + '。'
    + (blockedGates && blockedGates.length
      ? '当前存在闸门拦截项（' + blockedGates.join('、') + '），需先处理。'
      : '闸门全部通过，可下发。'));
  return parts.join('\n');
}

const EXPLAIN_TOOL = {
  type: 'function',
  function: {
    name: 'emit_lead_explanation',
    description: '输出该线索的三段式解释',
    parameters: {
      type: 'object',
      properties: {
        why: { type: 'string', description: '为什么给这个客户，不超过 90 字' },
        evidence_summary: { type: 'array', items: { type: 'string' }, description: '2 到 3 条证据要点，每条不超过 50 字' },
        suggested_action: { type: 'string', description: '建议动作，不超过 90 字' },
      },
      required: ['why', 'suggested_action'],
    },
  },
};

const CAMPAIGN_TOOL = {
  type: 'function',
  function: {
    name: 'emit_campaign_draft',
    description: '输出营销方案草稿',
    parameters: {
      type: 'object',
      properties: {
        campaign_name: { type: 'string' },
        objective: { type: 'string', description: '一句话目标，不含数字承诺' },
        audience: {
          type: 'object',
          properties: {
            definition_id: { type: 'string' },
            size_estimate: { type: 'integer', description: '必须等于给定的人群规模' },
            criteria_summary: { type: 'string' },
          },
          required: ['size_estimate'],
        },
        offer: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            description: { type: 'string' },
            cost_per_case: { type: 'number' },
          },
          required: ['type', 'description'],
        },
        channels: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              channel: { type: 'string', enum: CHANNEL_WHITELIST },
              share: { type: 'number' },
            },
            required: ['channel', 'share'],
          },
        },
        cadence: {
          type: 'object',
          properties: {
            start_date: { type: 'string' },
            end_date: { type: 'string' },
            waves: { type: 'integer' },
            max_per_customer_per_month: { type: 'integer', description: '不超过 3' },
          },
          required: ['waves', 'max_per_customer_per_month'],
        },
        budget: {
          type: 'object',
          properties: { total: { type: 'number' }, per_case: { type: 'number' } },
          required: ['total'],
        },
        measurement: {
          type: 'object',
          properties: {
            primary_metric: { type: 'string' },
            window_days: { type: 'integer' },
            control_group_ratio: { type: 'number', description: '0.05 到 0.3' },
          },
          required: ['primary_metric', 'window_days', 'control_group_ratio'],
        },
        risks: { type: 'array', items: { type: 'string' } },
        compliance_notes: { type: 'array', items: { type: 'string' } },
        strategy_mode: {
          type: 'string',
          enum: ['group', 'segment', 'individual'],
          description: '策略粒度：group=一群一策（全客群一套策略与话术）；segment=分层群策（按子群差异化）；individual=一客一策（逐客生成推荐理由）',
        },
        segments: {
          type: 'array',
          description: '仅 segment 模式需要：2-4 个子群，每个子群给出划分标准与差异化做法',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '子群名，例如「高价值金卡」' },
              rule: { type: 'string', description: '划分标准，只能用卡等级/账龄/交易区间等已有字段' },
              offer_focus: { type: 'string', description: '这个子群的权益侧重' },
              message_angle: { type: 'string', description: '这个子群的话术切入点，不含数字承诺' },
            },
            required: ['name', 'rule', 'offer_focus'],
          },
        },
      },
      required: ['campaign_name', 'objective', 'audience', 'offer', 'channels', 'cadence', 'budget', 'measurement'],
    },
  },
};

const EXPLAIN_SYSTEM = [
  '你是银行信用卡中心的线索解释助手。你的唯一职责是把给定的结构化事实改写成业务人员能读懂的说明。',
  '硬性规则：',
  '1. 只能使用用户消息中「事实」里出现的数字。不得计算新数字、不得推算、不得使用任何未给出的数字。',
  '   特别注意：给出建议时也不能写任何数量或时限，例如不要写"15 天内触达""提升 60%""分 3 批"，',
  '   改用"尽快""短期内""分批"这类定性表述。任何建议里的新数字都会被系统判为违规并丢弃整段输出。',
  '2. 不得承诺收益、不得使用"保本/稳赚/无风险"等表述。',
  '3. 通过 emit_lead_explanation 工具输出，不要写自由文本。',
  '4. 三段文字各自不超过 90 字，中文，不要 markdown。',
].join('\n');

async function explainLead(lead, evidence, gates, options) {
  const source = options || {};
  const built = buildLeadFacts(lead, evidence);
  const blocked = (gates || []).filter(g => !g.ok && !g.na).map(g => g.id);

  const user = [
    '事实：' + JSON.stringify(built.facts),
    '证据分层：' + JSON.stringify((evidence || []).map(e => ({
      type: e.type, title: e.title, statement: e.stmt, confidence: e.conf,
    }))),
    '已拦截闸门：' + JSON.stringify(blocked),
    '请基于以上事实生成三段式说明。',
  ].join('\n');

  const started = Date.now();
  const call = await callModel({
    system: EXPLAIN_SYSTEM,
    user: user,
    maxTokens: 700,
    tools: [EXPLAIN_TOOL],
    toolChoice: { type: 'function', function: { name: 'emit_lead_explanation' } },
  });
  const auditBase = {
    agent_id: 'A1-lead-explain',
    prompt_version: PROMPT_VERSION,
    lead_id: lead.id,
    model: call.model || null,
    usage: call.usage || null,
    elapsed_ms: call.elapsed_ms || (Date.now() - started),
  };

  if (!call.ok) {
    return {
      ok: true,
      degraded: true,
      degraded_reason: call.code,
      source: 'template',
      output: {
        why: templateExplain(built.facts, blocked).split('\n')[0],
        evidence_summary: [templateExplain(built.facts, blocked).split('\n')[1]],
        suggested_action: templateExplain(built.facts, blocked).split('\n')[2],
        text: templateExplain(built.facts, blocked),
      },
      facts: built.facts,
      audit: Object.assign({}, auditBase, { violations: [], note: '模型不可用，使用确定性模板' }),
    };
  }

  const parsed = (call.tool && call.tool.args) || extractJson(call.content);
  if (!parsed || typeof parsed.why !== 'string') {
    return {
      ok: true,
      degraded: true,
      degraded_reason: 'OUTPUT_SCHEMA_INVALID',
      source: 'template',
      output: {
        why: templateExplain(built.facts, blocked).split('\n')[0],
        evidence_summary: [],
        suggested_action: templateExplain(built.facts, blocked).split('\n')[2],
        text: templateExplain(built.facts, blocked),
      },
      facts: built.facts,
      audit: Object.assign({}, auditBase, { violations: ['schema'], note: '模型输出不是合法 JSON，降级模板' }),
    };
  }

  const joined = [parsed.why, (parsed.evidence_summary || []).join(' '), parsed.suggested_action].join(' ');
  const violations = checkNumberWhitelist(joined, built.allowed)
    .concat(checkDayClaims(joined, built.facts));

  if (violations.length) {
    return {
      ok: true,
      degraded: true,
      degraded_reason: 'NUMBER_NOT_IN_FACTS',
      source: 'template',
      output: {
        why: templateExplain(built.facts, blocked).split('\n')[0],
        evidence_summary: [],
        suggested_action: templateExplain(built.facts, blocked).split('\n')[2],
        text: templateExplain(built.facts, blocked),
      },
      facts: built.facts,
      audit: Object.assign({}, auditBase, {
        violations: violations,
        note: '模型生成了事实中不存在的数字，已拒绝并降级模板',
      }),
    };
  }

  return {
    ok: true,
    degraded: false,
    source: 'agent',
    output: {
      why: String(parsed.why).slice(0, 400),
      evidence_summary: Array.isArray(parsed.evidence_summary)
        ? parsed.evidence_summary.slice(0, 4).map(s => String(s).slice(0, 200)) : [],
      suggested_action: String(parsed.suggested_action || '').slice(0, 300),
      text: [parsed.why, (parsed.evidence_summary || []).join(' '), parsed.suggested_action].join('\n'),
    },
    facts: built.facts,
    audit: Object.assign({}, auditBase, { violations: [], note: '' }),
  };
}

/* ────────────────────────── Agent A3：营销方案草稿 ────────────────────────── */

const CAMPAIGN_SYSTEM = [
  '你是银行信用卡中心的营销方案助手。你输出的是「草稿」，必须由人审批后才能执行。',
  '硬性规则：',
  '1. 只能使用用户给出的人群规模、预算上限、成本等数字，不得编造新数字。',
  '2. 渠道只能从白名单中选择：' + CHANNEL_WHITELIST.join('/') + '。',
  '3. 单客户每月触达不超过 3 次；对照组比例必须在 0.05 到 0.3 之间；观察窗口 7 到 90 天。',
  '4. 不得承诺收益，不得出现"保本/稳赚/无风险"等词。',
  '5. 通过 emit_campaign_draft 工具输出，不要写自由文本。',
  '6. 你只负责「方案级策略」：人群、权益、渠道、节奏、预算、度量。不要为每个客户单独写文案——',
  '   个体文案由模板加变量渲染。策略粒度按用户指定的 strategy_mode 执行：',
  '   group=全客群一套策略与话术；segment=必须给出 2-4 个子群（segments），子群之间权益侧重或话术切入点要有差异；',
  '   individual=给出统一的权益底线，说明个性化由逐客理由补充，不得编造客户个人事实。',
].join('\n');

/** 模型常把 channels 写成 ["APP 推送","短信"]，这里统一归一化，避免结构差异被误判成违规 */
function normalizeCampaign(draft) {
  if (!draft || typeof draft !== 'object') return draft;
  const out = JSON.parse(JSON.stringify(draft));
  const stripSpace = v => String(v || '').replace(/[\s\u3000]/g, '');
  const canonical = v => {
    const key = stripSpace(v);
    const hit = CHANNEL_WHITELIST.find(c => stripSpace(c) === key);
    return hit || String(v || '').trim();
  };
  if (Array.isArray(out.channels)) {
    const items = out.channels.map(c => {
      if (typeof c === 'string') return { channel: canonical(c), share: 0 };
      if (c && typeof c === 'object') return { channel: canonical(c.channel || c.name || ''), share: Number(c.share) || 0 };
      return { channel: '', share: 0 };
    }).filter(c => c.channel);
    const total = items.reduce((a, b) => a + (b.share > 0 ? b.share : 0), 0);
    if (items.length && total <= 0) {
      const even = Math.round((1 / items.length) * 100) / 100;
      items.forEach(c => { c.share = even; });
    }
    out.channels = items;
  }

  const num = v => { const n = Number(v); return isFinite(n) ? n : null; };
  const parseTimes = txt => {
    const m = String(txt || '').match(/每月[^\d]{0,6}(\d+)\s*次|(\d+)\s*次\s*\/?\s*月|每月不超过\s*(\d+)/);
    return m ? Number(m[1] || m[2] || m[3]) : null;
  };

  // cadence：模型常用 frequency_per_user_per_month / max_per_month 等别名，必须归到一个字段上，
  // 否则频控校验会因为「找不到字段」而静默放行——那是把合规校验做成摆设。
  const cad = out.cadence && typeof out.cadence === 'object' ? out.cadence : {};
  out.cadence = {
    start_date: cad.start_date || null,
    end_date: cad.end_date || null,
    waves: num(cad.waves) !== null ? num(cad.waves) : (num(cad.rounds) !== null ? num(cad.rounds) : 2),
    max_per_customer_per_month: (() => {
      const direct = num(cad.max_per_customer_per_month);
      if (direct !== null) return direct;
      const alias = num(cad.frequency_per_user_per_month);
      if (alias !== null) return alias;
      const alias2 = num(cad.max_per_month);
      if (alias2 !== null) return alias2;
      return parseTimes(cad.schedule || cad.frequency || cad.cadence_note);
    })(),
    schedule_note: cad.schedule || cad.cadence_note || '',
  };

  // measurement：primary_kpi / evaluation_period 等别名归一；对照组比例与窗口属方法学项，缺失补默认值
  const ms = out.measurement && typeof out.measurement === 'object' ? out.measurement : {};
  const windowFromText = (() => {
    const m = String(ms.evaluation_period || '').match(/(\d+)\s*天/);
    return m ? Number(m[1]) : null;
  })();
  out.measurement = {
    primary_metric: ms.primary_metric || ms.primary_kpi || '',
    window_days: num(ms.window_days) !== null ? num(ms.window_days) : (windowFromText !== null ? windowFromText : 30),
    control_group_ratio: num(ms.control_group_ratio) !== null ? num(ms.control_group_ratio) : 0.15,
    secondary_metric: ms.secondary_metric || ms.secondary_kpi || '',
  };

  const budget = out.budget && typeof out.budget === 'object' ? out.budget : {};
  const offer = out.offer && typeof out.offer === 'object' ? out.offer : {};
  // 模型有时把这两个列表写成多行文本（"1. xxx\n2. yyy"），下游按数组处理会崩，统一归一成数组
  const asList = function (v) {
    if (Array.isArray(v)) return v.filter(Boolean).map(String);
    if (typeof v === 'string') {
      return v.split(/\r?\n/).map(function (x) { return x.replace(/^\s*(?:\d+[.、)]|[-*·])\s*/, '').trim(); })
        .filter(Boolean);
    }
    return [];
  };
  out.risks = asList(out.risks);
  out.compliance_notes = asList(out.compliance_notes);
  out.budget = {
    total: num(budget.total),
    per_case: num(budget.per_case) !== null ? num(budget.per_case) : num(offer.cost_per_case),
  };

  // 策略粒度：模型可能漏给或写成别名，统一归一到三个值，默认一群一策。
  const modeAlias = {
    group: 'group', '一群一策': 'group', '群策': 'group', 'segment': 'segment', '分层': 'segment', '分层群策': 'segment',
    individual: 'individual', '一客一策': 'individual', '个性化': 'individual',
  };
  out.strategy_mode = modeAlias[String(out.strategy_mode || '').trim()] || out.strategy_mode || 'group';
  if (['group', 'segment', 'individual'].indexOf(out.strategy_mode) === -1) out.strategy_mode = 'group';
  if (!Array.isArray(out.segments)) out.segments = [];
  if (out.strategy_mode === 'segment' && !out.segments.length) {
    out.segments = [
      { name: '高价值卡', rule: '白金卡及以上', offer_focus: '高端权益体验', message_angle: '专属礼遇' },
      { name: '主力卡', rule: '金卡', offer_focus: '消费满减', message_angle: '日常消费回馈' },
      { name: '基础卡', rule: '普卡及以下', offer_focus: '小额立减', message_angle: '低门槛权益激活' },
    ];
  }

  return out;
}

/** 禁用词只在「对外文案」字段里查；compliance_notes 里写"不得使用保本"是合规声明，不能算违规 */function campaignCopyText(draft) {
  return [
    draft.campaign_name,
    draft.objective,
    draft.offer && draft.offer.description,
    draft.offer && draft.offer.type,
  ].filter(Boolean).map(String).join(' ');
}

function validateCampaign(draft, input) {
  const violations = [];
  const push = (code, message) => violations.push({ code: code, message: message });

  draft = normalizeCampaign(draft);
  if (!draft || typeof draft !== 'object') {
    push('SCHEMA', '输出不是合法 JSON 对象');
    return violations;
  }
  ['campaign_name', 'objective', 'audience', 'offer', 'channels', 'cadence', 'budget', 'measurement']
    .forEach(k => { if (!(k in draft)) push('MISSING_FIELD', '缺少字段 ' + k); });

  const channels = Array.isArray(draft.channels) ? draft.channels : [];
  if (!channels.length) push('CHANNEL_EMPTY', '未指定任何渠道');
  for (const ch of channels) {
    const name = ch && ch.channel;
    if (!CHANNEL_WHITELIST.includes(name)) push('CHANNEL_NOT_ALLOWED', '渠道不在白名单：' + name);
  }

  const cadence = draft.cadence || {};
  const freq = Number(cadence.max_per_customer_per_month);
  if (!isFinite(freq) || cadence.max_per_customer_per_month === null) {
    // 合规项不可验证时一律拒绝，不允许「字段没写所以跳过」
    push('FREQUENCY_UNVERIFIABLE', '无法确认单客户月触达次数，合规校验不通过');
  } else if (freq > 3) {
    push('FREQUENCY_EXCEEDED', '单客户月触达 ' + freq + ' 次，超过监管上限 3 次');
  } else if (freq < 1) {
    push('FREQUENCY_INVALID', '单客户月触达次数应不低于 1');
  }
  const waves = Number(cadence.waves);
  if (isFinite(waves) && (waves < 1 || waves > 4)) push('WAVES_OUT_OF_RANGE', '触达波次应在 1–4 之间');

  const measurement = draft.measurement || {};
  const ratio = Number(measurement.control_group_ratio);
  if (isFinite(ratio) && (ratio < 0.05 || ratio > 0.3)) {
    push('CONTROL_RATIO_INVALID', '对照组比例应在 5%–30% 之间');
  }
  const windowDays = Number(measurement.window_days);
  if (isFinite(windowDays) && (windowDays < 7 || windowDays > 90)) {
    push('WINDOW_INVALID', '观察窗口应在 7–90 天之间');
  }

  const budgetTotal = Number((draft.budget || {}).total);
  const cap = Number(input && input.budget_cap);
  if (!isFinite(budgetTotal)) {
    push('BUDGET_MISSING', '未给出预算总额，无法评估成本上限');
  } else if (isFinite(cap) && budgetTotal > cap) {
    push('BUDGET_EXCEEDED', '预算 ' + budgetTotal + ' 超过上限 ' + cap);
  }

  const audience = draft.audience || {};
  const size = Number(audience.size_estimate);
  const realSize = Number(input && input.audience_size);
  if (isFinite(size) && isFinite(realSize) && Math.abs(size - realSize) > Math.max(1, realSize * 0.02)) {
    push('AUDIENCE_SIZE_MISMATCH', '方案声明的触达规模与真实圈客数不一致（真实 ' + realSize + '）');
  }

  const copyText = campaignCopyText(draft);
  for (const word of FORBIDDEN_WORDS) {
    let idx = copyText.indexOf(word);
    while (idx !== -1) {
      const before = copyText.slice(Math.max(0, idx - 6), idx);
      const negated = /(不得|禁止|避免|杜绝|严禁|不使用|不含)/.test(before);
      if (!negated) { push('FORBIDDEN_WORD', '出现禁用表述：' + word); break; }
      idx = copyText.indexOf(word, idx + word.length);
    }
  }

  const allowed = buildAllowedNumbers([
    realSize, cap, Number(input && input.cost_per_case), 0.05, 0.3,
  ].concat(STRUCTURAL_NUMBERS));
  const extraNumbers = checkNumberWhitelist(
    [draft.budget && draft.budget.total, draft.budget && draft.budget.per_case,
     draft.offer && draft.offer.cost_per_case].join(' '), allowed);
  // 预算类数字允许等于上限与单客成本的乘积，单独放行
  const product = isFinite(cap) && isFinite(Number(input && input.cost_per_case))
    ? Number(input.cost_per_case) * (isFinite(realSize) ? realSize : 1) : null;
  for (const raw of extraNumbers) {
    const v = Number(raw);
    if (product !== null && Math.abs(v - product) <= Math.max(1, product * 0.05)) continue;
    push('NUMBER_NOT_IN_FACTS', '出现未给出的数字：' + raw);
  }

  return violations;
}

function templateCampaign(input) {
  const size = Number(input.audience_size) || 0;
  const cap = Number(input.budget_cap) || 0;
  const cost = Number(input.cost_per_case) || 0;
  const waves = 2;
  return {
    campaign_name: (input.definition_name || '消费活跃度回升') + ' · ' + (input.month || '本月') + '关怀方案',
    objective: '在 ' + input.window_days + ' 天内把目标人群的 30 天交易笔数恢复到下降前水平的 70% 以上，'
      + '并保持投诉率不高于基线。',
    audience: {
      definition_id: input.definition_id || null,
      size_estimate: size,
      criteria_summary: input.criteria_summary || '按线索定义圈选，需经闸门与频控过滤',
    },
    offer: {
      type: '权益包',
      description: '按卡等级匹配的消费满减权益，不使用返现承诺',
      cost_per_case: cost,
    },
    channels: [
      { channel: 'APP 推送', share: 0.6 },
      { channel: '短信', share: 0.4 },
    ],
    cadence: {
      start_date: input.start_date || null,
      end_date: input.end_date || null,
      waves: waves,
      max_per_customer_per_month: 2,
    },
    budget: { total: cap, per_case: cost },
    measurement: {
      primary_metric: '30 天交易笔数恢复率',
      window_days: Number(input.window_days) || 30,
      control_group_ratio: 0.15,
    },
    strategy_mode: input.strategy_mode || 'group',
    segments: input.strategy_mode === 'segment' ? [
      { name: '高价值卡', rule: '白金卡及以上', offer_focus: '高端权益体验', message_angle: '专属礼遇与额度礼遇' },
      { name: '主力卡', rule: '金卡', offer_focus: '消费满减', message_angle: '日常消费回馈' },
      { name: '基础卡', rule: '普卡及以下', offer_focus: '小额立减', message_angle: '低门槛权益激活' },
    ] : [],
    risks: ['权益成本可能高于增量收益', '短信渠道退订率上升', '人群与权益错配导致投诉'],
    compliance_notes: ['经 G1–G7 闸门过滤后下发', '单客户月触达不超过 2 次', '对照组留白 15% 不触达'],
  };
}

async function draftCampaign(input, options) {
  const source = options || {};
  const user = [
    '任务背景：' + JSON.stringify({
      definition_id: input.definition_id,
      definition_name: input.definition_name,
      criteria_summary: input.criteria_summary,
      audience_size: input.audience_size,
      budget_cap: input.budget_cap,
      cost_per_case: input.cost_per_case,
      window_days: input.window_days || 30,
      start_date: input.start_date,
      end_date: input.end_date,
      month: input.month,
      strategy_mode: input.strategy_mode || 'group',
    }),
    '请生成营销方案草稿。人群规模必须等于 audience_size，预算总额不得超过 budget_cap。'
      + 'strategy_mode=' + (input.strategy_mode || 'group') + '，请按该粒度组织策略'
      + (input.strategy_mode === 'segment' ? '（segments 必填 2-4 项）' : '') + '。',
  ].join('\n');

  const call = await callModel({
    system: CAMPAIGN_SYSTEM,
    user: user,
    maxTokens: 1400,
    temperature: 0.3,
    tools: [CAMPAIGN_TOOL],
    toolChoice: { type: 'function', function: { name: 'emit_campaign_draft' } },
  });
  const auditBase = {
    agent_id: 'A3-campaign-draft',
    prompt_version: PROMPT_VERSION,
    definition_id: input.definition_id || null,
    model: call.model || null,
    usage: call.usage || null,
    elapsed_ms: call.elapsed_ms || 0,
  };

  if (!call.ok) {
    return {
      ok: true, degraded: true, degraded_reason: call.code, source: 'template',
      draft: templateCampaign(input), violations: [],
      audit: Object.assign({}, auditBase, { note: '模型不可用，使用结构化模板' }),
    };
  }

  const parsed = normalizeCampaign((call.tool && call.tool.args) || extractJson(call.content));
  const modelViolations = validateCampaign(parsed, input);
  if (modelViolations.length) {
    // 模型草稿没过校验就回退模板，此时必须校验「回退的这份」——
    // violations 永远描述实际返回给用户的那份草稿，否则会出现「返回合规草稿却报 422」的自相矛盾。
    const fallback = templateCampaign(input);
    const fbViolations = validateCampaign(fallback, input);
    return {
      ok: fbViolations.length === 0, degraded: true, degraded_reason: 'VALIDATION_FAILED', source: 'template',
      draft: fallback, violations: fbViolations, model_violations: modelViolations,
      audit: Object.assign({}, auditBase, {
        note: '模型草稿未通过校验（' + modelViolations.length + ' 项：'
          + modelViolations.map(function (v) { return v.code; }).join('/') + '），已回退结构化模板',
      }),
    };
  }

  return {
    ok: true, degraded: false, source: 'agent', draft: parsed, violations: [],
    audit: Object.assign({}, auditBase, { note: '' }),
  };
}

/* ────────────────────────── Agent A2：通话质检（骨架） ────────────────────────── */

const QA_SYSTEM = [
  '你是信用卡外呼通话质检助手。输入是通话转写文本，输出结构化质检结论。',
  '只输出 JSON：{"summary":"...","intent":"...","violations":[{"type":"...","quote":"..."}],"next_action":"..."}',
  '规则：识别是否首句告知智能语音、是否有威胁/误导/承诺收益表述、客户明确拒绝后是否继续推销。',
  '不得编造转写中不存在的内容；quote 必须逐字摘自原文。',
].join('\n');

async function reviewCall(transcript, meta) {
  const text = String(transcript || '').slice(0, 6000);
  if (!text.trim()) {
    return { ok: false, code: 'EMPTY_TRANSCRIPT', error: '通话转写为空' };
  }
  const call = await callModel({
    system: QA_SYSTEM,
    user: '通话元信息：' + JSON.stringify(meta || {}) + '\n转写：\n' + text,
    maxTokens: 900,
    temperature: 0.1,
  });
  const auditBase = {
    agent_id: 'A2-call-review',
    prompt_version: PROMPT_VERSION,
    model: call.model || null,
    usage: call.usage || null,
    elapsed_ms: call.elapsed_ms || 0,
  };
  if (!call.ok) {
    return {
      ok: false, code: call.code, error: call.error, degraded: true,
      audit: Object.assign({}, auditBase, { note: '质检依赖模型，不可用时不产出结论' }),
    };
  }
  const parsed = extractJson(call.content);
  if (!parsed) {
    return {
      ok: false, code: 'OUTPUT_SCHEMA_INVALID', error: '模型输出不是合法 JSON', degraded: true,
      audit: Object.assign({}, auditBase, { note: 'schema 校验失败' }),
    };
  }
  const quotes = Array.isArray(parsed.violations) ? parsed.violations : [];
  const fabricated = quotes.filter(v => v && v.quote && !text.includes(String(v.quote).trim()));
  return {
    ok: true,
    degraded: false,
    result: parsed,
    fabricated_quotes: fabricated.map(v => v.quote),
    audit: Object.assign({}, auditBase, {
      note: fabricated.length ? '存在无法在原文定位的引用，需人工复核' : '',
    }),
  };
}

/* ────────────────────────── 能力目录 ────────────────────────── */

function catalog() {
  return {
    runtime: {
      kind: 'platform-model-gateway',
      endpoint: MODEL_ENDPOINT.replace(/\/chat\/completions$/, ''),
      upstream_model: 'qwen (via ai-harbor gateway)',
      agent_framework: 'openJiuwen / Hermes（ontomind-agent，可承载 SKILL.md 技能）',
      hermes_skills_endpoint: 'http://ontomind-agent:8000/agent/hermes/skills',
      token_available: Boolean(loadServiceToken()),
    },
    agents: [
      {
        agent_id: 'A1-lead-explain',
        name: '线索解释',
        purpose: '把证据链与数值改写成业务可读的三段式说明',
        writes_business_data: false,
        requires_human_confirm: false,
        guards: ['数字白名单校验', '禁用词过滤', 'JSON schema 校验', '失败降级模板'],
      },
      {
        agent_id: 'A3-campaign-draft',
        name: '营销方案草稿',
        purpose: '根据线索定义与预算生成结构化方案草稿，供人审批',
        writes_business_data: false,
        requires_human_confirm: true,
        guards: ['渠道白名单', '频控上限 3 次/月', '对照组比例', '预算上限', '人群规模一致性', '禁用词'],
      },
      {
        agent_id: 'A2-call-review',
        name: '通话质检',
        purpose: '转写文本 → 摘要、意图、违规点，引用必须可在原文定位',
        writes_business_data: false,
        requires_human_confirm: true,
        guards: ['引用可定位校验', '不产出结论则不出结论（不猜）'],
      },
    ],
    channels_whitelist: CHANNEL_WHITELIST,
    forbidden_words: FORBIDDEN_WORDS,
  };
}

module.exports = {
  catalog: catalog,
  explainLead: explainLead,
  draftCampaign: draftCampaign,
  reviewCall: reviewCall,
  callModel: callModel,
  validateCampaign: validateCampaign,
  buildAllowedNumbers: buildAllowedNumbers,
  checkNumberWhitelist: checkNumberWhitelist,
  templateCampaign: templateCampaign,
  CHANNEL_WHITELIST: CHANNEL_WHITELIST,
  PROMPT_VERSION: PROMPT_VERSION,
};
