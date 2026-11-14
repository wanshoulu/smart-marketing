'use strict';

/**
 * 智能营销 · 执行层（方案 → 任务单 → 回执 → 结果）
 *
 * 四张实体，解决「漏斗到已转化就断掉」的问题：
 *   Campaign  营销方案：人审批后才可拆任务
 *   Task      任务单：携带闸门快照与频控额度，真正下发到外呼/短信系统
 *   Execution 逐客户回执：T+1 回传接通、时长、挂断原因
 *   Outcome   结果：30 天转化/投诉/退订，喂给效果看板与算子回溯
 *
 * 两条硬规则：
 *   1. 任务单必须带下发时刻的闸门快照——事后审计要能回答「当时为什么判定合规」；
 *   2. 频控按「本月已进入任务单的次数」计算，不是按已接通次数——否则反复下发不会触发上限。
 */

const CHANNEL_TASK_TYPE = {
  'APP 推送': 'APP推送',
  '短信': '短信',
  '智能外呼': '外呼',
  '人工外呼': '外呼',
  '企微': '企微',
  '权益中心': '权益',
};

const TEMPLATE_BY_TYPE = {
  'APP推送': { id: 'TPL_APP_CARE_003', version: 'v3' },
  '短信': { id: 'TPL_SMS_CARE_003', version: 'v3' },
  '外呼': { id: 'TPL_CALL_CARE_003', version: 'v3' },
  '企微': { id: 'TPL_WECOM_CARE_001', version: 'v1' },
  '权益': { id: 'TPL_BENEFIT_CARE_003', version: 'v2' },
};

/**
 * 话术模板：一个任务单共用一套模板，个体差异靠变量填充。
 * 这是「一类用户一份方案、而不是一人一份方案」的落地方式：
 * 策略（权益、卖点、节奏、合规约束）统一，称呼/等级/金额等由变量个性化。
 */
const MESSAGE_TEMPLATES = {
  'APP推送': {
    id: 'TPL_APP_CARE_003', version: 'v3', channel: 'APP推送',
    title: '{name}，您的专属权益待领取',
    body: '{name}，您{tier}近 30 天消费 {txn30} 笔，专属{offer_name}已到账：{offer_desc}。有效期至 {end_date}，点击查看 ›',
    slots: ['name', 'tier', 'txn30', 'offer_name', 'offer_desc', 'end_date'],
    variables_note: '称呼、卡等级、交易笔数来自客户底表；权益名称与描述来自方案 offer；截止日来自方案 cadence',
  },
  '短信': {
    id: 'TPL_SMS_CARE_003', version: 'v3', channel: '短信',
    title: '',
    body: '【招行信用卡】{name}，您{tier}近 30 天消费 {txn30} 笔，{offer_name}已为您预留：{offer_desc}。回复 TD 退订。',
    slots: ['name', 'tier', 'txn30', 'offer_name', 'offer_desc'],
    variables_note: '短信受 70 字限制，变量取最短形式；退订指引为合规必填项',
  },
  '外呼': {
    id: 'TPL_CALL_CARE_003', version: 'v3', channel: '外呼',
    title: '外呼话术（A/B 段）',
    // v3：开场第一句强制声明 AI 身份（codex 审核 P0：平台自述「AI 外呼还须声明非人工」，
    // 实际话术却从未披露，G7 闸门恒通过属漏报）。AI 声明段置于最前，渠道系统整段播报。
    body: '【AI 声明】本通话由招商银行智能语音助手为您服务，是机器人民呼，不是人工坐席。'
      + '【开场】{name}您好，这里是招商银行信用卡中心，工号 {agent_id}，本次通话已录音。'
      + '【事由】注意到您{tier}近 30 天消费 {txn30} 笔，比此前有所下降，想为您介绍{offer_name}：{offer_desc}。'
      + '【确认】这项权益需要您本人确认，现在方便吗？',
    slots: ['name', 'tier', 'txn30', 'agent_id', 'offer_name', 'offer_desc'],
    variables_note: '外呼须先播报 AI 身份声明（非人工）→ 工号与录音告知；金额与收益类承诺一律不得出现',
  },
  '企微': {
    id: 'TPL_WECOM_CARE_001', version: 'v1', channel: '企微',
    title: '{name}，为您留了一份专属礼遇',
    body: '{name}，您{tier}的{offer_name}已生效：{offer_desc}。有问题随时找我，我是您的专属客户经理。',
    slots: ['name', 'tier', 'offer_name', 'offer_desc'],
    variables_note: '企微需带客户经理署名，禁止群发式统一话术',
  },
  '权益': {
    id: 'TPL_BENEFIT_CARE_003', version: 'v2', channel: '权益',
    title: '权益已入账',
    body: '{name}，{offer_name}已发放至您的账户：{offer_desc}，可在掌上生活-我的权益查看。',
    slots: ['name', 'offer_name', 'offer_desc'],
    variables_note: '权益中心以到账通知为主，不含营销诱导语',
  },
};

const CAMPAIGN_STATES = ['草稿', '待审批', '已批准', '排期中', '执行中', '已完成', '已终止'];
const CAMPAIGN_TRANSITIONS = {
  '草稿': ['待审批', '已终止'],
  '待审批': ['已批准', '草稿', '已终止'],
  '已批准': ['排期中', '已终止'],
  '排期中': ['执行中', '已终止'],
  '执行中': ['已完成', '已终止'],
  '已完成': [],
  '已终止': [],
};

const TASK_STATES = ['草稿', '待审批', '已批准', '执行中', '已暂停', '已完成', '已终止'];
const TASK_TRANSITIONS = {
  '草稿': ['待审批', '已终止'],
  '待审批': ['已批准', '草稿', '已终止'],
  '已批准': ['执行中', '已终止'],
  '执行中': ['已暂停', '已完成', '已终止'],
  '已暂停': ['执行中', '已终止'],
  '已完成': [],
  '已终止': [],
};

/* 渠道事件字典（codex 二审 MKT-16：外呼不存在「点击」——事件与渠道错配会污染
   状态机和报表。按渠道定义合法事件；跨渠道事件被拒收并在 rejected 里说明。 */
const RECEIPT_RESULTS_BY_CHANNEL = {
  '外呼': ['接通', '未接通', '拒绝', '空号', '退订', '投诉'],
  '短信': ['送达', '发送失败', '退订', '投诉'],
  'APP推送': ['送达', '点击', '发送失败', '退订'],
  '企微': ['送达', '点击', '退订'],
  '权益中心': ['送达', '核销'],
};
// 兼容旧数据的全量字典（校验入口按渠道走 RECEIPT_RESULTS_BY_CHANNEL）
const RECEIPT_RESULTS = Object.values(RECEIPT_RESULTS_BY_CHANNEL).reduce((a, l) => { l.forEach(x => { if (a.indexOf(x) === -1) a.push(x); }); return a; }, []);
const OUTCOME_TO_LEAD_STATUS = {
  '接通': '已触达',
  '点击': '已响应',
  '拒绝': '已响应',
  '未接通': '已下发',
  '送达': '已下发',
};

function pad(n, width) {
  return String(n).padStart(width, '0');
}

function todayKey(date) {
  const d = date || new Date();
  return '' + d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2);
}

function monthKey(date) {
  const d = date || new Date();
  return '' + d.getFullYear() + pad(d.getMonth() + 1, 2);
}

function createTaskStore(deps) {
  const state = deps.state;
  const persist = deps.persist;
  const audit = deps.audit || function () {};
  const engine = deps.engine;
  // 触达设计联动：routes 注入 scriptOpeningOf(id) → 返回话术方案 {id,name,stage,version,nodes}
  // 没注入时（单测环境）外呼话术回退静态模板，行为与旧版一致。
  const scriptOpeningOf = deps.scriptOpeningOf || null;
  // 素材库联动：routes 注入 creativeOf(id) → 返回素材 {id,channel,title,body,version}
  const creativeOf = deps.creativeOf || null;

  // 兼容旧状态文件：缺字段时补空数组，不覆盖已有数据
  ['campaigns', 'tasks', 'executions', 'outcomes'].forEach(function (k) {
    if (!Array.isArray(state[k])) state[k] = [];
  });

  function nextId(prefix, list) {
    // 取当日最大流水号 +1，而不是当日条数 +1。
    // 用条数会在删除过记录后撞号（历史 bug：001/004/005 三条 → 数量 3 → 新号 004 与既有排期中方案重复，
    // 导致提交审批作用到了别人的方案上，state 出现重复 ID）。
    const key = todayKey();
    const head = prefix + '_' + key + '_';
    let max = 0;
    list.forEach(function (x) {
      if (typeof x.id !== 'string' || x.id.indexOf(head) !== 0) return;
      const n = parseInt(x.id.slice(head.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    });
    return head + pad(max + 1, 3);
  }

  /* ────────────────── 方案 ────────────────── */

  function listCampaigns() {
    return state.campaigns.slice().reverse();
  }

  function campaignById(id) {
    return state.campaigns.find(function (c) { return c.id === id; }) || null;
  }

  /** 模型/前端都可能把列表字段传成多行文本，落库前统一成字符串数组 */
  function asList(v) {
    if (Array.isArray(v)) return v.filter(Boolean).map(String);
    if (typeof v === 'string') {
      return v.split(/\r?\n/).map(function (x) { return x.replace(/^\s*(?:\d+[.、)]|[-*·])\s*/, '').trim(); }).filter(Boolean);
    }
    return [];
  }

  /**
   * 编辑方案：只允许在「草稿」「待审批」阶段改配置。
   * 已批准之后改预算/渠道等于换了一个方案，必须重新走审批，不能静默覆盖。
   */
  function updateCampaign(id, patch, ctx) {
    const item = campaignById(id);
    if (!item) return { ok: false, code: 'CAMPAIGN_NOT_FOUND', error: '方案不存在：' + id };
    if (['草稿', '待审批'].indexOf(item.status) === -1) {
      return { ok: false, code: 'CAMPAIGN_LOCKED', error: '方案当前为「' + item.status + '」，已进入执行链路，修改需新建版本' };
    }
    const p = patch || {};
    const editable = ['name', 'objective', 'definition_id', 'audience_size', 'criteria_summary',
      'offer', 'channels', 'cadence', 'budget', 'measurement', 'strategy_mode', 'segments', 'risks', 'compliance_notes'];
    const before = {};
    editable.forEach(function (k) {
      if (p[k] === undefined) return;
      before[k] = item[k];
      item[k] = (k === 'risks' || k === 'compliance_notes') ? asList(p[k]) : p[k];
    });
    // 绑定资产随编辑更新（null = 解绑回默认）
    if (p.script_id !== undefined || p.creative_id !== undefined || p.slot_id !== undefined) {
      before.cfg = item.cfg;
      item.cfg = Object.assign({}, item.cfg, {
        script_id: p.script_id !== undefined ? (p.script_id || null) : (item.cfg || {}).script_id,
        creative_id: p.creative_id !== undefined ? (p.creative_id || null) : (item.cfg || {}).creative_id,
        slot_id: p.slot_id !== undefined ? (p.slot_id || null) : (item.cfg || {}).slot_id,
      });
    }
    item.updated_at = new Date().toISOString();
    item.updated_by = (ctx && ctx.actor) || 'web';
    audit({ actor: item.updated_by, action: 'campaign.update', target: item.id, detail: '修改字段 ' + Object.keys(before).join(',') });
    persist();
    return { ok: true, item: item, changed: Object.keys(before) };
  }

  function createCampaign(input) {
    const draft = input && input.draft ? input.draft : {};
    const now = new Date().toISOString();
    const item = {
      id: nextId('CMP', state.campaigns),
      name: draft.campaign_name || input.name || '未命名方案',
      objective: draft.objective || '',
      definition_id: (draft.audience && draft.audience.definition_id) || input.definition_id || null,
      audience_size: Number((draft.audience && draft.audience.size_estimate) || input.audience_size || 0),
      criteria_summary: (draft.audience && draft.audience.criteria_summary) || input.criteria_summary || '',
      offer: draft.offer || {},
      channels: Array.isArray(draft.channels) ? draft.channels : [],
      cadence: draft.cadence || {},
      budget: draft.budget || {},
      measurement: draft.measurement || {},
      risks: asList(draft.risks),
      compliance_notes: asList(draft.compliance_notes),
      // 策略粒度决定下游每个客户拿到什么文案，必须随方案一起落库，不能只在生成时用一次
      strategy_mode: draft.strategy_mode || input.strategy_mode || 'group',
      segments: Array.isArray(draft.segments) ? draft.segments : (input.segments || []),
      // 触达设计联动：绑定的外呼话术方案（renderMessage 外呼渠道会取其开场白作底稿）
      cfg: {
        script_id: (draft.script_id || input.script_id || null),
        creative_id: (draft.creative_id || input.creative_id || null),
        slot_id: (draft.slot_id || input.slot_id || null),
      },
      status: '草稿',
      source: input.source || 'manual',
      agent_audit: input.agent_audit || null,
      created_by: input.actor || 'web',
      created_at: now,
      approved_by: null,
      approved_at: null,
      task_ids: [],
    };
    state.campaigns.push(item);
    audit({ actor: item.created_by, action: 'campaign.create', target: item.id, detail: item.source === 'agent' ? 'Agent 生成草稿' : '手工创建' });
    persist();
    return item;
  }

  /* 方案核心数据校验（codex 审核 P0：受众 0、渠道配比合计 10000%、预算 0 的方案
     曾一路走到「执行中」并有任务单——审批/下发门禁没有校验可执行性）。
     返回 null 表示通过，否则返回错误文案。 */
  function validateCampaignExecutable(c) {
    if (!c) return '方案不存在';
    const chs = (c.channels || []).filter(x => Number(x.share || 0) > 0);
    if (!chs.length) return '渠道配比全部为 0，方案不可执行：至少一个渠道的配比大于 0';
    // share 兼容两种口径：0-1 小数（前端 collectCfg）与 1-100 百分（历史数据）。
    // 合计必须为 100%（±0.5 容差），10000% 这类单位错误直接拦下。
    const sum = chs.reduce((a, x) => a + Number(x.share || 0), 0);
    if (sum > 1.5 && Math.abs(sum - 100) > 0.5) return '渠道配比合计异常：' + Math.round(sum) + '%（应为 100%，检查是否把小数当百分比传入）';
    if (sum <= 1.5 && Math.abs(sum - 1) > 0.005) return '渠道配比合计异常：' + Math.round(sum * 100) + '%（应为 100%）';
    const bud = c.budget || {};
    const total = Number(bud.total != null ? bud.total : bud.cap) || 0;
    if (total <= 0) return '预算总额为 0：外呼有通信成本，预算为 0 的方案不可进入执行（演示/不计费场景请明确标注）';
    const aud = Number(c.audience_size) || 0;
    if (aud <= 0) {
      // 受众 0 只在「即将拆单」时是硬伤（圈人由 definition 决定）；审批前给警告级提示
      return '受众规模为 0：请先确认目标客群定义能圈出客户，再提交审批';
    }
    return null;
  }

  function transitionCampaign(id, next, ctx) {
    const item = campaignById(id);
    if (!item) return { ok: false, code: 'CAMPAIGN_NOT_FOUND', error: '方案不存在：' + id };
    const allowed = CAMPAIGN_TRANSITIONS[item.status] || [];
    if (allowed.indexOf(next) === -1) {
      return {
        ok: false, code: 'ILLEGAL_TRANSITION',
        error: '方案状态 ' + item.status + ' 不可变更为 ' + next,
        allowed: allowed,
      };
    }
    // 审批门禁：批准 / 排期前必须过核心数据校验——受众、配比、预算缺一不可。
    // （codex 审核 P0：audience 0 / 配比 10000% / 预算 0 的方案曾直接进入执行链路）
    if (['已批准', '排期中', '执行中'].indexOf(next) !== -1) {
      const verr = validateCampaignExecutable(item);
      if (verr) return { ok: false, code: 'CAMPAIGN_INVALID', error: '方案数据未通过执行校验，禁止' + next + '：' + verr };
    }
    const from = item.status;
    item.status = next;
    if (next === '已批准') {
      item.approved_by = (ctx && ctx.actor) || 'web';
      item.approved_at = new Date().toISOString();
    }
    audit({
      actor: (ctx && ctx.actor) || 'web',
      action: 'campaign.' + next,
      target: id, from: from, to: next,
      detail: (ctx && ctx.note) || '',
    });
    persist();
    return { ok: true, item: item, from: from };
  }

  /* ────────────────── 任务单 ────────────────── */

  function listTasks(filter) {
    const f = filter || {};
    let rows = state.tasks.slice().reverse();
    if (f.status) rows = rows.filter(function (t) { return t.status === f.status; });
    if (f.campaign_id) rows = rows.filter(function (t) { return t.campaign_id === f.campaign_id; });
    if (f.type) rows = rows.filter(function (t) { return t.type === f.type; });
    return rows;
  }

  function taskById(id) {
    return state.tasks.find(function (t) { return t.id === id; }) || null;
  }

  /** 本月该客户已被排入多少任务单——只算真正下发过的（执行中/已暂停/已完成）。
   * 已批准但未下发、待审批、已终止都不占频控，否则审批流程会把配额提前吃掉。 */
  function plannedCountThisMonth(leadId, month) {
    const key = month || monthKey();
    let count = 0;
    for (const task of state.tasks) {
      if (['执行中', '已暂停', '已完成'].indexOf(task.status) === -1) continue;
      if ((task.month || '') !== key) continue;
      if (Array.isArray(task.lead_ids) && task.lead_ids.indexOf(leadId) !== -1) count++;
    }
    return count;
  }

  /**
   * 从已批准方案生成任务单：按渠道拆分，逐线索过闸门 + 频控，闸门结果写进快照。
   * 返回每个渠道的实际可下发人数与被剔除原因统计——这对业务方比「生成成功」有用得多。
   */
  function createTasksFromCampaign(id, ctx) {
    const campaign = campaignById(id);
    if (!campaign) return { ok: false, code: 'CAMPAIGN_NOT_FOUND', error: '方案不存在：' + id };
    if (['已批准', '排期中'].indexOf(campaign.status) === -1) {
      return { ok: false, code: 'CAMPAIGN_NOT_APPROVED', error: '方案当前为「' + campaign.status + '」，须先审批通过才能拆任务单' };
    }

    // 按方案的线索定义圈人（定义怎么写就圈哪些人），而不是拿全量线索。
    // 三种客群形态统一走 engine.leadsOfAudience：规则(dsl)/名单(list)/组合(combine)。
    // 无圈选内容的草案禁止回落全量名单——那会把「还没定稿的规则」变成「对全量客户营销」，是合规事故。
    const def = state.definitions.find(function (d) { return d.id === campaign.definition_id; });
    let leads = [];
    if (def) {
      const sel = engine.leadsOfAudience(def);
      if (sel.ok && sel.ids.length) {
        leads = sel.ids.map(function (lid) { return engine.leadById(lid); }).filter(Boolean);
      }
    }
    if (!leads.length) {
      const kindName = { rule: '规则', list: '名单', combine: '组合' }[def && (def.kind || (def.dsl ? 'rule' : def.list ? 'list' : def.combine ? 'combine' : null))] || '';
      return {
        ok: false, code: 'DEF_NOT_COMPILED',
        error: def
          ? '目标客群「' + (def.name || def.id) + '」' + (kindName ? '（' + kindName + '型）' : '') + '圈不出可触达客户（未发布、名单为空或组合来源不可用），不能按全量客户拆单。请先在「客群」页确认该客群状态。'
          : '目标客群不存在（' + campaign.definition_id + '），请重新选择',
      };
    }

    const cap = Number((campaign.cadence || {}).max_per_customer_per_month) || 2;
    /* MKT-15 全局频控（codex 二审）：监管上限 3 次/月是「客户级」硬约束，
       不随方案配置放宽。本方案 cap 与全局上限取小者——两个方案各自 cap=3
       也不能把同一客户触达 6 次。 */
    const GLOBAL_MONTHLY_CAP = 3;
    const effCap = Math.min(cap, GLOBAL_MONTHLY_CAP);
    const month = monthKey();
    const created = [];
    const excludedSummary = {};

    /* ① 候选池：闸门 / 频控 / 在途 / 终态统一过一遍，得到本次真正可触达的人。
       旧实现是每个渠道各自过一遍，于是每个渠道都拿到全量名单。 */
    const pool = [];
    const gateSnapshot = [];
    let excludedGates = 0;
    let excludedFreq = 0;
    let excludedTerminal = 0;
    let excludedInflight = 0;

    for (const lead of leads) {
      const real = engine.leadById(lead.id);
      if (!real) continue;
      // 终态线索不再进新任务单：已转化的重复触达会拉低有效率，已关闭的属于明确拒绝
      if (real.status === '已关闭' || real.status === '已转化') { excludedTerminal++; continue; }
      // 在途线索（已下发 / 已触达 / 已响应）已经在某个方案的触达链路里。
      // 若仍拆进新任务单，任务单人数会虚高，下发时又会因「已在流程中」被整批跳过，
      // 结果是 0 人真实触达、0 条回执、复盘永远得不出结论。必须在拆单阶段就排除。
      if (real.status !== '待指认') { excludedInflight++; continue; }
      const gates = engine.gatesOf(real);
      const failed = gates.filter(function (g) { return !g.ok && !g.na; });
      if (failed.length) {
        excludedGates++;
        gateSnapshot.push({
          lead_id: real.id, gate_ids: failed.map(function (g) { return g.id; }),
          reasons: failed.map(function (g) { return g.desc || g.n; }),
        });
        continue;
      }
      if (plannedCountThisMonth(real.id, month) >= effCap) {
        excludedFreq++;
        continue;
      }
      pool.push(real);
    }

    const excludedBase = {
      excludedGates: excludedGates, excludedFreq: excludedFreq,
      excludedTerminal: excludedTerminal, excludedInflight: excludedInflight,
    };

    /* ③ 渠道 share 是「人数配额」，不是「每人全渠道」。
       按配额把名单切成互斥子集，否则三个渠道各拿全量名单 → 同一客户被同时触达 3 次，
       单客月触达直接等于渠道数，击穿方案频控与监管 3 次/月上限，护栏会立刻报警。 */

    // 方案里填的「面向人数」是上限：定义能圈 240 人，但方案只打算投 200 人，
    // 就按优先级截到 200。否则方案列表写 200、任务单合计 239，业务会问「到底投了多少人」。
    const sizeCap = Number(campaign.audience_size) || 0;
    if (sizeCap > 0 && pool.length > sizeCap) pool.length = sizeCap;

    /* ② A/B 真实分流（老师建议的核心机制）：按方案的对照组留白比例，
       把可触达池随机分成「实验组（会被触达）」与「对照组（留白不触达）」。
       对照组不生成任务单——它就是「不做营销时的自然转化基线」，复盘时用
       实验组转化率 − 对照组转化率 剥离自然恢复，得到因果增量。
       分流名单快照落库：事后审计要能回答「谁在对照组、为什么没收到」。 */
    const ctrlRatio = Math.min(0.5, Math.max(0.05, Number((campaign.measurement || {}).control_group_ratio) || 0));
    const abSplit = { enabled: ctrlRatio > 0, ratio: ctrlRatio, control_ids: [], treat_ids: [], seed: campaign.id };
    if (abSplit.enabled) {
      // 确定性洗牌（seed=方案ID）：同一方案重拆单时分组一致，审计可复现
      const shuffled = pool.slice();
      let sd = 0;
      for (let i = 0; i < String(abSplit.seed).length; i++) sd = (sd * 31 + String(abSplit.seed).charCodeAt(i)) >>> 0;
      for (let i = shuffled.length - 1; i > 0; i--) {
        sd = (sd * 1103515245 + 12345) >>> 0;
        const j = sd % (i + 1);
        const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
      }
      const ctrlN = Math.max(1, Math.round(shuffled.length * ctrlRatio));
      abSplit.control_ids = shuffled.slice(0, ctrlN).map(function (x) { return x.id; });
      abSplit.treat_ids = shuffled.slice(ctrlN).map(function (x) { return x.id; });
    } else {
      abSplit.treat_ids = pool.map(function (x) { return x.id; });
    }
    // 后续渠道分配只吃实验组
    const treatPool = abSplit.treat_ids.map(function (id) { return pool.find(function (x) { return x.id === id; }); }).filter(Boolean);

    const chs = (campaign.channels || []).filter(function (c) {
      return CHANNEL_TASK_TYPE[c.channel] && Number(c.share || 0) > 0;
    });
    // 配额基数 = 实验组人数（对照组已被留白剔除）。
    // 之前用 pool.length，AB 启用时配额总和 > 实验组人数，最大余数法把超额名额
    // 全灌给余数最大的渠道，40/30/30 会被拆成 47/32/21。
    const allocBase = treatPool.length;
    const totalShare = chs.reduce(function (a, c) { return a + Number(c.share || 0); }, 0);
    const quotas = chs.map(function (c) {
      const exact = totalShare > 0 ? allocBase * Number(c.share || 0) / totalShare : 0;
      return { ch: c, base: Math.floor(exact), rem: exact - Math.floor(exact), ids: [] };
    });
    // 最大余数法补齐取整损失，保证各渠道名额之和 = 实验组人数
    let left = allocBase - quotas.reduce(function (a, q) { return a + q.base; }, 0);
    quotas.slice().sort(function (a, b) { return b.rem - a.rem; }).forEach(function (q) {
      if (left > 0) { q.base++; left--; }
    });

    /* ④ 分配：先满足客户的渠道偏好（偏好短信的人优先走短信），再按池顺序补足。
       两轮都从同一个 remaining 池里取，天然互斥，不会有人同时进两个渠道。 */
    const normCh = function (s) { return String(s || '').replace(/\s/g, ''); };
    const remaining = treatPool.slice();
    quotas.forEach(function (q) {
      const want = normCh(q.ch.channel);
      for (let i = remaining.length - 1; i >= 0 && q.ids.length < q.base; i--) {
        if (normCh(remaining[i].channel) === want) { q.ids.push(remaining[i].id); remaining.splice(i, 1); }
      }
    });
    quotas.forEach(function (q) {
      while (q.ids.length < q.base && remaining.length) q.ids.push(remaining.shift().id);
    });

    for (const q of quotas) {
      const ch = q.ch;
      const type = CHANNEL_TASK_TYPE[ch.channel];
      const accepted = q.ids;

      // 空名单不生成任务单：0 人任务单下发后只会产生空回执，还会让业务误以为已触达
      if (!accepted.length) {
        excludedSummary[type + '/' + ch.channel] = Object.assign({}, excludedBase, { empty: true });
        continue;
      }

      const template = TEMPLATE_BY_TYPE[type] || { id: 'TPL_DEFAULT', version: 'v1' };
      // 外呼 + 方案绑定触达设计话术 → 任务单模板血缘指向脚本（渲染时走 scriptOpeningOf 取开场白）
      const boundScript = (type === '外呼' && campaign.cfg && campaign.cfg.script_id && scriptOpeningOf)
        ? scriptOpeningOf(campaign.cfg.script_id) : null;
      // 模板血缘：外呼脚本 > 渠道匹配素材 > 静态模板（与 renderMessage 的取稿顺序一致）
      const boundCreative = (creativeOf && campaign.cfg && campaign.cfg.creative_id)
        ? creativeOf(campaign.cfg.creative_id) : null;
      const tplRef = boundScript ? { id: boundScript.id, ver: 'script-v' + (boundScript.version || 1) }
        : (boundCreative && boundCreative.channel === ch.channel ? { id: boundCreative.id, ver: 'creative-v' + (boundCreative.version || 1) }
          : { id: template.id, ver: template.version });
      const task = {
        id: nextId('TSK', state.tasks),
        campaign_id: campaign.id,
        type: type,
        channel: ch.channel,
        lead_ids: accepted,
        count: accepted.length,
        template_id: tplRef.id,
        template_version: tplRef.ver,
        month: month,
        schedule: {
          start: (campaign.cadence || {}).start_date || null,
          end: (campaign.cadence || {}).end_date || null,
          waves: Number((campaign.cadence || {}).waves) || 2,
        },
        frequency_cap: { max_per_customer_per_month: effCap, global_monthly_cap: GLOBAL_MONTHLY_CAP },
        owner: (ctx && ctx.owner) || '零售经营-王',
        sla_hours: type === '外呼' ? 48 : 24,
        gate_snapshot: gateSnapshot.slice(0, 200),
        ab_group: 'treatment',
        status: '待审批',
        created_at: new Date().toISOString(),
        dispatched_at: null,
        completed_at: null,
      };
      state.tasks.push(task);
      campaign.task_ids = (campaign.task_ids || []).concat([task.id]);
      created.push(Object.assign({
        task_id: task.id, type: task.type, channel: task.channel, count: task.count,
        excluded_gates: excludedGates, excluded_frequency: excludedFreq,
        excluded_terminal: excludedTerminal, excluded_inflight: excludedInflight,
      }));
      excludedSummary[task.type + '/' + task.channel] = Object.assign({}, excludedBase);
    }

    if (!created.length) {
      return {
        ok: false, code: 'EMPTY_AUDIENCE',
        error: '该定义圈出 ' + leads.length + ' 人，但没有一人可触达：在途（已下发/已触达/已响应）' + excludedInflight
          + '、闸门拦 ' + excludedGates + '、频控拦 ' + excludedFreq + '、终态 ' + excludedTerminal + '，未生成任务单。'
          + (excludedInflight ? '这批人正在别的方案里跑，等回执结单后再圈，或换一个线索定义。' : ''),
        audience: pool.length, excluded: excludedSummary,
      };
    }

    if (created.length) {
      // A/B 分流快照随方案落库：对照组名单、比例、种子，复盘与审计都从这里取
      campaign.ab = {
        enabled: abSplit.enabled,
        ratio: abSplit.ratio,
        seed: abSplit.seed,
        control_ids: abSplit.control_ids,
        treat_count: abSplit.treat_ids.length,
        split_at: new Date().toISOString(),
      };
      transitionCampaign(campaign.id, '排期中', { actor: (ctx && ctx.actor) || 'web', note: '已生成 ' + created.length + ' 个任务单' + (abSplit.enabled ? '（对照组留白 ' + abSplit.control_ids.length + ' 人）' : '') });
      audit({ actor: (ctx && ctx.actor) || 'web', action: 'task.create', target: campaign.id, detail: '生成任务单 ' + created.length + ' 个' + (abSplit.enabled ? ' · AB 分流 对照 ' + abSplit.control_ids.length + '/实验 ' + abSplit.treat_ids.length : '') });
      persist();
    }

    return { ok: true, campaign_id: campaign.id, tasks: created, excluded: excludedSummary, ab: { enabled: abSplit.enabled, ratio: abSplit.ratio, control: abSplit.control_ids.length, treatment: abSplit.treat_ids.length } };
  }

  /**
   * 方案状态由任务单驱动：任一任务下发 → 执行中；全部任务结束 → 已完成。
   * 之前只靠手动迁移，导致任务全跑完了复盘页还显示「排期中」，与实际执行事实不符。
   */
  function syncCampaignStatus(campaignId) {
    const c = campaignById(campaignId);
    if (!c || ['已完成', '已终止'].indexOf(c.status) !== -1) return null;
    const ts = state.tasks.filter(function (t) { return t.campaign_id === campaignId; });
    if (!ts.length) return null;
    const allDone = ts.every(function (t) { return ['已完成', '已终止'].indexOf(t.status) !== -1; });
    if (allDone && ['排期中', '执行中'].indexOf(c.status) !== -1) {
      const r = transitionCampaign(c.id, '已完成', { actor: 'system', note: '全部任务单已结束' });
      return r && r.ok ? '已完成' : null;
    }
    const running = ts.some(function (t) { return ['执行中', '已暂停'].indexOf(t.status) !== -1; });
    if (running && c.status === '排期中') {
      const r = transitionCampaign(c.id, '执行中', { actor: 'system', note: '任务单已下发' });
      return r && r.ok ? '执行中' : null;
    }
    return null;
  }

  function transitionTask(id, next, ctx) {
    const task = taskById(id);
    if (!task) return { ok: false, code: 'TASK_NOT_FOUND', error: '任务单不存在：' + id };
    const allowed = TASK_TRANSITIONS[task.status] || [];
    if (allowed.indexOf(next) === -1) {
      return {
        ok: false, code: 'ILLEGAL_TRANSITION',
        error: '任务单状态 ' + task.status + ' 不可变更为 ' + next, allowed: allowed,
      };
    }
    const from = task.status;
    // 红线暂停不可直接 resume：paused_reason=complaint_redline 的暂停必须走人工审批
    // （修改后经审批流重新批准），不能一键「恢复执行」绕过合规复核（codex 审核要求）。
    if (from === '已暂停' && next === '执行中' && task.paused_reason === 'complaint_redline') {
      return {
        ok: false, code: 'REDLINE_PAUSE_LOCKED',
        error: '该任务单因投诉率超红线被系统强制暂停，不可直接恢复。请先处理投诉与话术问题，走审批复核后再重新下发（terminate 后新建方案，或联系合规解除 paused_reason）。',
      };
    }
    // 静默时段硬阻断（调度层闸门）：外呼任务在 22:00–08:00 禁止下发。
    // 此前人群规则的 quiet_hours 只写在 DSL 里没人执行，凌晨 02:00 也能下发（codex 审核 P0）。
    if (next === '执行中') {
      const isOutboundTask = task.type === '外呼' || /外呼/.test(task.channel || '');
      if (isOutboundTask && engine.inQuietHours && engine.inQuietHours()) {
        return {
          ok: false, code: 'QUIET_HOURS_BLOCKED',
          error: '当前处于静默时段（22:00–08:00 禁呼），外呼任务单禁止下发。请在 08:00 后重试，或改用非外呼渠道。',
        };
      }
    }
    task.status = next;
    if (next === '执行中') task.dispatched_at = new Date().toISOString();
    if (next === '已完成') task.completed_at = new Date().toISOString();

    // 下发时把线索推进到「已下发」，这是链路里唯一会写业务数据的地方，必须记录下来
    if (next === '执行中') {
      let advanced = 0;
      let skipped = 0;
      const failed = [];
      for (const leadId of task.lead_ids) {
        const lead = engine.leadById(leadId);
        if (!lead) { failed.push({ lead_id: leadId, code: 'LEAD_NOT_FOUND' }); continue; }
        // 多波次触达时线索可能已在「已下发/已触达」——那是正常跳过，不是失败。
        // 只有真正的非法迁移（如已关闭）才算失败，否则下发报告会把正常情况报成大面积错误。
        if (lead.status !== '待指认') {
          if (lead.status === '已关闭') { failed.push({ lead_id: leadId, code: 'LEAD_CLOSED', error: '线索已关闭' }); }
          else skipped++;
          continue;
        }
        const r = engine.setLeadStatus(leadId, '已下发');
        if (r && r.ok) { state.lead_status[leadId] = '已下发'; advanced++; }
        else failed.push({ lead_id: leadId, code: r && r.code, error: r && r.error });
      }
      task.advanced_count = advanced;
      task.skipped_count = skipped;
      task.advance_failed = failed.slice(0, 50);
      task.advance_failed_count = failed.length;
    }

    const campMoved = syncCampaignStatus(task.campaign_id);

    audit({
      actor: (ctx && ctx.actor) || 'web',
      action: 'task.' + next,
      target: id, from: from, to: next,
      detail: (next === '执行中'
        ? ('下发 ' + (task.advanced_count || 0) + ' 条，跳过 ' + (task.skipped_count || 0) + ' 条，失败 ' + (task.advance_failed_count || 0) + ' 条')
        : ((ctx && ctx.note) || '')) + (campMoved ? (' · 方案联动 → ' + campMoved) : ''),
    });
    persist();
    return { ok: true, item: task, from: from, campaign_status: campMoved || null };
  }

  /* ────────────────── 回执 ────────────────── */

  function addReceipts(taskId, receipts, ctx) {
    const task = taskById(taskId);
    if (!task) return { ok: false, code: 'TASK_NOT_FOUND', error: '任务单不存在：' + taskId };
    if (['执行中', '已暂停', '已完成'].indexOf(task.status) === -1) {
      return { ok: false, code: 'TASK_NOT_DISPATCHED', error: '任务单当前为「' + task.status + '」，未下发不接受回执' };
    }
    const rows = Array.isArray(receipts) ? receipts : [];
    if (!rows.length) return { ok: false, code: 'EMPTY_RECEIPTS', error: '回执为空' };

    const accepted = [];
    const rejected = [];
    // 静默时段硬阻断（codex 审核 P0：人群规则写了 22:00-08:00 禁呼，
    // 回执却全部发生在凌晨 02:00 且 G3 拦截数为 0——规则没落到执行层）。
    // 外呼渠道回执在静默时段一律拒收，调度层违规在这里兜底。
    const quietNow = engine.inQuietHours ? engine.inQuietHours() : false;
    const isOutbound = task.type === '外呼' || /外呼/.test(task.channel || '');
    if (quietNow && isOutbound) {
      return {
        ok: false, code: 'QUIET_HOURS_BLOCKED',
        error: '当前处于静默时段（22:00–08:00 禁呼），外呼回执被拒收。请检查触达窗口配置与调度系统——监管红线不得在调度层被绕过。',
      };
    }
    for (const r of rows) {
      const lead = engine.leadById(r.lead_id);
      if (!lead) { rejected.push({ lead_id: r.lead_id, reason: '线索不存在' }); continue; }
      if (task.lead_ids.indexOf(lead.id) === -1) { rejected.push({ lead_id: r.lead_id, reason: '该线索不在此任务单' }); continue; }
      // 渠道事件字典（MKT-16）：按本任务单渠道校验合法事件，外呼不允许「点击」等错配事件
      const validResults = RECEIPT_RESULTS_BY_CHANNEL[task.type] || RECEIPT_RESULTS_BY_CHANNEL[task.channel] || RECEIPT_RESULTS;
      const result = validResults.indexOf(r.result) !== -1 ? r.result : null;
      if (!result) {
        const hint = RECEIPT_RESULTS.indexOf(r.result) !== -1
          ? '事件「' + r.result + '」与本任务单渠道「' + task.type + '」不匹配（合法事件：' + validResults.join('/') + '）'
          : '未知回执结果：' + r.result;
        rejected.push({ lead_id: r.lead_id, reason: hint });
        continue;
      }

      const item = {
        task_id: task.id,
        lead_id: lead.id,
        xid: lead.xid,
        result: result,
        duration_s: Number(r.duration_s) || 0,
        hangup_reason: r.hangup_reason || '',
        intent_level: r.intent_level || '',
        note: r.note || '',
        channel: task.channel,
        // G7 AI 告知留证：外呼回执必须能回答「这通电话播报 AI 身份了吗」。
        // 话术渲染层检测实际开场文本（含模板血缘）是否含 AI 声明关键词。
        ai_declared: (task.type === '外呼') ? (engine.checkAiDeclare ? engine.checkAiDeclare(r.opening_text || r.declared_text || '') : null) : null,
        recorded_at: new Date().toISOString(),
      };
      state.executions.push(item);
      accepted.push(item);

      // 回执驱动线索状态：这是「从执行系统回传」到「线索生命周期」的唯一桥。
      // 状态机是逐级的（已下发→已触达→已响应→已转化），但真实回执可能跳级：
      // 「点击/拒绝」意味着「接通且有响应」，若线索还停在「已下发」，直接迁「已响应」
      // 会被迁移表拒绝（此前静默丢弃 → 漏斗响应层恒 0）。级联推进：先把前置态补上。
      const nextStatus = OUTCOME_TO_LEAD_STATUS[result];
      if (nextStatus) {
        const ORDER = ['已下发', '已触达', '已响应', '已转化'];
        const cur = lead.status;
        const from = ORDER.indexOf(cur), to = ORDER.indexOf(nextStatus);
        if (to > from && from >= 0) {
          // 逐级补齐中间态（如 已下发→已触达→已响应）
          for (let k = from + 1; k <= to; k++) {
            const step = engine.setLeadStatus(lead.id, ORDER[k]);
            if (step && step.ok) state.lead_status[lead.id] = ORDER[k];
          }
        } else {
          const move = engine.setLeadStatus(lead.id, nextStatus);
          if (move && move.ok) state.lead_status[lead.id] = nextStatus;
        }
      }
    }

    audit({
      actor: (ctx && ctx.actor) || 'system',
      action: 'task.receipts',
      target: task.id,
      detail: '接收 ' + accepted.length + ' 条，拒绝 ' + rejected.length + ' 条',
    });
    persist();
    return { ok: true, accepted: accepted.length, rejected: rejected, items: accepted };
  }

  /* ────────────────── 结果 ────────────────── */

  function recordOutcomes(rows, ctx) {
    const list = Array.isArray(rows) ? rows : [];
    const accepted = [];
    const rejected = [];
    for (const r of list) {
      const lead = engine.leadById(r.lead_id);
      if (!lead) { rejected.push({ lead_id: r.lead_id, reason: '线索不存在' }); continue; }
      const item = {
        task_id: r.task_id || null,
        lead_id: lead.id,
        xid: lead.xid,
        converted: Boolean(r.converted),
        conversion_type: r.conversion_type || '',
        amount: Number(r.amount) || 0,
        complained: Boolean(r.complained),
        unsubscribed: Boolean(r.unsubscribed),
        window_days: Number(r.window_days) || 30,
        observed_at: new Date().toISOString(),
      };
      state.outcomes.push(item);
      accepted.push(item);
      if (item.complained) {
        // 投诉进静默期，后续任务单闸门会拦
        lead.risk = Array.isArray(lead.risk) ? lead.risk : [];
        if (lead.risk.indexOf('90 天内有投诉') === -1) lead.risk.push('90 天内有投诉');
      }
      if (item.unsubscribed) {
        // 退订 = 客户明确说「别再联系我」——监管要求立即停止一切营销触达，
        // 比投诉更硬。入长期静默（G1 拦截），直到客户主动重新订阅（人工操作移除标签）。
        lead.risk = Array.isArray(lead.risk) ? lead.risk : [];
        if (lead.risk.indexOf('已退订') === -1) lead.risk.push('已退订');
      }
      if (item.converted) {
        const move = engine.setLeadStatus(lead.id, '已转化');
        if (move && move.ok) state.lead_status[lead.id] = '已转化';
      }
    }
    audit({
      actor: (ctx && ctx.actor) || 'system',
      action: 'outcome.record',
      target: 'outcomes',
      detail: '写入 ' + accepted.length + ' 条结果',
    });

    /* ── 红线强制暂停（codex 审核 P0：投诉率 3.45% 超 1% 红线，任务仍「执行中」且
       复盘卡建议「加大投放」——风控动作必须由后端状态机强制执行，不能靠人工看板发现）。
       规则：回采后按任务单口径计算投诉率，≥1%（监管红线）自动暂停该任务单所属方案的
       全部执行中任务单，并写审计。前端只展示，无权恢复——恢复须走人工审批。 */
    const REDLINE_COMPLAINT = 0.01;
    const autoPaused = [];
    for (const item of accepted) {
      if (!item.task_id) continue;
      const task = taskById(item.task_id);
      if (!task || task.status !== '执行中') continue;
      const s = taskSummary(task.id);
      if (!s || !s.planned) continue;
      const rate = s.complained / s.planned;
      if (rate >= REDLINE_COMPLAINT) {
        // 同方案全部执行中任务单一起停（方案级风控，不是单任务单级）
        for (const t of state.tasks) {
          if (t.campaign_id === task.campaign_id && t.status === '执行中') {
            t.status = '已暂停';
            t.paused_reason = 'complaint_redline';
            t.paused_at = new Date().toISOString();
            t.paused_detail = '投诉率 ' + (rate * 100).toFixed(2) + '% ≥ 红线 1%，系统强制暂停投放（恢复须人工审批）';
            autoPaused.push(t.id);
          }
        }
        const camp = campaignById(task.campaign_id);
        if (camp && camp.status === '执行中') camp.status = '已暂停';
        audit({
          actor: 'system', action: 'guardrail.auto_pause', target: task.campaign_id,
          detail: '投诉率 ' + (rate * 100).toFixed(2) + '% 超红线 1% → 强制暂停任务单 ' + autoPaused.join(',') + '（不可自动恢复）',
        });
        break; // 同一轮已按方案暂停，无需重复
      }
    }

    persist();
    return { ok: true, accepted: accepted.length, rejected: rejected, auto_paused: autoPaused };
  }

  /**
   * 话术渲染：一个任务单共用一套模板底稿，个体差异靠变量 + 策略粒度。
   *
   * 三种粒度（业务可选）：
   *   group      一群一策 —— 全客群同一条模板，只替换称呼/等级等变量
   *   segment    分层群策 —— 先按子群（卡等级）选不同的权益侧重与切入角度，再填变量
   *   individual 一客一策 —— 在模板前追加该客户自己的推荐理由（由其特征组合成句，不是模型逐客生成）
   *
   * 为什么一客一策不用模型逐客生成：10 万客户要 10 万次模型调用，成本与延迟不可接受，
   * 且输出不可穷举审查、合规无法过审。真需要逐客文案时走 A1 线索解释（限小批量，人工抽审）。
   */
  function renderMessage(task, lead, campaign) {
    const tpl = MESSAGE_TEMPLATES[task.type] || MESSAGE_TEMPLATES['短信'];
    const offer = (campaign && campaign.offer) || {};
    const cadence = (campaign && campaign.cadence) || {};
    const mode = (campaign && campaign.strategy_mode) || 'group';
    const seg = mode === 'segment' ? matchSegment(lead, campaign) : null;

    // 方案绑定了触达设计话术方案（script_id）且本任务是外呼 → 用脚本开场白作外呼底稿，
    // 变量替换 ${name}/${amt30} 等（触达设计引擎 renderText 同款语法）；模板血缘指向脚本版本。
    const scriptRef = (campaign && campaign.cfg && campaign.cfg.script_id) || null;
    if ((task.type === '外呼') && scriptRef && typeof scriptOpeningOf === 'function') {
      const sc = scriptOpeningOf(scriptRef);
      if (sc) {
        // agent 引擎无节点图：开场白在 policy 动作里，取合规开场底稿；
        // rule/llm 引擎取首节点话术。两者都含录音告知（校验器保证）。
        const scriptTpl = (sc.nodes && sc.nodes[0] && sc.nodes[0].text)
          || '您好${name}，我是招商银行信用卡中心客服，本次通话将录音。看到您最近消费比平时少了些，特意来电关心一下，占用您一分钟方便吗？';
        const vars2 = {
          name: lead.name || (lead.xid || '客户'),
          amt30: String(lead.amt30 == null ? '—' : lead.amt30),
          txn30: String(lead.txn30 == null ? '—' : lead.txn30),
          tier: lead.tier || '信用卡',
        };
        // G7 AI 身份披露：脚本血缘话术的底稿来自触达设计，可能没有 AI 声明段。
        // 检测实际底稿，缺声明时强制前置【AI 声明】段——声明不可删，渠道系统整段播报。
        // （模板 v3 自带声明，但脚本/素材血缘路径此前会绕过它，属合规漏报。）
        const hasAiDeclare = engine.checkAiDeclare ? engine.checkAiDeclare(scriptTpl) : /AI|智能语音|机器人/.test(String(scriptTpl));
        const aiDeclarePrefix = hasAiDeclare ? '' : '【AI 声明】本通话由招商银行智能语音助手为您服务，是机器人民呼，不是人工坐席。';
        const body2 = aiDeclarePrefix
          + String(scriptTpl || '')
            .replace(/\$\{(\w+)\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(vars2, k) ? vars2[k] : m; })
          + '【事由】为您介绍' + String(offer.type || '专属权益').split('/')[0] + '：' + sanitizeCopy(offer.description || '')
          + '【确认】这项权益需要您本人确认，现在方便吗？';
        return {
          template_id: sc.id,
          template_version: 'script-v' + (sc.version || 1) + (hasAiDeclare ? '' : '+ai'),
          source: 'dialog_script',
          script_stage: sc.stage,
          title: '外呼话术（触达设计 · ' + (sc.name || sc.id) + '）',
          body: body2,
          raw_template: scriptTpl,
          variables: vars2,
          strategy_mode: mode,
          segment: null,
          personal: null,
          variables_note: '话术来自触达设计页话术方案 ' + sc.id + ' v' + (sc.version || 1) + '（' + sc.stage + ' 引擎），变量按客户底表填充'
            + (hasAiDeclare ? '' : '；底稿缺 AI 声明，已强制前置【AI 声明】段（G7 合规要求）'),
        };
      }
    }

    // 方案绑定了素材库文案（creative_id）且任务渠道匹配 → 素材优先于默认模板。
    // 素材变量 {name}/{tier}/{txn30} 由任务单按客户填充；模板血缘指向素材版本。
    const creativeRef = (campaign && campaign.cfg && campaign.cfg.creative_id && typeof creativeOf === 'function')
      ? creativeOf(campaign.cfg.creative_id) : null;
    if (creativeRef && creativeRef.channel === task.channel) {
      const varsC = {
        name: lead.name || (lead.xid || '客户'),
        tier: lead.tier || '信用卡',
        txn30: String(lead.txn30 == null ? '—' : lead.txn30),
        amt30: String(lead.amt30 == null ? '—' : lead.amt30),
        offer_name: String(offer.type || '专属权益').split('/')[0] || '专属权益',
        offer_desc: sanitizeCopy(offer.description || ''),
        end_date: cadence.end_date || '本月底',
      };
      const fillC = function (s) {
        return String(s || '').replace(/\{(\w+)\}/g, function (m, k) {
          return Object.prototype.hasOwnProperty.call(varsC, k) ? varsC[k] : m;
        });
      };
      return {
        template_id: creativeRef.id,
        template_version: 'creative-v' + (creativeRef.version || 1),
        source: 'creative_asset',
        title: fillC(creativeRef.title),
        body: fillC(creativeRef.body),
        raw_template: creativeRef.body,
        variables: varsC,
        strategy_mode: mode,
        segment: null,
        personal: null,
        variables_note: '文案来自素材库 ' + creativeRef.id + ' v' + (creativeRef.version || 1) + '（' + creativeRef.channel + '），变量按客户底表填充',
      };
    }

    // 权益描述按粒度分三档：全客群统一 / 子群侧重 / 该客户专属额度
    let offerName = String(offer.type || '专属权益').split('/')[0] || '专属权益';
    let offerDesc = sanitizeCopy(offer.description || '消费满 300 减 30');

    if (seg) {
      // 分层：子群名只用于内部展示，绝不写进客户文案（客户不该知道自己是"高价值卡"标签）
      offerName = sanitizeCopy(seg.offer_focus || offerName);
      const angle = sanitizeCopy(seg.message_angle || '');
      offerDesc = angle && offerDesc.indexOf(angle) === -1 ? angle + '：' + offerDesc : offerDesc;
    } else if (mode === 'individual') {
      const pe = personalOffer(lead, offer);
      offerDesc = pe.text + '（按您近 30 天消费测算）';
      if (pe.tier_hint) offerName = pe.tier_hint + '权益';
    }

    const vars = {
      name: lead.name || (lead.xid || '客户'),
      tier: lead.tier || '信用卡',
      txn30: String(lead.txn30 == null ? '—' : lead.txn30),
      amt30: String(lead.amt30 == null ? '—' : lead.amt30),
      days: String(lead.days == null ? '—' : lead.days),
      agent_id: '8842',
      offer_name: offerName,
      offer_desc: offerDesc,
      end_date: cadence.end_date || '本月底',
    };
    const fill = function (s) {
      return String(s || '').replace(/\{(\w+)\}/g, function (m, k) {
        return Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m;
      });
    };

    return {
      template_id: tpl.id,
      template_version: tpl.version,
      title: fill(tpl.title),
      body: fill(tpl.body),
      raw_template: tpl.body,
      variables: vars,
      strategy_mode: mode,
      segment: seg ? { name: seg.name, rule: seg.rule, angle: seg.message_angle || '', offer_focus: seg.offer_focus || '' } : null,
      personal: mode === 'individual' ? personalOffer(lead, offer) : null,
      variables_note: tpl.variables_note,
    };
  }

  /** 去掉混进客户文案里的合规口吻从句（"不使用返现承诺"这类是给审查看的，客户不该读到） */
  function sanitizeCopy(s) {
    return String(s || '')
      .replace(/[，,；;]?\s*(不使用|不含|不得|禁止|避免|杜绝|严禁|不承诺|无)[^，,。；;]{0,20}(承诺|夸大|误导|收益|保本|返现)[^，,。；;]{0,12}/g, '')
      .replace(/[，,；;]\s*$/, '')
      .trim();
  }

  /**
   * 卡等级归一：把"白金卡及以上"和"金卡"区分开。
   * 早前用 rule.indexOf('金卡') 判断，会命中"白[金卡]及以上"，把金卡客户错分到高价值群——
   * 这类子串误命中在业务上是致命的（高价值权益给错人），所以改成按等级数值比较。
   */
  function segLevel(rule) {
    const s = String(rule || '');
    if (s.indexOf('黑金') !== -1 || s.indexOf('钻石') !== -1) return { lv: 4, open: /以上/.test(s) };
    if (s.indexOf('白金') !== -1) return { lv: 3, open: /以上/.test(s) };
    if (s.indexOf('金卡') !== -1) return { lv: 2, open: /以上/.test(s) };
    if (s.indexOf('普卡') !== -1 || s.indexOf('普通') !== -1) return { lv: 1, open: false };
    return null;
  }
  function tierLevel(tier) {
    const s = String(tier || '');
    if (s.indexOf('黑金') !== -1 || s.indexOf('钻石') !== -1) return 4;
    if (s.indexOf('白金') !== -1) return 3;
    if (s.indexOf('金卡') !== -1) return 2;
    if (s.indexOf('普卡') !== -1 || s.indexOf('普通') !== -1) return 1;
    return 0;
  }

  /** 分层群策：按卡等级把客户归到方案定义的子群；先精确匹配，再匹配"及以上"型开放区间 */
  function matchSegment(lead, campaign) {
    const segs = (campaign && campaign.segments) || [];
    if (!segs.length) return null;
    const lv = tierLevel(lead.tier);
    let exact = null, open = null;
    for (const s of segs) {
      const sl = segLevel(s.rule);
      if (!sl) continue;
      if (sl.lv === lv && !exact) exact = s;
      if (sl.open && lv >= sl.lv && !open) open = s;
    }
    return exact || open || segs[segs.length - 1];
  }

  /**
   * 一客一策：不是"改个开头称呼"，而是逐客算出专属权益门槛。
   * 高消费客户给更高门槛（避免低门槛被薅、也贴合其消费力），低消费客户给低门槛（够得着才有意义）。
   * 权益面额固定来自方案（成本可控），差异只在门槛——这是银行真做一客一策的常见形态。
   */
  function personalOffer(lead, offer) {
    const amt = Number(lead.amt30 || 0);
    const face = Number((offer && offer.face_value) || 20);
    const step = face * 10;                       // 面额 20 → 每档 200 元
    // 系数 0.8：门槛低于客户当前消费力才够得着；1.2 倍的门槛看着"高端"，实际转化极差
    let threshold = amt > 0 ? Math.ceil(amt * 0.8 / step) * step : step * 2;
    threshold = Math.max(step, Math.min(threshold, step * 15));
    const lv = tierLevel(lead.tier);
    return {
      face_value: face,
      threshold: threshold,
      tier_hint: lv >= 3 ? '白金专属' : lv === 2 ? '金卡' : '',
      text: '满 ¥' + threshold + ' 减 ¥' + face,
    };
  }

  /** 任务单覆盖的客户样本：带变量与各自渲染后的话术，用来看「同一模板落到不同客户长什么样」 */
  function taskAudience(taskId, opts) {
    const task = taskById(taskId);
    if (!task) return null;
    const campaign = campaignById(task.campaign_id);
    const o = opts || {};
    const limit = Math.min(500, Math.max(1, Number(o.limit) || 20));
    const ids = task.lead_ids || [];
    const rows = [];
    for (let i = 0; i < ids.length && rows.length < limit; i++) {
      const lead = engine.leadById(ids[i]);
      if (!lead) continue;
      const msg = renderMessage(task, lead, campaign);
      rows.push({
        lead_id: lead.id, xid: lead.xid, name: lead.name, tier: lead.tier,
        txn30: lead.txn30, amt30: lead.amt30, days: lead.days,
        score: lead.score, status: lead.status, exp_value: lead.expValue,
        variables: msg.variables,
        strategy_mode: msg.strategy_mode,
        segment: msg.segment,
        personal: msg.personal,
        message: { title: msg.title, body: msg.body, source: msg.source || 'static_template', template_id: msg.template_id, template_version: msg.template_version, script_stage: msg.script_stage || null, variables_note: msg.variables_note },
      });
    }
    return {
      task: {
        id: task.id, type: task.type, channel: task.channel, status: task.status,
        count: task.count || 0, template_id: task.template_id, template_version: task.template_version,
        owner: task.owner, sla_hours: task.sla_hours, schedule: task.schedule,
        frequency_cap: task.frequency_cap,
      },
      campaign: campaign ? {
        id: campaign.id, name: campaign.name, status: campaign.status,
        objective: campaign.objective, offer: campaign.offer,
        definition_id: campaign.definition_id, audience_size: campaign.audience_size,
        cadence: campaign.cadence, strategy_mode: campaign.strategy_mode || 'group',
        segments: campaign.segments || [], measurement: campaign.measurement,
      } : null,
      template: MESSAGE_TEMPLATES[task.type] || null,
      total: ids.length,
      sampled: rows.length,
      rows: rows,
      gate_snapshot: (task.gate_snapshot || []).slice(0, 20),
    };
  }

  /** 按任务单汇总：送达率、接通率、转化率、投诉——效果看板吃这一份 */
  function taskSummary(taskId) {
    const task = taskById(taskId);
    if (!task) return null;
    const rows = state.executions.filter(function (e) { return e.task_id === taskId; });
    const outs = state.outcomes.filter(function (o) { return o.task_id === taskId; });
    const n = task.count || 0;
    const reached = rows.filter(function (e) { return ['送达', '接通', '点击', '拒绝'].indexOf(e.result) !== -1; }).length;
    const connected = rows.filter(function (e) { return e.result === '接通'; }).length;
    const converted = outs.filter(function (o) { return o.converted; }).length;
    const complained = outs.filter(function (o) { return o.complained; }).length;
    const amount = outs.reduce(function (a, b) { return a + (b.amount || 0); }, 0);
    return {
      task_id: taskId,
      status: task.status,
      type: task.type,
      planned: n,
      receipts: rows.length,
      reached: reached,
      connected: connected,
      converted: converted,
      complained: complained,
      conversion_amount: amount,
      reach_rate: n ? +(reached / n).toFixed(4) : 0,
      connect_rate: n ? +(connected / n).toFixed(4) : 0,
      conversion_rate: n ? +(converted / n).toFixed(4) : 0,
      complaint_rate: n ? +(complained / n).toFixed(4) : 0,
    };
  }

  function overview() {
    const byStatus = {};
    TASK_STATES.forEach(function (s) { byStatus[s] = 0; });
    state.tasks.forEach(function (t) { byStatus[t.status] = (byStatus[t.status] || 0) + 1; });
    const summaries = state.tasks.map(function (t) { return taskSummary(t.id); }).filter(Boolean);
    const totals = summaries.reduce(function (acc, s) {
      acc.planned += s.planned;
      acc.receipts += s.receipts;
      acc.reached += s.reached;
      acc.connected += s.connected;
      acc.converted += s.converted;
      acc.complained += s.complained;
      acc.amount += s.conversion_amount;
      return acc;
    }, { planned: 0, receipts: 0, reached: 0, connected: 0, converted: 0, complained: 0, amount: 0 });
    return {
      campaigns: state.campaigns.length,
      tasks: state.tasks.length,
      tasks_by_status: byStatus,
      receipts: state.executions.length,
      outcomes: state.outcomes.length,
      totals: totals,
      summaries: summaries,
    };
  }

  /**
   * A/B 实验评估（老师建议的复盘核心）：实验组 vs 对照组的真实对比。
   *
   * 口径：
   *   触达率 = 回执/计划（实验组才有）；转化率 = 转化人数/组人数（两组同口径）；
   *   因果增量 = 实验组转化率 − 对照组转化率（剥离自然恢复）；
   *   显著性 = 双比例 z 检验（n<30 或期望频次<5 时标注「样本不足」，不下结论）；
   *   RoI = (实验组转化金额 × 毛益率估计) / 权益成本；成本 = 人数×单客成本 + 转化×面额。
   *   决策建议按 增量方向 × 显著性 × RoI 映射：放量 / 迭代重测 / 停止。
   */
  function campaignAbTest(campaignId) {
    const c = campaignById(campaignId);
    if (!c) return null;
    const ab = c.ab || null;
    const taskIds = (c.task_ids || []);
    const tasksAll = taskIds.map(function (t) { return taskById(t); }).filter(Boolean);
    const treatIds = new Set();
    tasksAll.forEach(function (t) { (t.lead_ids || []).forEach(function (id) { treatIds.add(id); }); });
    const controlIds = ab ? (ab.control_ids || []) : [];

    const outcomeByLead = {};
    state.outcomes.forEach(function (o) { if (o.converted || o.complained || o.amount) outcomeByLead[o.lead_id] = outcomeByLead[o.lead_id] || { converted: 0, amount: 0, complained: 0 }; if (outcomeByLead[o.lead_id]) { if (o.converted) outcomeByLead[o.lead_id].converted++; outcomeByLead[o.lead_id].amount += (o.amount || 0); if (o.complained) outcomeByLead[o.lead_id].complained++; } });
    const receiptCount = {};
    state.executions.forEach(function (e) { receiptCount[e.lead_id] = (receiptCount[e.lead_id] || 0) + 1; });

    function groupStats(ids, isTreat) {
      const conv = ids.filter(function (id) { return outcomeByLead[id] && outcomeByLead[id].converted; }).length;
      const amount = ids.reduce(function (a, id) { return a + ((outcomeByLead[id] || {}).amount || 0); }, 0);
      const reached = isTreat ? ids.filter(function (id) { return receiptCount[id]; }).length : 0;
      return {
        size: ids.length,
        converted: conv,
        amount: amount,
        reached: reached,
        conv_rate: ids.length ? +(conv / ids.length).toFixed(4) : 0,
        reach_rate: (isTreat && ids.length) ? +(reached / ids.length).toFixed(4) : null,
      };
    }

    const T = groupStats(Array.from(treatIds), true);
    const C = groupStats(controlIds, false);
    // 双比例 z 检验（合并方差）
    let z = null, pApprox = null, enough = false;
    const n1 = T.size, n2 = C.size, x1 = T.converted, x2 = C.converted;
    if (n1 > 0 && n2 > 0) {
      const p1 = x1 / n1, p2 = x2 / n2;
      const pp = (x1 + x2) / (n1 + n2);
      const se = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2));
      if (se > 0) {
        z = +((p1 - p2) / se).toFixed(3);
        pApprox = +(2 * (1 - normCdf(Math.abs(z)))).toFixed(4);
      }
      enough = n1 >= 30 && n2 >= 30 && Math.min(x1, x2) >= 1 && (n1 + n2) * ((x1 + x2) / (n1 + n2)) * (1 - (x1 + x2) / (n1 + n2)) >= 5;
    }
    const lift = T.conv_rate - C.conv_rate; // 因果增量（pp）
    const liftPct = C.conv_rate > 0 ? +((lift / C.conv_rate) * 100).toFixed(1) : null;

    // RoI：权益成本 = 转化人数×面额；触达成本 = 实验组人数×单客成本；收益按金额×30% 毛益估计（演示口径，标注）
    const offer = c.offer || {};
    const face = Number(offer.face_value) || 0;
    const perCase = Number((c.budget || {}).per_case) || 0;
    const cost = T.converted * face + T.size * perCase;
    const profit = T.amount * 0.30; // 毛益率 30% 为演示假设，界面需标注
    const roi = cost > 0 ? +((profit / cost)).toFixed(2) : null;

    // 决策建议：增量方向 × 显著性 × RoI → 下一步
    // 红线优先（codex 审核 P0）：方案因投诉红线被系统暂停时，统计结论再好也不出
    // 「放量/继续观察」——合规阻断优先于任何增长建议。
    const redlinePaused = state.tasks.some(t2 => t2.campaign_id === c.id && t2.paused_reason === 'complaint_redline');
    let decision, decisionDetail;
    if (redlinePaused) {
      decision = '红线暂停';
      decisionDetail = '方案因投诉率超红线 1% 被系统强制暂停（guardrail.auto_pause）。统计结论在合规问题解决前不可用于放量决策——先处理投诉与话术问题，人工审批恢复后重新评估。';
    } else if (!ab || !ab.enabled) {
      decision = '无对照';
      decisionDetail = '本方案未启用对照组留白，无法剥离自然恢复，增量不可归因。建议下一版方案把对照组留白设为 10–20% 再跑。';
    } else if (!enough) {
      decision = '样本不足';
      decisionDetail = '两组样本量或转化数不足以支撑统计结论（建议每组 ≥30 人且至少出现转化）。维持当前策略继续积累样本，或扩大圈人后再评估。';
    } else if (lift > 0 && pApprox < 0.05 && roi !== null && roi >= 1) {
      decision = '放量';
      decisionDetail = '增量 +' + (lift * 100).toFixed(1) + 'pp 且统计显著（p≈' + pApprox + '），RoI ' + roi + ' ≥ 1。建议放大圈人规模复制投放，并保留小比例对照组持续验证。';
    } else if (lift > 0 && pApprox < 0.05) {
      decision = '调优成本';
      decisionDetail = '增量显著但 RoI ' + roi + ' < 1：权益成本吃掉了增量收益。建议降低面额/改阶梯权益后重测，或改用低成本渠道。';
    } else if (lift > 0) {
      decision = '继续观察';
      decisionDetail = '增量为正但未达显著（p≈' + pApprox + '）。方向对、证据不够，建议积累样本或延长观察窗口后再决策。';
    } else if (lift <= 0 && pApprox < 0.05) {
      decision = '停止';
      decisionDetail = '增量 ≤0 且统计显著——本权益对该客群无效甚至负向。停止投放，回到触达设计调整话术/权益，换客群重测。';
    } else {
      decision = '迭代重测';
      decisionDetail = '增量不为正且不显著。可能是权益吸引力不足或话术问题，建议改一版（换权益/换话术方案）做 A/B 重测，而不是直接停止。';
    }

    return {
      campaign_id: c.id,
      ab_enabled: !!(ab && ab.enabled),
      ratio: ab ? ab.ratio : null,
      split_at: ab ? ab.split_at : null,
      control_size: C.size,
      treatment: T,
      control: C,
      lift_pp: +(lift * 100).toFixed(2),
      lift_pct: liftPct,
      z: z,
      p_value: pApprox,
      significant: !!(pApprox !== null && pApprox < 0.05),
      sample_enough: enough,
      roi: roi,
      roi_assumption: '毛益率 30% 为演示假设',
      cost: cost,
      profit_est: Math.round(profit),
      decision: decision,
      decision_detail: decisionDetail,
    };
  }

  /* 标准正态分布 CDF（z 检验 p 值近似），Abramowitz-Stegun 26.2.17 */
  function normCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  return {
    listCampaigns, campaignById, createCampaign, updateCampaign, transitionCampaign,
    validateCampaignExecutable,
    listTasks, taskById, createTasksFromCampaign, transitionTask,
    addReceipts, recordOutcomes, taskSummary, overview, campaignAbTest,
    plannedCountThisMonth, renderMessage, taskAudience,
    CAMPAIGN_STATES, CAMPAIGN_TRANSITIONS, TASK_STATES, TASK_TRANSITIONS,
    CHANNEL_TASK_TYPE, RECEIPT_RESULTS, MESSAGE_TEMPLATES,
  };
}

module.exports = { createTaskStore, CAMPAIGN_STATES, TASK_STATES, RECEIPT_RESULTS, CHANNEL_TASK_TYPE };
