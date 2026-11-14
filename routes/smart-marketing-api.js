'use strict';

/**
 * 智能营销工作台 API（/api/smart-marketing/*）
 *
 * 职责边界：本模块只做「HTTP 编解码 + 状态持久化 + 状态机把关」，
 * 全部业务算法在 tools/smart-marketing/engine.js（与前端共享同一份代码）。
 * 任何在此文件里复制第二份计算逻辑的改动都视为缺陷——两端口径会漂移。
 *
 * 持久化：data/smart-marketing/state.json
 *   - definitions  线索定义（DSL 原文 + 版本号 + 状态）
 *   - lead_status  线索状态覆盖（引擎重启后按此回放，不重写引擎数据）
 *   - audit        操作审计（谁、何时、对哪条线索、从什么状态到什么状态、结果）
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const engine = require('../tools/smart-marketing/engine.js');
const agents = require('../services/smart-marketing/agents.js');
const { createTaskStore } = require('../services/smart-marketing/tasks.js');
const { createDatasetStore } = require('../services/smart-marketing/datasets.js');
const tags = require('../services/smart-marketing/tags.js');
const dialog = require('../services/smart-marketing/dialog.js');

const PREFIX = '/api/smart-marketing';
const STATE_DIR = path.join(__dirname, '..', 'data', 'smart-marketing');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const BODY_LIMIT = 256 * 1024;

/* ────────────────────────── 状态 ────────────────────────── */

const state = {
  version: 1,
  updated_at: null,
  definitions: [],
  lead_status: {},
  audit: [],
  // 执行层实体：方案 → 任务单 → 回执 → 结果
  campaigns: [],
  tasks: [],
  executions: [],
  outcomes: [],
  // 触达设计：外呼对话任务脚本 + 会话模拟记录
  scripts: [],
  sessions: [],
  // 营销资产：权益池 / 素材库 / 资源位（配商品/配素材/配广告的银行形态）
  assets: null,
};

let loaded = false;

/* ── 营销资产种子：权益池 / 素材库 / 资源位（对标业界「配商品/配素材/配广告」，
   银行信用卡语境：商品=权益与商户优惠；素材=推送文案/短信文案/banner；资源位=APP 广告位） ── */
function seedAssets() {
  return {
    offers: [
      { id: 'OFF_CASHBACK_001', name: '消费返现 · 满6笔返30元', type: '立减金', face_value: 30, threshold_mode: 'by_count', threshold: 6, stock: 50000, cost_per_use: 30, merchant: '全渠道通用', scene: '消费活跃度提升', status: 'active', effective_until: '2026-12-31', desc: '自然月内消费满 6 笔（不限金额），返 30 元刷卡金自动入账，无需报名' },
      { id: 'OFF_STAGE_002', name: '账单分期 · 满5000减160', type: '分期贴息', face_value: 160, threshold_mode: 'fixed', threshold: 5000, stock: 20000, cost_per_use: 160, merchant: '淘宝/京东/美团', scene: '账单分期转化', status: 'active', effective_until: '2026-11-30', desc: '单笔满 5000 元分期立减 160 元，不设期数限制，财政贴息叠加可用' },
      { id: 'OFF_MEAL_003', name: '餐饮半价 · 周五五折', type: '商户优惠', face_value: 50, threshold_mode: 'by_percent', threshold: 50, stock: 100000, cost_per_use: 25, merchant: '连锁餐饮 300 家', scene: '高频消费场景', status: 'active', effective_until: '2026-12-31', desc: '每周五在合作餐饮商户消费享 5 折优惠，单笔最高优惠 50 元' },
      { id: 'OFF_POINTS_004', name: '积分加倍 · 消费 5 倍积分', type: '积分加倍', face_value: 0, threshold_mode: 'none', threshold: 0, stock: 999999, cost_per_use: 8, merchant: '线上支付通道', scene: '新客激活', status: 'active', effective_until: '2026-12-31', desc: '活动期间线上消费享 5 倍积分，月封顶 5 万分' },
      { id: 'OFF_LIMIT_005', name: '提额礼遇 · 临时额度翻倍', type: '提额礼遇', face_value: 0, threshold_mode: 'none', threshold: 0, stock: 5000, cost_per_use: 0, merchant: '本行', scene: '高价值客户维系', status: 'draft', effective_until: '2027-01-31', desc: '优质客户春节前临时额度提升至 2 倍，3 个月有效' },
    ],
    creatives: [
      { id: 'CRT_PUSH_WAKE_01', name: '消费唤醒 · APP 推送文案', kind: 'push_copy', channel: 'APP 推送', title: '{name}，您的专属返现已到账', body: '您{tier}本月消费 {txn30} 笔，满 6 笔返 30 元刷卡金已为您预留，点击查看 ›', status: 'active', version: 3, updated_at: '2026-11-05T10:00:00+08:00' },
      { id: 'CRT_SMS_WAKE_01', name: '消费唤醒 · 短信文案', kind: 'sms_copy', channel: '短信', title: '', body: '【招行信用卡】{name}，满 6 笔返 30 元刷卡金已预留，回T退订', status: 'active', version: 3, updated_at: '2026-11-05T10:00:00+08:00' },
      { id: 'CRT_BANNER_CASHBACK', name: '返现活动 · APP 首页 banner 图', kind: 'banner', channel: 'APP 推送', title: '满6笔返30元', body: '活动主视觉：金红渐变底 + 刷卡金雨插画（占位，生产环境接素材系统）', status: 'active', version: 1, updated_at: '2026-11-01T09:00:00+08:00' },
      { id: 'CRT_BANNER_STAGE', name: '分期贴息 · 账单页 banner 图', kind: 'banner', channel: 'APP 推送', title: '分期满5000减160', body: '活动主视觉：蓝紫底 + 计算器元素（占位）', status: 'active', version: 1, updated_at: '2026-11-01T09:00:00+08:00' },
      { id: 'CRT_SMS_INSTALL_01', name: '分期邀约 · 短信文案', kind: 'sms_copy', channel: '短信', title: '', body: '【招行信用卡】{name}，您本期账单满5000分期立减160元，财政贴息可叠加', status: 'draft', version: 1, updated_at: '2026-11-04T16:00:00+08:00' },
    ],
    slots: [
      { id: 'SLT_HOME_BANNER', name: 'APP 首页头部 banner', channel: 'APP 推送', daily_pv: 420000, ctr_baseline: 0.032, position: '首页轮播第 1 帧', status: 'active' },
      { id: 'SLT_BILL_PAGE', name: '账单页分期推荐位', channel: 'APP 推送', daily_pv: 96000, ctr_baseline: 0.078, position: '账单详情下方', status: 'active' },
      { id: 'SLT_PAY_RESULT', name: '支付成功页权益位', channel: 'APP 推送', daily_pv: 310000, ctr_baseline: 0.041, position: '支付完成卡片下方', status: 'active' },
      { id: 'SLT_LIFE_ZONE', name: '掌上生活 · 城市专区', channel: 'APP 推送', daily_pv: 58000, ctr_baseline: 0.052, position: '旅游/餐饮专区头部', status: 'active' },
    ],
    /* 活动模板库（配活动）：App 内活动页玩法模板，配置时选模板 + 绑权益即成页。
       模板只定义玩法骨架与文案位，视觉稿生产环境接素材系统。 */
    activityTemplates: [
      { id: 'ACT_WHEEL_001', name: '大转盘 · 消费抽奖', type: '抽奖', scene: '消费活跃度提升', plays: '活动期内消费满 6 笔获 1 次抽奖机会，奖池含刷卡金/积分/商户五折券', page_title: '幸运大转盘', prizes: ['30 元刷卡金', '5 倍积分', '餐饮五折券', '谢谢参与'], daily_join_cap: 1, status: 'active', version: 2 },
      { id: 'ACT_GRID_002', name: '九宫格 · 签到集卡', type: '签到', scene: '留存促活', plays: '每日签到解锁一格，集齐 5 格兑商户优惠礼包', page_title: '集卡有礼', prizes: ['商户满减券', '积分翻倍卡', '视频会员周卡'], daily_join_cap: 1, status: 'active', version: 1 },
      { id: 'ACT_SECKILL_003', name: '积分秒杀 · 周三积分日', type: '秒杀', scene: '积分消耗', plays: '每周三 10 点/20 点两场，积分低价兑换话费/视频会员', page_title: '周三积分日', prizes: ['50 元话费（5 折积分价）', '视频会员月卡'], daily_join_cap: 2, status: 'active', version: 3 },
      { id: 'ACT_COUPON_004', name: '立减金直领页', type: '领券', scene: '消费活跃度提升', plays: '活动页一键领取立减金，核销后下次消费自动抵扣', page_title: '立即领券', prizes: ['30 元立减金'], daily_join_cap: 1, status: 'active', version: 1 },
      { id: 'ACT_CALC_005', name: '分期试算 · 贴息计算器', type: '工具', scene: '账单分期转化', plays: '输入分期金额与期数，实时显示贴息后每期还款额', page_title: '分期试算', prizes: [], daily_join_cap: 99, status: 'active', version: 1 },
    ],
    /* 费用分摊协议（配费用）：联合营销的出资比例。绑定后 RoI 成本按银行承担比例折算。
       bank_ratio = 银行（自担）比例，其余由商户/平台/财政承担。 */
    costShares: [
      { id: 'CSH_MEAL_001', name: '餐饮五折 · 商户对半分摊', bank_ratio: 0.5, share_desc: '银行 50% / 商户 50%', offer_id: 'OFF_MEAL_003', settle_cycle: '月结', status: 'active', effective_until: '2026-12-31' },
      { id: 'CSH_STAGE_002', name: '分期贴息 · 财政+银行共担', bank_ratio: 0.7, share_desc: '银行 70% / 财政贴息 30%', offer_id: 'OFF_STAGE_002', settle_cycle: '季结', status: 'active', effective_until: '2026-12-31' },
      { id: 'CSH_PLATFORM_003', name: '平台立减 · 平台承担 40%', bank_ratio: 0.6, share_desc: '银行 60% / 支付平台 40%', offer_id: null, settle_cycle: '月结', status: 'draft', effective_until: '2027-06-30' },
    ],
  };
}

function seedDefinitions() {
  return [
    {
      id: 'LD_ACTIVE_DROP_001',
      name: '消费活跃度下降',
      version: 3,
      owner: '零售经营部',
      status: 'active',
      dsl: engine.DEFAULT_DSL,
      created_at: '2026-10-20T09:00:00+08:00',
      updated_at: '2026-10-28T14:22:00+08:00',
      note: 'P0 试点场景：消费活跃度下降 → 关怀触达',
    },
    {
      id: 'LD_BILL_SHOCK_002',
      name: '账单金额异常上升',
      version: 2,
      owner: '零售经营部',
      status: 'active',
      dsl: null,
      created_at: '2026-10-22T10:10:00+08:00',
      updated_at: '2026-10-30T11:05:00+08:00',
      note: '规则草案，尚未通过编译校验',
    },
  ];
}

/**
 * 预置演示链路：复位后概览页开箱即有真实业务数据。
 * 走 tasks.createCampaign / transitionTask / addReceipts / recordOutcomes 真实函数，
 * 数据与用户手工操作完全同构（可继续审批/暂停/补回执）。
 * 量级刻意压小（60 线索规模），避免淹没「高优线索待指认」的演示焦点。
 */
function seedDemoPipeline() {
  try {
    const def = state.definitions.find(function (d) { return d.id === 'LD_ACTIVE_DROP_001'; });
    if (!def) return { ok: false, error: '种子客群 LD_ACTIVE_DROP_001 不存在' };

    // ① 建方案（最小合规草案字段）→ 提交审批 → 批准
    // 字段口径与前端 collectCfg 完全一致（codex 审核 P0：演示数据曾因字段错位
    // 出现受众 0、配比 10000%（share=100 未除 100）、预算字段名错位 —— 演示数据
    // 也不能绕过业务口径，否则前端异常检测全被架空）。
    const created = tasks.createCampaign({
      name: '消费唤醒 · 关怀外呼（演示）',
      draft: {
        campaign_name: '消费唤醒 · 关怀外呼（演示）',
        objective: '对消费活跃度下降客户做关怀外呼，促 30 天内回归消费',
        audience: { definition_id: 'LD_ACTIVE_DROP_001', size_estimate: 200, criteria_summary: '消费 30 天环比降 ≥70% 且近 60 天无交易' },
        offer: { type: '权益', description: '消费返现券包', summary: '消费返现券包' },
        channels: [{ channel: '智能外呼', share: 1.0 }],
        cadence: { max_per_customer_per_month: 2, window_days: 14, waves: 2, start_date: '2026-11-09', end_date: '2026-12-09' },
        budget: { total: 2000, per_case: 1.2 },
        measurement: { primary_metric: '30 天消费回归率', window_days: 30, control_group_ratio: 0.15 },
        compliance_notes: ['外呼时段 9:00-20:00', '禁呼名单已过滤', '演示数据：指标为演示口径，不作为经营决策依据'],
      },
    });
    // createCampaign 直接返回方案对象（无 {ok,item} 包装）
    if (!created || !created.id) return { ok: false, error: '建方案失败：返回异常 ' + JSON.stringify(created).slice(0, 120) };
    const campId = created.id;
    tasks.transitionCampaign(campId, '待审批', { actor: 'system', note: '演示链路预置' });
    const ap = tasks.transitionCampaign(campId, '已批准', { actor: 'system', note: '演示链路预置（自动审批）' });
    if (!ap.ok) return { ok: false, error: '审批失败：' + (ap.error || '?') };

    // ② 拆任务单 → 执行中（真实下发，写 lead_status）
    const split = tasks.createTasksFromCampaign(campId, { actor: 'system' });
    if (!split.ok) return { ok: false, error: '拆单失败：' + (split.error || '?') };
    const taskList = (split.tasks || []).map(function (x) { return tasks.taskById(x.task_id); }).filter(Boolean);
    if (!taskList.length) return { ok: false, error: '拆单 0 个任务单' };

    let receipts = 0, outcomes = 0;
    for (const t of taskList) {
      // 任务单初始「待审批」：先批准再下发（状态机要求）
      tasks.transitionTask(t.id, '已批准', { actor: 'system', note: '演示链路自动审批' });
      const disp = tasks.transitionTask(t.id, '执行中', { actor: 'system', note: '演示链路下发' });
      if (!disp.ok) continue;
    // ③ 回执：80% 接通 / 其中 40% 有意向响应（点击）/ 其余未接通、空号——
    // 响应类回执把线索推进到「已响应」，漏斗的「客户响应」层才有数据
    // 注意：回执时间戳由 addReceipts 按「当前时刻」落盘——演示数据不会
    // 出现在静默时段（22:00-08:00）违规执行（codex 审核 P0：凌晨 02:00 回执）。
      const leadIds = t.lead_ids || [];
      const rows = [];
      const respondedIds = [];
      leadIds.forEach(function (lid, i) {
        let r;
        // 外呼渠道无「点击」事件（MKT-16 渠道事件字典）：明确响应 = 接通且高意向
        if (i % 5 === 0) { r = '接通'; respondedIds.push(lid); }       // 20% 明确响应（意向级）
        else if (i % 25 < 20) r = '接通';
        else if (i % 25 < 23) r = '未接通';
        else r = '空号';
        rows.push({ lead_id: lid, result: r, duration_s: r === '接通' ? 45 + (i % 60) : 0, intent_level: r === '接通' ? ['A', 'B', 'C'][i % 3] : '' });
      });
      const rc = tasks.addReceipts(t.id, rows, { actor: 'system' });
      if (rc.ok) receipts += rc.accepted;
      // ④ 30 天结果：响应客户里 ~70% 转化（已响应→已转化是合法迁移）、偶发投诉。
      //    线索状态机是逐级的（已触达→已响应→已转化），转化行只选「已响应」的线索，
      //    recordOutcomes 的 setLeadStatus('已转化') 才会成功。
      const st2 = {};
      respondedIds.forEach(function (lid, i) {
        const converted = (i % 10) < 7;
        const complained = !converted && (i % 23) === 5;
        st2[lid] = { lead_id: lid, task_id: t.id, converted: converted, conversion_type: converted ? '刷卡消费' : '', amount: converted ? 300 + (i % 7) * 150 : 0, complained: complained };
      });
      const outcomeRows = Object.values(st2).filter(function (r) { return r.converted || r.complained; });
      const oc = tasks.recordOutcomes(outcomeRows, { actor: 'system' });
      if (oc.ok) outcomes += oc.accepted;
    }
    persist();
    return { ok: true, campaign: campId, tasks: taskList.length, receipts: receipts, outcomes: outcomes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (Array.isArray(raw.definitions) && raw.definitions.length) state.definitions = raw.definitions;
      if (raw.lead_status && typeof raw.lead_status === 'object') state.lead_status = raw.lead_status;
      if (Array.isArray(raw.audit)) state.audit = raw.audit.slice(-500);
      ['campaigns', 'tasks', 'executions', 'outcomes'].forEach(function (k) {
        if (Array.isArray(raw[k])) state[k] = raw[k];
      });
      if (Array.isArray(raw.scripts)) state.scripts = raw.scripts;
      if (Array.isArray(raw.sessions)) state.sessions = raw.sessions.slice(-60);
      state.updated_at = raw.updated_at || null;
    }
  } catch (e) {
    console.warn('[smart-marketing] state 读取失败，按初始状态运行：', e.message);
  }
  if (!state.definitions.length) state.definitions = seedDefinitions();
  if (!state.scripts.length) state.scripts = dialog.seedScripts();
  // 种子升级（画布专项审核 0-3 天项）：state 里的种子脚本版本落后于代码内置版本时，
  // 用新种子覆盖（保留用户自建脚本不动）。旧种子存在已证实的 P0 缺陷：
  // 无 AI 披露 / 无依据断言 / 未识别无限回环 / 无工具却宣告成功 / 转人工记 success /
  // 轮次 8/12 冲突。版本号对齐 = 用户改过种子（version 更高）则不覆盖。
  const seeds = dialog.seedScripts();
  state.scripts.forEach(function (s, i) {
    const fresh = seeds.find(function (x) { return x.id === s.id; });
    if (fresh && (fresh.version || 1) > (s.version || 1)) state.scripts[i] = JSON.parse(JSON.stringify(fresh));
  });
  if (!state.assets) state.assets = seedAssets();
  // 回放线索状态：只接受引擎里真实存在、且属于已知状态值的记录
  const validStatus = new Set(engine.STATUSES);
  let replayed = 0;
  Object.keys(state.lead_status).forEach(function (id) {
    const lead = engine.leadById(id);
    const st = state.lead_status[id];
    if (!lead || !validStatus.has(st)) return;
    lead.status = st;
    if (st === '已触达' || st === '已响应' || st === '已转化') lead.contacted = true;
    if (st === '已响应' || st === '已转化') lead.responded = true;
    if (st === '已转化') lead.converted = true;
    replayed++;
  });
  if (replayed) console.log('[smart-marketing] 已回放线索状态 ' + replayed + ' 条');
}

let saveTimer = null;
function persist() {
  state.updated_at = new Date().toISOString();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    saveTimer = null;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      console.warn('[smart-marketing] state 落盘失败：', e.message);
    }
  }, 200);
  if (saveTimer.unref) saveTimer.unref();
}

function audit(entry) {
  /* 审计哈希链（codex 审核 P1：普通 JSON 数组不构成可信审计链）。
     每条记录 = 业务字段 + seq + prev_hash + hash：
       hash = sha256(prev_hash + ts + actor + action + target + detail + seq)
     追加写不改历史；任何事后篡改/删除都会导致后续所有 hash 校验断裂。
     state.audit 截断到 500 条时链仍连续（链头 hash 一并保留校验锚点）。 */
  const prev = state.audit[state.audit.length - 1];
  // 链起点：前一条是旧记录（无 hash）或不存在 → 从 GENESIS 起新链
  const prevHash = (prev && prev.hash) ? prev.hash : 'GENESIS';
  const seq = (prev && prev.seq ? prev.seq : 0) + 1;
  const rec = Object.assign({ ts: new Date().toISOString(), seq: seq }, entry);
  const payload = [seq, rec.ts, rec.actor || '', rec.action || '', rec.target || '', rec.detail || ''].join('|');
  rec.prev_hash = prevHash;
  rec.hash = crypto.createHash('sha256').update(rec.prev_hash + '|' + payload).digest('hex').slice(0, 32);
  state.audit.push(rec);
  if (state.audit.length > 500) state.audit = state.audit.slice(-500);
}

/* 审计链完整性校验：逐条重算 hash，返回断裂位置。
   用于合规页「审计链完整性」指标——任何篡改/删除/乱序都会暴露。
   兼容：哈希链启用前的旧记录（无 hash 字段）跳过校验、不作为锚点，
   新链从第一条带 hash 的记录起算（prev_hash=GENESIS）。 */
function verifyAuditChain(rows) {
  const list = rows || state.audit;
  let prevHash = null;
  let checkedNew = 0;
  for (let i = 0; i < list.length; i++) {
    const rec = list[i];
    // 链外记录：启用哈希链之前的旧记录（无 hash）+ 过渡期写入的孤儿记录（hash 有值但
    // prev_hash 缺失——旧版 audit 在前一条无 hash 时写了 undefined，JSON 序列化丢字段）。
    // 都跳过校验；新链从第一条 prev_hash=GENESIS 的记录起算。
    if (!rec.hash || !rec.prev_hash) continue;
    if (prevHash === null) {
      // 链头两种合法形态：
      //   a) GENESIS——链的第一条记录；
      //   b) 任意有效 hash——500 条截断把链头截掉了（截断续链）。
      // 截断续链无法发现「链头之前的删除」，这是截断的固有边界（审计只保证
      // 可见窗口内完整）。要在窗口外也防删除，需外部位移存证（后续迭代）。
      prevHash = rec.prev_hash;   // 从可见链头开始校验
    } else if (rec.prev_hash !== prevHash) {
      return { ok: false, broken_at: rec.seq || i, reason: 'prev_hash 不连续（记录被删除或插入）', checked: checkedNew };
    }
    const payload = [rec.seq, rec.ts, rec.actor || '', rec.action || '', rec.target || '', rec.detail || ''].join('|');
    const expect = crypto.createHash('sha256').update(rec.prev_hash + '|' + payload).digest('hex').slice(0, 32);
    if (expect !== rec.hash) {
      return { ok: false, broken_at: rec.seq || i, reason: 'hash 不匹配（记录内容被篡改）', checked: checkedNew };
    }
    prevHash = rec.hash;
    checkedNew++;
  }
  if (checkedNew === 0) return { ok: true, checked: 0, note: '全部为链启用前旧记录，链从下一条开始' };
  return { ok: true, checked: checkedNew, head: prevHash };
}

/* 短随机 ID（触达设计脚本/会话用） */
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/* ISO 时间戳（触达设计脚本创建/更新用） */
function now() {
  return new Date().toISOString();
}

/* ── 客群资产：规模、可触达口径、刷新状态、引用关系 ──
   行业做法（Adobe Audiences / Salesforce Segments / VeCDP 分群 / Quick Audience 人群）
   都把「人群」当成独立资产：有生命周期、有刷新节奏、有无可用状态、被谁引用可查。
   方案只引用客群，不拥有客群；客群被人用着时不可删、不可改规则。 */
const CAMP_LIVE_STATES = ['草稿', '待审批', '已批准', '排期中', '执行中'];

/* 客群三形态统一取口径：rule=DSL 规则，list=上传名单，combine=交并差组合。
   渠道可发送口径全部来自 engine.statsOfCustomers，这里绝不复制第二份。 */
function defKind(d) {
  return d.kind || (typeof d.dsl === 'string' && d.dsl ? 'rule' : (Array.isArray(d.list) ? 'list' : (d.combine ? 'combine' : null)));
}

function defStats(d) {
  const out = { hits: 0, reachable: 0, channels: { app: 0, sms: 0, ivr: 0 }, kind: null };
  if (!d) return out;
  const kind = defKind(d);
  out.kind = kind;
  let s = null;
  if (kind === 'rule') {
    if (typeof d.dsl !== 'string' || !d.dsl) return out;
    s = engine.audienceStats(d.dsl);
  } else if (kind === 'list' || kind === 'combine') {
    const xr = engine.audienceXids(d);
    if (!xr.ok) return out;
    const map = engine.custByXid();
    s = engine.statsOfCustomers(xr.xids.map(function (x) { return map[x]; }).filter(Boolean));
  } else {
    return out;
  }
  if (!s || !s.ok) return out;
  out.hits = s.hits;
  out.channels = { app: s.app, sms: s.sms, ivr: s.ivr };
  // 列表展示用最严口径（短信：必须有号且不在禁呼名单），宁可低估不可高估
  out.reachable = s.sms;
  return out;
}

function defRefs(id) {
  const refs = (state.campaigns || []).filter(function (c) { return c.definition_id === id; });
  const live = refs.filter(function (c) { return CAMP_LIVE_STATES.indexOf(c.status) !== -1; });
  // 组合客群引用了本客群：删掉基底会让组合直接算不出来，与被方案引用同级保护
  const dependents = (state.definitions || []).filter(function (d) {
    return d.id !== id && d.combine && Array.isArray(d.combine.sources) && d.combine.sources.indexOf(id) !== -1;
  }).map(function (d) { return { id: d.id, name: d.name, status: '组合客群引用' }; });
  return {
    total: refs.length + dependents.length,
    live: live.length + dependents.length,
    items: refs.map(function (c) { return { id: c.id, name: c.name, status: c.status }; }).concat(dependents),
  };
}

function defLifecycle(d) {
  const lc = d.lifecycle || {};
  const kind = defKind(d);
  const stats = defStats(d);
  const refs = defRefs(d.id);
  // refresh_mode：auto=定时重算（演示环境每 5 分钟，模拟生产每日批）；manual=只手动刷新。
  // 历史数据里的 batch 视同 auto，避免老状态文件全部退回手动。
  const mode = lc.refresh_mode === 'manual' ? 'manual' : 'auto';
  return {
    kind: kind,
    state: lc.state || (kind ? '可用' : '草稿'),
    refresh: mode === 'manual' ? '手动' : (lc.refresh || '自动 · 每日批（演示 5 分钟一轮）'),
    refresh_mode: mode,
    last_calc_at: lc.last_calc_at || d.updated_at || null,
    hits: stats.hits,
    reachable: stats.reachable,
    channels: stats.channels,
    refs_total: refs.total,
    refs_live: refs.live,
    ref_campaigns: refs.items,
    in_use: refs.live > 0,
  };
}

/* 组合/名单型客群没有 DSL 自带 id，由服务端按日发号（与任务单同款最大流水号+1 算法） */
function nextDefId() {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = 'LD_' + day + '_';
  let max = 0;
  (state.definitions || []).forEach(function (d) {
    if (typeof d.id === 'string' && d.id.indexOf(prefix) === 0) {
      const n = parseInt(d.id.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });
  return prefix + String(max + 1).padStart(3, '0');
}

/* ────────────────────────── HTTP 工具 ────────────────────────── */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function fail(res, status, code, error, extra) {
  sendJson(res, status, Object.assign({ ok: false, code: code, error: error }, extra || {}));
}

function readJson(req) {
  return new Promise(function (resolve) {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        done = true;
        req.destroy();
        resolve({ error: '请求体超过 ' + Math.round(BODY_LIMIT / 1024) + 'KB 上限' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      if (done) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({ data: {} });
      try {
        resolve({ data: JSON.parse(text) });
      } catch (e) {
        resolve({ error: 'JSON 解析失败：' + e.message });
      }
    });
    req.on('error', function () {
      if (!done) resolve({ error: '请求中断' });
    });
  });
}

/* ────────────────────────── 业务视图 ────────────────────────── */

function kpis() {
  const a = engine.aggregate();
  return [
    { key: 'lead_total', label: '线索产出', value: a.total, unit: '条', note: '较昨日 +6.4%', tone: 'up' },
    { key: 'task_rate', label: '转任务率', value: a.tSize ? a.tasks / a.tSize : 0, unit: '', note: a.tasks + ' 条通过合规闸门' },
    { key: 'contact_rate', label: '有效触达率', value: a.tasks ? a.contacts / a.tasks : 0, unit: '', note: a.contacts + ' 次有效触达' },
    { key: 'eff_rate', label: '线索有效率', value: a.effRate, unit: '', note: '目标 12.0%，当前' + (a.effRate >= 0.12 ? '达标' : '未达标') },
    { key: 'uplift', label: '增量转化', value: a.inc, unit: 'pp', note: '对照组 ' + (a.cConv * 100).toFixed(1) + '%' },
  ].map(function (k) {
    if (k.unit === 'pp') k.value = +(k.value * 100).toFixed(2);
    return k;
  });
}

function metricsView() {
  const a = engine.aggregate();
  const ex = engine.experiment(a);
  return {
    ok: true,
    aggregate: a,
    experiment: ex,
    kpis: kpis(),
    funnel: [
      { n: '线索', v: a.total },
      { n: '转任务', v: a.tasks },
      { n: '有效触达', v: a.contacts },
      { n: '客户响应', v: a.resp },
      { n: '30 天结果', v: a.conv },
    ],
    guardrails: engine.GUARDRAILS,
    def_perf: engine.DEF_PERF,
    status_counts: engine.castCounts(),
    // 单日样本量不足以判定显著性，结论以 30 天累计为准（方案第十三章反指标规则）
    note: 'experiment 为 30 天累计口径；单日批次不用于显著性判定。演示数据（seed=' + engine.DATA_SEED + '），接入数仓后须重跑。',
    simulated: true,
  };
}

function leadView(lead) {
  const gates = engine.gatesOf(lead);
  const transitions = { '待指认': ['已下发', '已关闭'], '已下发': ['已触达', '已关闭'], '已触达': ['已响应', '已关闭'], '已响应': ['已转化', '已关闭'], '已转化': ['已关闭'], '已关闭': [] };
  return {
    lead: lead,
    evidence: engine.evidenceOf(lead),
    gates: gates,
    gate_fail_reason: engine.GATE_FAIL,
    decision_card: engine.decisionCardOf(lead),
    allowed_actions: transitions[lead.status] || [],
    blocked: gates.filter(function (g) { return !g.ok; }).map(function (g) { return g.id; }),
  };
}

const ACTION_MAP = {
  dispatch: '已下发',
  contact: '已触达',
  respond: '已响应',
  convert: '已转化',
  close: '已关闭',
};

const tasks = createTaskStore({
  state: state,
  persist: persist,
  audit: audit,
  engine: engine,
  // 方案绑定的外呼话术方案 → 任务单话术渲染从触达设计取底稿
  scriptOpeningOf: function (id) {
    const sc = (state.scripts || []).find(function (x) { return x.id === id; });
    return sc ? { id: sc.id, name: sc.name, stage: sc.stage, version: sc.version, nodes: sc.nodes } : null;
  },
  // 方案绑定的素材 → 推送/短信任务单文案从素材库取
  creativeOf: function (id) {
    const A = state.assets || (state.assets = seedAssets());
    const c2 = (A.creatives || []).find(function (x) { return x.id === id; });
    return c2 ? { id: c2.id, channel: c2.channel, title: c2.title, body: c2.body, version: c2.version } : null;
  },
});
const datasets = createDatasetStore();

/* 标签与画像共用同一份客户底表：激活的数据集优先，否则用内置样本。
 * 所有页面（线索池、画像、方案人群）必须同源，否则会出现「线索池 240 人、
 * 画像页 6000 人」这种自相矛盾的数字。 */
function currentCustomers() {
  const active = datasets.activeRows();
  return active ? active.rows : engine.CUSTOMERS;
}

function findCustomer(xid) {
  const key = String(xid || '');
  return currentCustomers().find(function (c) { return String(c.xid) === key; }) || null;
}

/* ────────────────────────── 路由 ────────────────────────── */

function handle(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  load();

  const rest = p.slice(PREFIX.length) || '/';
  const seg = rest.split('/').filter(Boolean); // ['leads','xxx','actions']
  const method = req.method || 'GET';

  /* ── 健康检查 / 数据集概览 ── */
  if (rest === '/' || rest === '/health') {
    if (method !== 'GET') return fail(res, 405, 'method_not_allowed', '仅支持 GET');
    const s = engine.datasetSummary();
    return sendJson(res, 200, {
      ok: true,
      service: 'smart-marketing',
      engine_version: s.engine_version,
      data_seed: s.data_seed,
      customers: s.customers,
      leads: s.leads,
      status_counts: s.status_counts,
      definitions: state.definitions.length,
      audit_events: state.audit.length,
      persisted: fs.existsSync(STATE_FILE),
      uptime_s: Math.round(process.uptime()),
      simulated: true,
    });
  }

  /* ── DSL 编译与试跑 ── */
  if (seg[0] === 'dsl' && seg[1] === 'compile') {
    if (method !== 'POST') return fail(res, 405, 'method_not_allowed', '仅支持 POST');
    return readJson(req).then(function (r) {
      if (r.error) return fail(res, 400, 'bad_json', r.error);
      const dsl = r.data && r.data.dsl;
      if (typeof dsl !== 'string' || !dsl.trim()) return fail(res, 400, 'missing_dsl', '缺少 dsl 字段');

      // 数据源优先级：显式指定 > 已激活数据集 > 内置模拟样本。
      // 「激活即生效」必须在这里体现，否则数据管理页的激活按钮没有实际意义。
      let customers = null;
      let datasetInfo = null;
      if (r.data.dataset_id) {
        const rows = datasets.rowsOf(r.data.dataset_id, r.data.dataset_version);
        if (!rows) return fail(res, 404, 'dataset_not_found', '数据集不存在：' + r.data.dataset_id);
        const meta = datasets.get(r.data.dataset_id, r.data.dataset_version);
        customers = rows;
        datasetInfo = { id: meta.id, version: meta.version, name: meta.name, quality: meta.quality.level, rows: rows.length };
      } else {
        const active = datasets.activeRows();
        if (active) {
          const meta = datasets.get(active.id, active.version);
          customers = active.rows;
          datasetInfo = { id: active.id, version: active.version, name: meta.name, quality: meta.quality.level, rows: active.rows.length, activated: true };
        }
      }

      const out = engine.compile(dsl, { universe: r.data.universe, customers: customers });
      return sendJson(res, 200, Object.assign({
        ok: true,
        simulated: !customers,
        dataset: datasetInfo,
        data_source: customers ? 'dataset' : 'builtin-sample',
      }, out));
    });
  }

  /* ── 标签字典：圈选器与客群页共用的字段元数据（口径 / 类型 / 枚举值 / 覆盖率） ── */
  if (seg[0] === 'fields' && method === 'GET' && seg.length === 1) {
    return sendJson(res, 200, { ok: true, items: engine.tagDict() });
  }

  /* ── 线索定义 ── */
  if (seg[0] === 'definitions') {
    if (method === 'GET' && seg.length === 1) {
      return sendJson(res, 200, {
        ok: true,
        items: state.definitions.map(function (d) {
          const kind = defKind(d);
          // 业务选客群包时只看「叫什么、多少人」：命中数在这里一次算好，前端不用再逐个试跑
          const lc = defLifecycle(d);
          return {
            id: d.id,
            name: d.name,
            kind: kind,
            version: d.version,
            owner: d.owner,
            status: d.status,
            updated_at: d.updated_at,
            note: d.note || '',
            // 业务下拉可选项：active 且有圈选内容（规则/名单/组合任一）
            compilable: !!kind,
            selectable: d.status === 'active' && !!kind,
            hits: lc.hits,
            lifecycle: lc,
          };
        }),
      });
    }

    /* 圈选预览：不落库，业务在「上传名单 / 组合客群」面板实时看命中与渠道可发送 */
    if (method === 'POST' && seg.length === 2 && seg[1] === 'preview') {
      return readJson(req).then(function (r) {
        if (r.error) return fail(res, 400, 'bad_json', r.error);
        const body = r.data || {};
        let stats;
        let extra = {};
        if (body.kind === 'list') {
          const ids = Array.isArray(body.list) ? body.list.map(function (s) { return String(s).trim(); }).filter(Boolean) : [];
          const map = engine.custByXid();
          const matched = ids.filter(function (x) { return map[x]; });
          extra = { given: ids.length, matched: matched.length, unmatched: ids.length - matched.length };
          stats = engine.statsOfCustomers(matched.map(function (x) { return map[x]; }));
        } else if (body.kind === 'combine') {
          const probe = { combine: body.combine };
          const xr = engine.audienceXids(probe);
          if (!xr.ok) return fail(res, 422, 'combine_failed', '组合无法计算：' + (xr.errs || []).join('；'));
          const map = engine.custByXid();
          stats = engine.statsOfCustomers(xr.xids.map(function (x) { return map[x]; }).filter(Boolean));
        } else if (typeof body.dsl === 'string' && body.dsl) {
          stats = engine.audienceStats(body.dsl);
          if (!stats.ok) return fail(res, 422, 'compile_failed', '规则编译未通过', { errs: stats.errs });
        } else {
          return fail(res, 400, 'missing_body', '缺少 kind / dsl');
        }
        return sendJson(res, 200, Object.assign({
          ok: true,
          hits: stats.hits || 0,
          channels: { app: stats.app || 0, sms: stats.sms || 0, ivr: stats.ivr || 0 },
          universe: engine.CUSTOMERS.length,
        }, extra));
      });
    }

    if (method === 'GET' && seg.length === 2) {
      const d = state.definitions.find(function (x) { return x.id === seg[1]; });
      if (!d) return fail(res, 404, 'not_found', '定义不存在：' + seg[1]);
      return sendJson(res, 200, { ok: true, item: d });
    }
    if (method === 'POST' && seg.length === 1) {
      return readJson(req).then(function (r) {
        if (r.error) return fail(res, 400, 'bad_json', r.error);
        const body = r.data || {};
        if (typeof body.dsl !== 'string' || !body.dsl.trim()) return fail(res, 400, 'missing_dsl', '缺少 dsl 字段');
        const compiled = engine.compile(body.dsl);
        if (!compiled.ok) {
          return fail(res, 422, 'compile_failed', 'DSL 编译未通过，未保存', { errs: compiled.errs });
        }
        const def = compiled.def;
        const exists = state.definitions.find(function (x) { return x.id === def.id; });
        const now = new Date().toISOString();
        if (exists) {
          const prev = exists.version;
          exists.dsl = body.dsl;
          exists.name = body.name || def.name || exists.name;
          exists.owner = body.owner || def.owner || exists.owner;
          exists.version = Math.max(prev + 1, def.version || 1);
          exists.updated_at = now;
          exists.status = 'active';
          // 规则改了就是一次新的计算：规模与「上次更新」必须跟着变，否则业务看到的是旧人数
          exists.lifecycle = Object.assign({ refresh: '每日 04:00', refresh_mode: 'batch' }, exists.lifecycle, { state: '可用', last_calc_at: now });
          audit({ actor: 'web', action: 'definition.update', target: def.id, detail: 'v' + prev + ' → v' + exists.version });
          persist();
          return sendJson(res, 200, { ok: true, item: exists, version_from: prev, metrics: compiled.metrics });
        }
        const item = {
          id: def.id,
          name: body.name || def.name || def.id,
          version: def.version || 1,
          owner: body.owner || def.owner || '',
          status: 'active',
          dsl: body.dsl,
          created_at: now,
          updated_at: now,
          note: body.note || '',
          lifecycle: { state: '可用', refresh: body.refresh || '每日 04:00', refresh_mode: 'batch', last_calc_at: now },
        };
        state.definitions.push(item);
        audit({ actor: 'web', action: 'definition.create', target: def.id, detail: 'v' + item.version });
        persist();
        return sendJson(res, 201, { ok: true, item: item, metrics: compiled.metrics });
      });
    }
    /* 名单型客群（上传名单）：客户编号列表 → 校验 → 落定义 → 实例化线索。
       VeCDP / Quick Audience 的三入口之一就是上传名单。 */
    if (method === 'POST' && seg.length === 2 && seg[1] === 'import-list') {
      return readJson(req).then(function (r) {
        if (r.error) return fail(res, 400, 'bad_json', r.error);
        const body = r.data || {};
        const ids = Array.isArray(body.list) ? body.list.map(function (s) { return String(s).trim(); }).filter(Boolean) : [];
        if (!ids.length) return fail(res, 400, 'empty_list', '名单为空：请粘贴客户编号（每行一个）');
        if (ids.length > 5000) return fail(res, 400, 'too_many', '名单一次最多 5000 个客户编号，更多请分批导入');
        if (!body.name || !String(body.name).trim()) return fail(res, 400, 'missing_name', '请给客群起个名字');
        const map = engine.custByXid();
        const matched = ids.filter(function (x) { return map[x]; });
        if (!matched.length) {
          return fail(res, 422, 'no_match', '名单里没有一个客户编号能在系统里对上（共 ' + ids.length + ' 个），请检查编号格式', { given: ids.length, matched: 0 });
        }
        const now = new Date().toISOString();
        const item = {
          id: nextDefId(),
          name: String(body.name).trim(),
          kind: 'list',
          list: matched,
          list_given: ids.length,
          version: 1,
          owner: body.owner || '',
          status: 'active',
          dsl: null,
          created_at: now,
          updated_at: now,
          note: body.note || ('上传名单 ' + ids.length + ' 个编号，匹配 ' + matched.length + ' 人'),
          lifecycle: { state: '可用', refresh: '手动', refresh_mode: body.refresh_mode === 'auto' ? 'auto' : 'manual', last_calc_at: now },
        };
        state.definitions.push(item);
        const mat = engine.materializeXids(matched, item.id, 1, { limit: body.limit || 300 });
        audit({ actor: 'web', action: 'definition.import_list', target: item.id, detail: '名单 ' + ids.length + ' → 匹配 ' + matched.length + ' 人，新入池 ' + mat.added + ' 条' });
        persist();
        return sendJson(res, 201, { ok: true, item: item, matched: matched.length, unmatched: ids.length - matched.length, materialize: mat });
      });
    }
    /* 组合客群（交并差）：A 并 B / A 交 B / A 剔除 B。来源可以是任意形态的已有客群。 */
    if (method === 'POST' && seg.length === 2 && seg[1] === 'combine') {
      return readJson(req).then(function (r) {
        if (r.error) return fail(res, 400, 'bad_json', r.error);
        const body = r.data || {};
        const cb = body.combine || {};
        if (['union', 'intersect', 'minus'].indexOf(cb.op) === -1) {
          return fail(res, 400, 'bad_op', '组合方式必须是 union / intersect / minus');
        }
        const sources = Array.isArray(cb.sources) ? cb.sources.filter(Boolean) : [];
        if (sources.length < 2) return fail(res, 400, 'need_sources', '组合至少需要 2 个来源客群');
        if (!body.name || !String(body.name).trim()) return fail(res, 400, 'missing_name', '请给组合客群起个名字');
        const missing = sources.filter(function (id) { return !state.definitions.find(function (d) { return d.id === id; }); });
        if (missing.length) return fail(res, 404, 'source_not_found', '来源客群不存在：' + missing.join('、'));
        const now = new Date().toISOString();
        const item = {
          id: nextDefId(),
          name: String(body.name).trim(),
          kind: 'combine',
          combine: { op: cb.op, sources: sources },
          version: 1,
          owner: body.owner || '',
          status: 'active',
          dsl: null,
          created_at: now,
          updated_at: now,
          note: body.note || '',
          lifecycle: { state: '可用', refresh: '自动 · 每日批（演示 5 分钟一轮）', refresh_mode: 'auto', last_calc_at: now },
        };
        // 立即算一次：组合算不出来（来源是草稿等）就不保存，不给业务留一个死客群
        const probe = defStats(item);
        if (!probe.kind || (!probe.hits && cb.op !== 'minus')) {
          const xr = engine.audienceXids(item);
          return fail(res, 422, 'combine_failed', '组合无法计算：' + (xr.errs || []).join('；') + '。请检查来源客群是否已发布', {});
        }
        const opN = { union: '合并', intersect: '交集', minus: '剔除' }[cb.op];
        item.note = body.note || (opN + '组合：' + sources.map(function (id) {
          const s = state.definitions.find(function (d) { return d.id === id; });
          return (s && s.name) || id;
        }).join(cb.op === 'minus' ? ' − ' : ' + '));
        state.definitions.push(item);
        const xr = engine.audienceXids(item);
        const mat = engine.materializeXids(xr.ok ? xr.xids : [], item.id, 1, { limit: body.limit || 300 });
        audit({ actor: 'web', action: 'definition.combine', target: item.id, detail: item.note + '，命中 ' + probe.hits + ' 人' });
        persist();
        return sendJson(res, 201, { ok: true, item: item, stats: probe, materialize: mat });
      });
    }
    /* 手动刷新客群：重算规模并记录计算时间，方案里显示的「上次更新」就来自这里。
       三种形态都能刷：规则重编译、名单/组合重算统计。 */
    if (method === 'POST' && seg.length === 3 && seg[2] === 'refresh') {
      const d = state.definitions.find(function (x) { return x.id === seg[1]; });
      if (!d) return fail(res, 404, 'not_found', '客群不存在：' + seg[1]);
      const kind = defKind(d);
      if (!kind) return fail(res, 409, 'not_compiled', '该客群还没有圈选内容，无法计算规模');
      if (kind === 'rule') {
        const compiled = engine.compile(d.dsl);
        if (!compiled.ok) return fail(res, 422, 'compile_failed', '规则编译未通过，无法刷新', { errs: compiled.errs });
      } else {
        const xr = engine.audienceXids(d);
        if (!xr.ok) return fail(res, 422, 'calc_failed', '规模计算失败：' + (xr.errs || []).join('；'));
      }
      const started = Date.now();
      const st = defStats(d);
      d.lifecycle = Object.assign({}, d.lifecycle, {
        state: '可用',
        last_calc_at: new Date().toISOString(),
        calc_ms: Date.now() - started,
      });
      audit({ actor: 'web', action: 'audience.refresh', target: d.id, detail: '命中 ' + (st.hits || 0) + ' 人' });
      persist();
      return sendJson(res, 200, { ok: true, item: d, lifecycle: defLifecycle(d) });
    }

    /* 刷新方式切换：auto=定时重算（演示 5 分钟一轮，模拟生产每日批）；manual=只手动刷 */
    if (method === 'POST' && seg.length === 3 && seg[2] === 'refresh-mode') {
      return readJson(req).then(function (r) {
        if (r.error) return fail(res, 400, 'bad_json', r.error);
        const d = state.definitions.find(function (x) { return x.id === seg[1]; });
        if (!d) return fail(res, 404, 'not_found', '客群不存在：' + seg[1]);
        const mode = (r.data || {}).mode;
        if (['auto', 'manual'].indexOf(mode) === -1) return fail(res, 400, 'bad_mode', 'mode 必须是 auto 或 manual');
        d.lifecycle = Object.assign({}, d.lifecycle, {
          refresh_mode: mode,
          refresh: mode === 'manual' ? '手动' : '自动 · 每日批（演示 5 分钟一轮）',
        });
        audit({ actor: 'web', action: 'audience.refresh_mode', target: d.id, detail: '→ ' + mode });
        persist();
        return sendJson(res, 200, { ok: true, item: d, lifecycle: defLifecycle(d) });
      });
    }

    /* 删除客群：被在跑方案引用时不允许删。Mapp / Marketo / Azure Customer Profiles
       都是这个约束——否则方案指向一个不存在的客群，等拆单时才炸。 */
    if (method === 'DELETE' && seg.length === 2) {
      const idx = state.definitions.findIndex(function (x) { return x.id === seg[1]; });
      if (idx === -1) return fail(res, 404, 'not_found', '客群不存在：' + seg[1]);
      const refs = defRefs(seg[1]);
      // 在跑方案引用、或被组合客群依赖，都不能删——否则指向不存在的客群，拆单时才炸
      const blockers = refs.items.filter(function (c) {
        return CAMP_LIVE_STATES.indexOf(c.status) !== -1 || c.status === '组合客群引用';
      });
      if (blockers.length) {
        return fail(res, 409, 'in_use',
          '该客群正被引用（' + blockers.map(function (c) { return c.name; }).join('、') + '），不能删除。请先结案、删除组合或改用其他客群。',
          { refs: refs.items });
      }
      const removed = state.definitions.splice(idx, 1)[0];
      audit({ actor: 'web', action: 'audience.delete', target: removed.id, detail: removed.name || '' });
      persist();
      return sendJson(res, 200, { ok: true, removed: removed.id });
    }

    // 圈客 → 线索实例化：新客群圈出的客户必须落成线索，方案才有名单可拆单下发。
    // 三种形态都支持：规则走 DSL，名单/组合按 xid 补录。
    if (method === 'POST' && seg.length === 3 && seg[2] === 'materialize') {
      const def = state.definitions.find(function (d) { return d.id === seg[1]; });
      if (!def) return fail(res, 404, 'not_found', '客群包不存在：' + seg[1]);
      const kind = defKind(def);
      if (!kind) return fail(res, 400, 'no_source', '该客群包还没有圈选内容，无法生成线索');
      return readJson(req).then(function (r) {
        let out;
        if (kind === 'rule') {
          out = engine.materialize(def.dsl, { limit: (r.data && r.data.limit) || 300 });
        } else {
          const xr = engine.audienceXids(def);
          if (!xr.ok) return fail(res, 422, 'calc_failed', '圈客计算失败：' + (xr.errs || []).join('；'));
          out = engine.materializeXids(xr.xids, def.id, def.version, { limit: (r.data && r.data.limit) || 300 });
        }
        if (!out.ok) return fail(res, 422, out.code || 'materialize_failed', '线索生成失败', out);
        audit({
          actor: 'web', action: 'definition.materialize', target: def.id,
          detail: '命中 ' + out.hits + ' 人，新入池 ' + out.added + ' 条（该客群包线索共 ' + out.in_pool + ' 条）',
        });
        persist();
        return sendJson(res, 200, out);
      });
    }
    return fail(res, 405, 'method_not_allowed', '定义接口仅支持 GET / POST');
  }

  /* ── 线索池 ── */
  if (seg[0] === 'leads') {
    if (method === 'GET' && seg.length === 1) {
      // 按客群包看线索：只返回该定义圈出来的线索。查不到就是 0 条，绝不回落全量——
      // 「定义 A 显示全量线索」会让业务以为圈了 240 人，实际一条都不属于它。
      const defFilter = url.searchParams.get('definition_id') || '';
      if (defFilter) {
        const list = engine.allLeads().filter(function (l) { return l.defId === defFilter; });
        const size = Math.max(1, Math.min(Number(url.searchParams.get('size')) || 20, 200));
        const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
        const pages = Math.max(1, Math.ceil(list.length / size));
        return sendJson(res, 200, {
          ok: true, total: list.length, page: page, pages: pages, size: size,
          rows: list.slice((page - 1) * size, page * size), filter: 'definition',
        });
      }
      const out = engine.listLeads({
        filter: url.searchParams.get('filter') || 'all',
        page: url.searchParams.get('page') || 1,
        size: url.searchParams.get('size') || 20,
        q: url.searchParams.get('q') || '',
        sort: url.searchParams.get('sort') || '',
        dir: url.searchParams.get('dir') || 'desc',
      });
      return sendJson(res, 200, Object.assign({ ok: true }, out));
    }
    if (seg.length >= 2) {
      const lead = engine.leadById(seg[1]);
      if (!lead) return fail(res, 404, 'not_found', '线索不存在：' + seg[1]);

      if (method === 'GET' && seg.length === 2) {
        return sendJson(res, 200, Object.assign({ ok: true }, leadView(lead)));
      }

      if (method === 'POST' && seg.length === 3 && seg[2] === 'actions') {
        return readJson(req).then(function (r) {
          if (r.error) return fail(res, 400, 'bad_json', r.error);
          const action = (r.data && r.data.action) || '';
          const next = ACTION_MAP[action];
          if (!next) {
            return fail(res, 400, 'bad_action', '未知动作：' + action + '，可用：' + Object.keys(ACTION_MAP).join('/'));
          }
          const from = lead.status;
          const result = engine.setLeadStatus(lead.id, next);
          audit({
            actor: (r.data && r.data.actor) || 'web',
            action: 'lead.' + action,
            target: lead.id,
            from: from,
            to: next,
            result: result.ok ? 'ok' : result.code,
            detail: result.ok ? '' : result.error,
          });
          if (!result.ok) {
            persist();
            return fail(res, 409, result.code, result.error, { failed: result.failed || [], current_status: from });
          }
          state.lead_status[lead.id] = lead.status;
          persist();
          return sendJson(res, 200, Object.assign({ ok: true, from: from, status: lead.status }, leadView(lead)));
        });
      }
    }
    return fail(res, 404, 'not_found', '未匹配的线索接口：' + p);
  }

  /* ── 指标 ── */
  /* ────────── 标签体系与客户画像 ──────────
   * 标签是「服务」：营销定义 DSL、方案目标人群、画像页都从这里取同一套口径，
   * 避免各页面各算一套（同业标签平台最常见的失败原因）。
   */
  if (seg[0] === 'tags') {
    if (method === 'GET' && seg.length === 1) {
      const out = tags.catalog(currentCustomers());
      return sendJson(res, 200, Object.assign({ ok: true, data_source: datasets.activeRows() ? 'dataset' : 'builtin-sample' }, out));
    }
    if (method === 'GET' && seg.length === 2) {
      const c = findCustomer(seg[1]);
      if (!c) return fail(res, 404, 'not_found', '客户不存在：' + seg[1]);
      const list = tags.computeTags(c);
      return sendJson(res, 200, { ok: true, customer: c, version: tags.VERSION, tags: list, groups: tags.groupTags(list) });
    }
  }

  if (seg[0] === 'customers') {
    if (method === 'GET' && seg.length === 1) {
      const q = (url.searchParams.get('q') || '').trim();
      const page = Math.max(1, Number(url.searchParams.get('page') || 1));
      const size = Math.min(100, Math.max(5, Number(url.searchParams.get('size') || 20)));
      const risk = url.searchParams.get('risk') || '';
      const band = url.searchParams.get('band') || '';
      let rows = currentCustomers();
      if (q) rows = rows.filter(c => String(c.xid || '').indexOf(q) !== -1 || String(c.name || '').indexOf(q) !== -1);
      if (risk || band) {
        rows = rows.filter(c => {
          const t = tags.computeTags(c);
          const g = id => (t.find(x => x.id === id) || {}).value;
          if (risk && g('T_CHURN_LEVEL') !== risk) return false;
          if (band && g('T_VALUE_BAND') !== band) return false;
          return true;
        });
      }
      const total = rows.length;
      const pages = Math.max(1, Math.ceil(total / size));
      const slice = rows.slice((page - 1) * size, (page - 1) * size + size).map(c => {
        const t = tags.computeTags(c);
        const g = id => (t.find(x => x.id === id) || {}).value;
        return {
          xid: c.xid, name: c.name, tier: c.tier, limit: c.limit, value: c.value,
          txn30: c.txn30, txnPrev: c.txnPrev, amt30: c.amt30, days: c.days, inApp30: c.inApp30,
          churn_risk: g('T_CHURN_RISK'), churn_level: g('T_CHURN_LEVEL'),
          value_band: g('T_VALUE_BAND'), active_drop: g('T_ACTIVE_DROP'),
        };
      });
      return sendJson(res, 200, { ok: true, total, page, pages, size, rows: slice });
    }
    if (method === 'GET' && seg.length === 3 && seg[2] === 'profile') {
      const c = findCustomer(seg[1]);
      if (!c) return fail(res, 404, 'not_found', '客户不存在：' + seg[1]);
      return sendJson(res, 200, Object.assign({ ok: true }, tags.profileOf(c, currentCustomers())));
    }
  }

  if (seg[0] === 'metrics' && method === 'GET') {
    return sendJson(res, 200, metricsView());
  }

  /* ── 算子中心 ── */
  if (seg[0] === 'operators') {
    if (method !== 'GET') return fail(res, 405, 'method_not_allowed', '仅支持 GET');
    if (seg.length === 1) {
      return sendJson(res, 200, {
        ok: true,
        items: engine.OPS.map(function (o) {
          return Object.assign({}, o, { meta: engine.opMeta(o) });
        }),
        blocked_from_customer_facing: engine.OPS.filter(function (o) { return o.e === 'NONE'; }).map(function (o) { return o.id; }),
      });
    }
    const o = engine.OPS.find(function (x) { return x.id === seg[1]; });
    if (!o) return fail(res, 404, 'not_found', '算子不存在：' + seg[1]);
    return sendJson(res, 200, { ok: true, item: o, meta: engine.opMeta(o) });
  }

  /* ── 合规与异常 ── */
  if (seg[0] === 'compliance' && method === 'GET') {
    const gateTotal = engine.GATE_STATS.reduce(function (a, b) { return a + b.c; }, 0);
    return sendJson(res, 200, {
      ok: true,
      ai_apps: engine.AI_APPS,
      gate_stats: engine.GATE_STATS,
      gate_total: gateTotal,
      alerts: engine.ALERTS,
      audit_preview: state.audit.slice(-10).reverse(),
      // 审计链完整性（哈希链校验）：合规页可回答「审计记录有没有被改过」
      audit_chain: verifyAuditChain(),
    });
  }

  /* ── 审计 ── */
  if (seg[0] === 'audit' && method === 'GET') {
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
    return sendJson(res, 200, {
      ok: true,
      total: state.audit.length,
      items: state.audit.slice(-limit).reverse(),
      chain: verifyAuditChain(),
    });
  }

  /* ────────── 数据集（导入 / 清洗 / 治理） ────────── */
  if (seg[0] === 'datasets') {
    if (method === 'GET' && seg.length === 1) {
      return sendJson(res, 200, { ok: true, items: datasets.list(), active: datasets.loadIndex().active_id || null });
    }
    if (method === 'POST' && seg[1] === 'preview') {
      return readJson(req).then(function (r) {
        if (r.error) return fail(res, 400, 'bad_json', r.error);
        const body = r.data || {};
        if (typeof body.content !== 'string' || !body.content.trim()) {
          return fail(res, 400, 'missing_content', '缺少 content 字段（CSV 文本）');
        }
        const out = datasets.preview(body.content, { filename: body.filename });
        if (out.ok) delete out._parsed;
        return sendJson(res, out.ok ? 200 : 400, out.ok ? out : { ok: false, code: out.code, error: out.error });
      });
    }
    if (method === 'POST' && seg.length === 1) {
      return readJson(req).then(function (r) {
        if (r.error) return fail(res, 400, 'bad_json', r.error);
        const body = r.data || {};
        if (typeof body.content !== 'string' || !body.content.trim()) {
          return fail(res, 400, 'missing_content', '缺少 content 字段（CSV 文本）');
        }
        const out = datasets.commit(body.content, body);
        if (!out.ok) return fail(res, 422, out.code, out.error, out);
        audit({
          actor: body.actor || 'web',
          action: 'dataset.commit',
          target: out.dataset.id + ' v' + out.dataset.version,
          detail: '质量 ' + out.dataset.quality.level + ' / ' + out.dataset.quality.score + ' 分，接受 '
            + out.dataset.accepted_count + ' 行，拒绝 ' + out.dataset.rejected_count + ' 行',
        });
        persist();
        delete out.dir;
        return sendJson(res, 201, { ok: true, dataset: out.dataset });
      });
    }
    if (method === 'GET' && seg.length === 2) {
      const meta = datasets.get(seg[1], url.searchParams.get('version'));
      if (!meta) return fail(res, 404, 'not_found', '数据集不存在：' + seg[1]);
      return sendJson(res, 200, { ok: true, dataset: meta });
    }
    if (method === 'POST' && seg[2] === 'activate') {
      const out = datasets.activate(seg[1], url.searchParams.get('version'));
      if (!out.ok) return fail(res, 409, out.code, out.error, out);
      audit({ actor: 'web', action: 'dataset.activate', target: seg[1], detail: 'v' + out.dataset.version });
      persist();
      return sendJson(res, 200, { ok: true, dataset: out.dataset });
    }
    return fail(res, 404, 'not_found', '未匹配的数据集接口：' + p);
  }

  /* ────────── 营销方案 ────────── */
  if (seg[0] === 'campaigns') {
    if (method === 'GET' && seg.length === 1) {
      return sendJson(res, 200, { ok: true, items: tasks.listCampaigns(), states: tasks.CAMPAIGN_STATES });
    }
    if (method === 'POST' && seg[1] === 'generate') {
      return readJson(req).then(function (r) {
        if (r.error) return fail(res, 400, 'bad_json', r.error);
        const body = r.data || {};
        const def = state.definitions.find(function (d) { return d.id === body.definition_id; }) || { id: body.definition_id || null, name: '' };
        const universe = engine.listLeads({ filter: 'all', page: 1, size: 5000 });
        const audienceSize = Number(body.audience_size) || (universe.rows || []).length;
        return agents.draftCampaign({
          definition_id: def.id,
          definition_name: def.name || body.definition_name || '',
          criteria_summary: body.criteria_summary || '按线索定义圈选，需经闸门与频控过滤',
          audience_size: audienceSize,
          budget_cap: Number(body.budget_cap) || 1000000,
          cost_per_case: Number(body.cost_per_case) || 1.2,
          window_days: Number(body.window_days) || 30,
          strategy_mode: body.strategy_mode || 'group',
          start_date: body.start_date || null,
          end_date: body.end_date || null,
          month: body.month || new Date().toISOString().slice(0, 7),
        }).then(function (out) {
          audit({
            actor: 'agent', action: 'agent.campaign-draft', target: def.id || 'unknown',
            detail: (out.source === 'agent' ? '模型生成' : '模板生成') + ' · 违规 ' + (out.violations || []).length
              + ' 项 · ' + out.audit.elapsed_ms + 'ms · model=' + (out.audit.model || '-'),
          });
          persist();
          return sendJson(res, out.ok ? 200 : 422, {
            ok: out.ok, draft: out.draft, source: out.source, degraded: out.degraded,
            degraded_reason: out.degraded_reason || null, violations: out.violations || [],
            model_violations: out.model_violations || [],
            audit: out.audit, audience_size: audienceSize,
          });
        });
      });
    }
    if (method === 'PUT' && seg.length === 2) {
      // 编辑配置：仅草稿/待审批可改，已批准后必须新建版本（避免执行中偷偷改预算）
      return readJson(req).then(function (r) {
        if (r.error) return fail(res, 400, 'bad_json', r.error);
        const out = tasks.updateCampaign(seg[1], r.data || {}, { actor: 'web' });
        if (!out.ok) return fail(res, out.code === 'CAMPAIGN_LOCKED' ? 409 : 404, out.code, out.error);
        return sendJson(res, 200, out);
      });
    }
    if (method === 'POST' && seg.length === 1) {
      return readJson(req).then(function (r) {
        if (r.error) return fail(res, 400, 'bad_json', r.error);
        const body = r.data || {};
        if (!body.draft && !body.name) return fail(res, 400, 'missing_draft', '缺少 draft 或 name');
        const item = tasks.createCampaign(body);
        return sendJson(res, 201, { ok: true, item: item });
      });
    }
    if (method === 'GET' && seg.length === 2) {
      const item = tasks.campaignById(seg[1]);
      if (!item) return fail(res, 404, 'not_found', '方案不存在：' + seg[1]);
      const related = tasks.listTasks({ campaign_id: item.id });
      return sendJson(res, 200, { ok: true, item: item, tasks: related });
    }
    if (method === 'POST' && seg[2] === 'actions') {
      return readJson(req).then(function (r) {
        if (r.error) return fail(res, 400, 'bad_json', r.error);
        const body = r.data || {};
        const map = { approve: '已批准', reject: '草稿', terminate: '已终止', submit: '待审批' };
        const next = map[body.action];
        if (!next) return fail(res, 400, 'bad_action', '未知动作：' + body.action + '，可用：' + Object.keys(map).join('/'));
        const out = tasks.transitionCampaign(seg[1], next, { actor: body.actor || 'web', note: body.note });
        if (!out.ok) return fail(res, 409, out.code, out.error, out);
        return sendJson(res, 200, { ok: true, item: out.item, from: out.from });
      });
    }
    if (method === 'POST' && seg[2] === 'tasks') {
      const out = tasks.createTasksFromCampaign(seg[1], { actor: 'web' });
      if (!out.ok) return fail(res, 409, out.code, out.error, out);
      persist();
      return sendJson(res, 201, out);
    }
    /* A/B 实验评估：实验组 vs 对照组真实对比 + 显著性 + RoI + 决策建议 */
    if (method === 'GET' && seg.length === 3 && seg[2] === 'ab-test') {
      const out = tasks.campaignAbTest(seg[1]);
      if (!out) return fail(res, 404, 'not_found', '方案不存在：' + seg[1]);
      return sendJson(res, 200, Object.assign({ ok: true }, out));
    }
    return fail(res, 404, 'not_found', '未匹配的方案接口：' + p);
  }

  /* ────────── 任务单 ────────── */
  if (seg[0] === 'tasks') {
    if (method === 'GET' && seg[1] === 'overview') {
      return sendJson(res, 200, Object.assign({ ok: true, states: tasks.TASK_STATES }, tasks.overview()));
    }
    if (method === 'GET' && seg.length === 1) {
      return sendJson(res, 200, {
        ok: true,
        items: tasks.listTasks({
          status: url.searchParams.get('status') || '',
          campaign_id: url.searchParams.get('campaign_id') || '',
          type: url.searchParams.get('type') || '',
        }),
      });
    }
    if (method === 'GET' && seg.length === 3 && seg[2] === 'audience') {
      // 任务单覆盖的客户样本 + 每人的个性化变量与实际话术（回答「每个客户方案是否一样」）
      const out = tasks.taskAudience(seg[1], { limit: url.searchParams.get('limit') || 20 });
      if (!out) return fail(res, 404, 'not_found', '任务单不存在：' + seg[1]);
      return sendJson(res, 200, Object.assign({ ok: true }, out));
    }
    if (method === 'GET' && seg.length === 2) {
      const item = tasks.taskById(seg[1]);
      if (!item) return fail(res, 404, 'not_found', '任务单不存在：' + seg[1]);
      const receipts = state.executions.filter(function (e) { return e.task_id === item.id; }).slice(-50);
      return sendJson(res, 200, { ok: true, item: item, summary: tasks.taskSummary(item.id), receipts: receipts });
    }
    if (method === 'POST' && seg[2] === 'actions') {
      return readJson(req).then(function (r) {
        if (r.error) return fail(res, 400, 'bad_json', r.error);
        const body = r.data || {};
        const map = {
          submit: '待审批', approve: '已批准', dispatch: '执行中', pause: '已暂停',
          resume: '执行中', complete: '已完成', terminate: '已终止', reject: '草稿',
        };
        const next = map[body.action];
        if (!next) return fail(res, 400, 'bad_action', '未知动作：' + body.action);
        const out = tasks.transitionTask(seg[1], next, { actor: body.actor || 'web', note: body.note });
        if (!out.ok) return fail(res, 409, out.code, out.error, out);
        return sendJson(res, 200, { ok: true, item: out.item, from: out.from, summary: tasks.taskSummary(seg[1]) });
      });
    }
    if (method === 'POST' && seg[2] === 'receipts') {
      return readJson(req).then(function (r) {
        if (r.error) return fail(res, 400, 'bad_json', r.error);
        const body = r.data || {};
        const out = tasks.addReceipts(seg[1], body.receipts, { actor: body.actor || 'crm' });
        if (!out.ok) return fail(res, 409, out.code, out.error, out);
        return sendJson(res, 200, { ok: true, accepted: out.accepted, rejected: out.rejected, summary: tasks.taskSummary(seg[1]) });
      });
    }
    return fail(res, 404, 'not_found', '未匹配的任务接口：' + p);
  }

  /* ────────── 结果回采 ────────── */
  if (seg[0] === 'outcomes') {
    if (method === 'GET') {
      const tid = url.searchParams.get('task_id');
      const rows = tid ? state.outcomes.filter(function (o) { return o.task_id === tid; }) : state.outcomes;
      // 按定义聚合真实回算：outcome → task → campaign → definition。
      // 这是唯一不掺任何假设的口径，前端效果看板用它替代静态推算值。
      const taskById = {};
      state.tasks.forEach(function (t) { taskById[t.id] = t; });
      const campById = {};
      state.campaigns.forEach(function (c) { campById[c.id] = c; });
      const byDef = {};
      rows.forEach(function (o) {
        const t = taskById[o.task_id];
        const c = t ? campById[t.campaign_id] : null;
        const key = (c && c.definition_id) || '未关联';
        const slot = byDef[key] || (byDef[key] = {
          definition_id: key,
          definition_name: (c && c.definition_name) || '',
          outcomes: 0, converted: 0, amount: 0, complained: 0, unsubscribed: 0
        });
        slot.outcomes++;
        if (o.converted) { slot.converted++; slot.amount += o.amount || 0; }
        if (o.complained) slot.complained++;
        if (o.unsubscribed) slot.unsubscribed++;
      });
      return sendJson(res, 200, { ok: true, total: rows.length, items: rows.slice(-100), by_definition: Object.keys(byDef).length ? byDef : null });
    }
    if (method === 'POST') {
      return readJson(req).then(function (r) {
        if (r.error) return fail(res, 400, 'bad_json', r.error);
        const body = r.data || {};
        const out = tasks.recordOutcomes(body.outcomes || body, { actor: body.actor || 'system' });
        return sendJson(res, 200, out);
      });
    }
  }

  /* ────────── 营销资产：权益池 / 素材库 / 资源位 ────────── */
  if (seg[0] === 'assets') {
    const A = state.assets || (state.assets = seedAssets());
    if (seg.length === 1 && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        offers: A.offers, creatives: A.creatives, slots: A.slots,
        counts: { offers: A.offers.length, creatives: A.creatives.length, slots: A.slots.length },
      });
    }
    /* 方案配置联动：按场景/渠道/状态过滤可选资产 */
    if (seg.length === 2 && seg[1] === 'selectable' && method === 'GET') {
      const scene = url.searchParams.get('scene') || '';
      return sendJson(res, 200, {
        ok: true,
        offers: A.offers.filter(function (o) { return o.status === 'active' && (!scene || o.scene === scene); }),
        creatives: A.creatives.filter(function (c) { return c.status === 'active'; }),
        slots: A.slots.filter(function (s) { return s.status === 'active'; }),
      });
    }
    return fail(res, 404, 'not_found', '未知资产接口');
  }

  /* ────────── 触达设计：外呼对话任务脚本（三阶段引擎） ────────── */
  if (seg[0] === 'scripts') {
    const scriptById = function (id) { return state.scripts.find(function (s) { return s.id === id; }) || null; };
    // 子流程节点运行时按 id 解析目标脚本；引擎通过注入保持与存储层解耦（纯内存可测）。
    dialog.setScriptResolver(scriptById);
    const usedBy = function (id) {
      const campaigns = (state.campaigns || []).filter(function (c) { return c.cfg && c.cfg.script_id === id; }).map(function (c) { return { id: c.id, name: c.name, status: c.status }; });
      // 被其它话术流程当作子流程调用时同样不能删除，否则画布保存后运行时会 flow_target_missing。
      const flows = (state.scripts || []).filter(function (s) {
        return (s.nodes || []).some(function (n) { return n.type === 'flow' && n.script_id === id; });
      }).map(function (s) { return { id: s.id, name: s.name, status: '子流程引用' }; });
      return campaigns.concat(flows);
    };
    const scriptMeta = function (s) {
      return {
        id: s.id, name: s.name, stage: s.stage, scene: s.scene || '', owner: s.owner || '', status: s.status || 'active',
        version: s.version || 1, desc: s.desc || '', created_at: s.created_at, updated_at: s.updated_at,
        nodes: (s.nodes || []).length,
        variables: (s.variables || []).length,
        handlers: (s.handlers || []).length,
        policy: s.policy || null,
        // MKT-知识数矛盾修复：agent 阶段知识存于 policy.knowledge，顶层 knowledge 为空——
        // 元数据统一取两处合计，列表口径与画布/工作台一致。
        knowledge: Math.max((s.knowledge || []).length, ((s.policy || {}).knowledge || []).length),
        runtime: (dialog.STAGES[s.stage] || {}).runtime,
        used_by: usedBy(s.id),
        validation: dialog.validateScript(s),
      };
    };

    // 引擎/运行时/人格元数据（前端渲染三阶段说明与模拟器配置用）
    if (seg.length === 2 && seg[1] === 'meta' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        stages: dialog.STAGES,
        runtimes: dialog.RUNTIMES,
        openjiuwen_map: dialog.OPENJIUWEN_MAP,
        personas: dialog.PERSONAS,
        user_intents: dialog.USER_INTENTS,
        banned_words: dialog.BANNED_WORDS,
        recording_hint: dialog.RECORDING_HINT,
        tool_risks: dialog.TOOL_RISKS,
      });
    }

    /* 会话案例回流（SRT 闭环入口，WOWService §4.3）：按 case_label 分层查看模拟会话 */
    if (seg.length === 2 && seg[1] === 'cases' && method === 'GET') {
      const byLabel = { good: [], bad: [], neutral: [] };
      state.sessions.forEach(function (x) {
        const label = x.case_label || 'neutral';
        byLabel[label].push({
          id: x.id, script_id: x.script_id, script_version: x.script_version, stage: x.stage,
          persona: x.persona, turn: x.turn, status: x.status, end_reason: x.end_reason,
          goal: null, // 由前端按需拉详情
        });
      });
      return sendJson(res, 200, { ok: true, good: byLabel.good.length, bad: byLabel.bad.length, neutral: byLabel.neutral.length, items: state.sessions.slice(-30).map(function (x) { return { id: x.id, script_id: x.script_id, script_version: x.script_version, stage: x.stage, persona: x.persona, turn: x.turn, status: x.status, end_reason: x.end_reason, case_label: x.case_label || 'neutral' }; }) });
    }

    // 三引擎对比：同一人格跑三阶段种子脚本
    if (seg.length === 2 && seg[1] === 'compare' && method === 'POST') {
      return readJson(req).then(async function (r) {
        if (r.error) return fail(res, 400, 'bad_json', r.error);
        const body = r.data || {};
        // 三引擎对比宣称「同一个客户、同一种性格」：没有客户绑定就不可复现，
        // 且各引擎拿到的画像变量不一致会让对比失去意义。与模拟器同一道闸。
        if (!body.customer_xid) return fail(res, 422, 'customer_required', '三引擎对比必须绑定同一个外呼客户：无客户则画像变量无值、结果不可复现，请在模拟器客户下拉选择后再对比');
        const customer = findCustomer(body.customer_xid);
        if (!customer) return fail(res, 404, 'customer_not_found', '客户不存在：' + body.customer_xid);
        const persona = body.persona || 'cooperative';
        const results = {};
                  for (const stage of ['rule', 'llm', 'agent']) {
            const sc = state.scripts.find(function (x) { return x.stage === stage && (x.status || 'active') === 'active'; }) || dialog.seedScripts().find(function (x) { return x.stage === stage; });
            const ses = dialog.createSession(sc, customer, { persona: persona, mode: 'auto' });
            let run;
            if (stage === 'agent') {
              // 阶段3 走真实 LLM 命令生成（CALM 命令生成器模式）；失败时 stepSessionAgentAsync 内部回落确定性决策
              const steps = [];
              const first = dialog.openSession(sc, ses);
              steps.push({ role: 'bot', text: first.text });
              let guard = 0;
              while (ses.status === 'active' && guard < 16) {
                guard++;
                const u = dialog.personaUtterance(ses.persona, ses.turn, ses.id + ':' + ses.turn, ses);
                const r = await dialog.stepSessionAgentAsync(sc, ses, { text: u.text, intent: u.intent });
                steps.push({ role: 'user', text: u.text, intent: u.intent });
                steps.push({ role: 'bot', text: r.text });
                if (r.done || r.handoff) break;
              }
              if (ses.status === 'active') { ses.status = 'done'; ses.end_reason = 'auto_max'; }
              run = { steps, metrics: dialog.sessionMetrics(ses, sc), trace: ses.trace };
            } else if (stage === 'llm' && dialog.realLlm.llmAvailable()) {
              // llm 阶段走真实 LLM（persona 轮次 + 异步步进）；失败时 stepSessionAsync 内部已回落模拟
              const steps = [];
              const first = dialog.openSession(sc, ses);
              steps.push({ role: 'bot', text: first.text });
              let guard = 0;
              while (ses.status === 'active' && guard < 16) {
                guard++;
                const u = dialog.personaUtterance(ses.persona, ses.turn, ses.id + ':' + ses.turn, ses);
                const r = await dialog.stepSessionAsync(sc, ses, { text: u.text, intent: u.intent });
                steps.push({ role: 'user', text: u.text, intent: u.intent });
                steps.push({ role: 'bot', text: r.text });
                if (r.done || r.handoff) break;
              }
              if (ses.status === 'active') { ses.status = 'done'; ses.end_reason = 'auto_max'; }
              run = { steps, metrics: dialog.sessionMetrics(ses, sc), trace: ses.trace };
            } else {
              run = dialog.autoRun(sc, ses);
            }
            // MKT-12 可复现快照：引擎版本/数据种子/脚本版本随结果落盘——
            // 同配置重跑才能比对，否则「结论不可复核」（codex 二审）。
            results[stage] = { script_id: sc.id, script_name: sc.name, script_version: sc.version || 1, metrics: run.metrics, steps: run.steps, trace: run.trace };
          }
          audit({ actor: 'web', action: 'script.compare', target: 'scripts', detail: '三引擎对比 · 人格 ' + persona });
        persist();
        return sendJson(res, 200, {
          ok: true, persona: persona,
          customer: customer ? { xid: customer.xid, name: customer.name } : null,
          results: results,
          // MKT-12 可复现环境快照：同 env 重跑结果应一致（容差内）
          env: {
            engine_version: engine.ENGINE_VERSION,
            data_seed: engine.DATA_SEED,
            model: 'builtin-simulated',   // 阶段三接真实 LLM 时由 agent-llm 运行时覆盖
            ran_at: new Date().toISOString(),
          },
        });
      });
    }

    if (seg.length === 1) {
      if (method === 'GET') {
        return sendJson(res, 200, { ok: true, items: state.scripts.map(scriptMeta), sessions: state.sessions.length });
      }
      if (method === 'POST') {
        return readJson(req).then(function (r) {
          if (r.error) return fail(res, 400, 'bad_json', r.error);
          const b = r.data || {};
          if (!b.name) return fail(res, 400, 'missing_name', '缺少脚本名称');
          if (!dialog.STAGES[b.stage]) return fail(res, 400, 'bad_stage', 'stage 必须是 rule/llm/agent 之一');
          const sc = {
            id: 'SCR_' + b.stage.toUpperCase() + '_' + uid().toUpperCase(),
            name: b.name, stage: b.stage, scene: b.scene || '', owner: b.owner || '零售经营部',
            status: 'draft', version: 1, desc: b.desc || '',
            nodes: Array.isArray(b.nodes) ? b.nodes : [], knowledge: Array.isArray(b.knowledge) ? b.knowledge : [],
            variables: Array.isArray(b.variables) ? b.variables : [],
            handlers: Array.isArray(b.handlers) ? b.handlers : [],
            policy: b.policy || null,
            created_at: now(), updated_at: now(),
          };
          const v = dialog.validateScript(sc);
          if (!v.ok) return fail(res, 422, 'validation_failed', v.errors.join('；'), { errors: v.errors, warnings: v.warnings });
          state.scripts.push(sc);
          audit({ actor: 'web', action: 'script.create', target: sc.id, detail: sc.name + '（' + sc.stage + '）' });
          persist();
          return sendJson(res, 200, { ok: true, item: scriptMeta(sc) });
        });
      }
      return fail(res, 405, 'method_not_allowed', '仅支持 GET/POST');
    }

    if (seg.length >= 2) {
      const sc = scriptById(seg[1]);
      if (!sc && seg[1] !== 'sessions') return fail(res, 404, 'not_found', '脚本不存在：' + seg[1]);

      /* 会话子路由：/scripts/sessions/:sid/... */
      if (seg[1] === 'sessions') {
        const sesIdx = state.sessions.findIndex(function (x) { return x.id === seg[2]; });
        const ses = sesIdx >= 0 ? state.sessions[sesIdx] : null;
        if (!ses) return fail(res, 404, 'not_found', '会话不存在或已过期：' + seg[2]);
        const sesScript = scriptById(ses.script_id) || { stage: ses.stage, nodes: [], policy: {} };
        if (seg[3] === 'turn' && method === 'POST') {
          return readJson(req).then(async function (r) {
            if (r.error) return fail(res, 400, 'bad_json', r.error);
            const b = r.data || {};
            // auto 模式：b.auto=true 时由客户人格自动接话（批量试跑用）
            if (b.auto && ses.mode === 'auto') {
              const u = dialog.personaUtterance(ses.persona, ses.turn, ses.id + ':' + ses.turn, ses);
              b.text = u.text; b.intent = u.intent;
            }
            // llm/agent 阶段走真实 LLM 异步入口（内部失败自动回落同步模拟）；rule 保持同步
            const stepPromise = (ses.stage === 'llm' || ses.stage === 'agent')
              ? dialog.stepSessionAsync(sesScript, ses, { text: b.text, intent: b.intent })
              : Promise.resolve(dialog.stepSession(sesScript, ses, { text: b.text, intent: b.intent }));
            const step = await stepPromise;
            persist();
            return sendJson(res, 200, { ok: true, reply: step.text, done: !!step.done, handoff: !!step.handoff, metrics: step.metrics, turn_record: step.turn_record || null, session: { id: ses.id, status: ses.status, end_reason: ses.end_reason, turn: ses.turn, current_node: (ses.slots || {}).__node || null, slots: Object.fromEntries(Object.entries(ses.slots || {}).filter(function (e) { return e[0].indexOf('__') !== 0; })),
              vars: ses.vars || {}, script_version: ses.script_version, case_label: ses.case_label, history: ses.history.slice(-40), trace: ses.trace.slice(-40), turn_records: ses.turn_records.slice(-20) } });
          });
        }
        if (seg[3] === 'close' && method === 'POST') {
          if (ses.status === 'active') { ses.status = 'done'; ses.end_reason = 'manual_close'; }
          persist();
          return sendJson(res, 200, { ok: true, metrics: dialog.sessionMetrics(ses, sesScript) });
        }
        return fail(res, 404, 'not_found', '未知会话操作');
      }

      if (seg.length === 2) {
        if (method === 'GET') return sendJson(res, 200, { ok: true, item: sc, meta: scriptMeta(sc) });
        if (method === 'PUT') {
          return readJson(req).then(function (r) {
            if (r.error) return fail(res, 400, 'bad_json', r.error);
            const b = r.data || {};
            ['name', 'scene', 'desc', 'status'].forEach(function (k) { if (b[k] != null) sc[k] = b[k]; });
            if (Array.isArray(b.nodes)) sc.nodes = b.nodes;
            if (Array.isArray(b.variables)) sc.variables = b.variables; // 脚本级变量声明（显式创建 + 默认值）
            if (Array.isArray(b.handlers)) sc.handlers = b.handlers;     // 会话级全局 handler（打断意图/兜底/转人工）
            if (Array.isArray(b.knowledge)) sc.knowledge = b.knowledge;
            if (b.policy) sc.policy = b.policy;
            if (b._layout && typeof b._layout === 'object') sc._layout = b._layout; // 画布手工布局（前端视图状态）
            const v = dialog.validateScript(sc);
            if (!v.ok) return fail(res, 422, 'validation_failed', v.errors.join('；'), { errors: v.errors, warnings: v.warnings });
            sc.version = (sc.version || 1) + 1;
            sc.updated_at = now();
            audit({ actor: 'web', action: 'script.update', target: sc.id, detail: sc.name + ' → v' + sc.version });
            persist();
            return sendJson(res, 200, { ok: true, item: scriptMeta(sc) });
          });
        }
        if (method === 'DELETE') {
          const refs = usedBy(sc.id);
          if (refs.length) return fail(res, 409, 'in_use', '脚本被 ' + refs.length + ' 个方案引用，先解除引用再删除', { used_by: refs });
          state.scripts = state.scripts.filter(function (x) { return x.id !== sc.id; });
          audit({ actor: 'web', action: 'script.delete', target: sc.id, detail: sc.name });
          persist();
          return sendJson(res, 200, { ok: true });
        }
        return fail(res, 405, 'method_not_allowed', '仅支持 GET/PUT/DELETE');
      }

      /* 校验：/scripts/:id/validate */
      if (seg[2] === 'validate' && method === 'GET') {
        return sendJson(res, 200, Object.assign({ ok: true, script_id: sc.id, stage: sc.stage, runtime: (dialog.STAGES[sc.stage] || {}).runtime }, dialog.validateScript(sc)));
      }
      /* 校验画布快照（POST）：保存前校验「未保存的画布内容」而非服务端旧版本（画布专项审核 P0-②）。
         body.nodes 等字段可选——传入时以快照为准合成临时脚本对象做校验，不落库。
         readJson 返回 { data } 包一层，字段在 r.data 上。 */
      if (seg[2] === 'validate' && method === 'POST') {
        return readJson(req).then(function (r) {
          if (r.error) return fail(res, 400, 'bad_json', r.error);
          const body = r.data || {};
          const snap = Object.assign({}, sc);
          if (Array.isArray(body.nodes)) snap.nodes = body.nodes;
          if (Array.isArray(body.variables)) snap.variables = body.variables;
          if (Array.isArray(body.handlers)) snap.handlers = body.handlers;
          return sendJson(res, 200, Object.assign({ ok: true, script_id: sc.id, stage: snap.stage, runtime: (dialog.STAGES[snap.stage] || {}).runtime, snapshot: true }, dialog.validateScript(snap)));
        });
      }

      /* 开新会话：/scripts/:id/sessions {customer_xid, persona, mode} */
      if (seg[2] === 'sessions' && method === 'POST') {
        return readJson(req).then(function (r) {
          if (r.error) return fail(res, 400, 'bad_json', r.error);
          const b = r.data || {};
          // 硬校验：外呼必须绑定真实客户。没有客户身份时，
          // 话术里的画像变量（${name}/${amt30}）只能渲染成占位符，模型却会
          // 编造「您本月消费比上月少」这类无依据断言（事实性幻觉 + 合规风险）。
          // 前端下拉为空时按钮禁用是第一道防线，这里是后端兜底闸。
          if (!b.customer_xid) return fail(res, 422, 'customer_required', '外呼客户必选：未绑定客户时画像变量无值，话术会退化为无依据断言，禁止启动模拟会话');
          const customer = findCustomer(b.customer_xid);
          if (!customer) return fail(res, 404, 'customer_not_found', '客户不存在：' + b.customer_xid);
          const ses = dialog.createSession(sc, customer, { persona: b.persona || 'cooperative', mode: b.mode || 'auto' });
          const opening = dialog.openSession(sc, ses);
          state.sessions.push(ses);
          if (state.sessions.length > 60) state.sessions = state.sessions.slice(-60);
          audit({ actor: 'web', action: 'script.session', target: sc.id, detail: '模拟会话 ' + ses.id + ' · persona ' + ses.persona });
          persist();
          return sendJson(res, 200, { ok: true, session_id: ses.id, opening: opening.text, session: { id: ses.id, status: ses.status, turn: ses.turn, history: ses.history, trace: ses.trace, vars: ses.vars || {}, slots: ses.slots || {} }, script: { id: sc.id, name: sc.name, stage: sc.stage } });
        });
      }

      return fail(res, 404, 'not_found', '未知脚本操作');
    }
  }

  /* ────────── 演示数据复位（仅模拟数据源可用） ────────── */
  if (seg[0] === 'demo' && seg[1] === 'reset') {
    if (method !== 'POST') return fail(res, 405, 'method_not_allowed', '仅支持 POST');
    const before = {
      campaigns: state.campaigns.length, tasks: state.tasks.length,
      executions: state.executions.length, outcomes: state.outcomes.length,
      lead_status: Object.keys(state.lead_status).length,
      scripts_custom: Math.max(0, state.scripts.length - dialog.seedScripts().length),
      sessions: state.sessions.length,
    };
    state.campaigns = [];
    state.tasks = [];
    state.executions = [];
    state.outcomes = [];
    state.lead_status = {};
    // 触达设计：脚本恢复到三阶段种子，模拟会话清空
    state.scripts = dialog.seedScripts();
    state.sessions = [];
    // 营销资产恢复种子
    state.assets = seedAssets();
    // 恢复线索池到种子规模：自己圈人生成的线索属于上一轮演示，必须一起清掉，否则会越积越多
    if (engine.LEADS.length > engine.BASE_LEAD_COUNT) engine.LEADS.splice(engine.BASE_LEAD_COUNT);
    // 引擎数据在内存里，必须同步复位，否则「线索池」仍显示上一轮的已触达/已转化，
    // 新方案拆单会因全部在途而被拦光。
    engine.LEADS.forEach(function (l) {
      l.status = '待指认';
      l.contacted = false;
      l.responded = false;
      l.converted = false;
    });
    audit({
      actor: 'web', action: 'demo.reset', target: 'state',
      detail: '清空 ' + before.campaigns + ' 个方案 / ' + before.tasks + ' 个任务单 / '
        + before.outcomes + ' 条结果，线索状态复位 ' + engine.LEADS.length + ' 条',
    });
    persist();
    // 复位后预置一条跑通的演示链路：概览页开箱即有真实业务数据（漏斗各层有数、趋势、转化），
    // 而不是「240 线索 + 四个 0」的空漏斗。全部走 createCampaign/transitionTask/addReceipts/
    // recordOutcomes 真实函数，与用户手工操作产生的数据完全同构、可继续在页面里操作。
    const demo = seedDemoPipeline();
    if (demo && demo.ok) {
      audit({
        actor: 'system', action: 'demo.seed', target: 'state',
        detail: '预置演示链路：方案 ' + (demo.campaign || '-') + ' · 任务单 ' + (demo.tasks || 0)
          + ' · 回执 ' + (demo.receipts || 0) + ' · 转化 ' + (demo.outcomes || 0),
      });
    } else if (demo && demo.error) {
      audit({ actor: 'system', action: 'demo.seed', target: 'state', detail: '预置失败：' + demo.error });
    }
    return sendJson(res, 200, { ok: true, cleared: before, leads_reset: engine.LEADS.length, demo: demo || null });
  }

  /* ────────── Agent ────────── */
  if (seg[0] === 'agents') {
    if (method === 'GET' && seg.length === 1) {
      return sendJson(res, 200, Object.assign({ ok: true }, agents.catalog()));
    }
    if (method === 'POST' && seg[1] === 'explain-lead') {
      return readJson(req).then(function (r) {
        if (r.error) return fail(res, 400, 'bad_json', r.error);
        const body = r.data || {};
        const lead = engine.leadById(body.lead_id);
        if (!lead) return fail(res, 404, 'not_found', '线索不存在：' + body.lead_id);
        return agents.explainLead(lead, engine.evidenceOf(lead), engine.gatesOf(lead)).then(function (out) {
          audit({
            actor: 'agent', action: 'agent.explain', target: lead.id,
            detail: (out.degraded ? ('降级：' + out.degraded_reason) : '模型生成')
              + ' · ' + out.audit.elapsed_ms + 'ms · model=' + (out.audit.model || '-')
              + (out.audit.violations && out.audit.violations.length ? (' · 违规 ' + out.audit.violations.join(',')) : ''),
          });
          persist();
          return sendJson(res, 200, {
            ok: true, lead_id: lead.id, output: out.output, facts: out.facts,
            source: out.source, degraded: out.degraded, degraded_reason: out.degraded_reason || null,
            audit: out.audit,
          });
        });
      });
    }
    if (method === 'POST' && seg[1] === 'review-call') {
      return readJson(req).then(function (r) {
        if (r.error) return fail(res, 400, 'bad_json', r.error);
        const body = r.data || {};
        return agents.reviewCall(body.transcript, body.meta).then(function (out) {
          audit({
            actor: 'agent', action: 'agent.call-review', target: body.meta && body.meta.task_id || 'call',
            detail: out.ok ? ('质检完成，违规 ' + ((out.result && out.result.violations) || []).length + ' 项') : ('未产出结论：' + out.code),
          });
          persist();
          return sendJson(res, out.ok ? 200 : 422, out);
        });
      });
    }
    return fail(res, 404, 'not_found', '未匹配的 Agent 接口：' + p);
  }

  return fail(res, 404, 'not_found', '未匹配的接口：' + method + ' ' + p);
}

/**
 * server.js 的分发契约：返回 true 表示已处理（含已写响应），false 表示不归本模块管。
 */
function handleSmartMarketingApi(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch (_) {
    return false;
  }
  const p = url.pathname;
  if (p !== PREFIX && p.indexOf(PREFIX + '/') !== 0) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Allow': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return true;
  }

  try {
    handle(req, res);
  } catch (e) {
    console.error('[smart-marketing] 未捕获异常：', e);
    if (!res.headersSent) fail(res, 500, 'internal_error', e.message);
  }
  return true;
}

/* ── 组合客群的来源解析：引擎不持有业务状态，由这里注入 ── */
engine.setDefinitionResolver(function (id) {
  return (state.definitions || []).find(function (d) { return d.id === id; }) || null;
});

/* ── 客群自动刷新调度 ──
   refresh_mode=auto 的客群定时重算规模。生产是每日 04:00 批调度；
   演示环境压成 5 分钟一轮，机制相同（重算 → 更新 last_calc_at → 落盘）。
   manual 的客群跳过，只在业务点「刷新」时算。 */
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const autoRefreshTimer = setInterval(function () {
  try {
    let n = 0;
    (state.definitions || []).forEach(function (d) {
      const lc = d.lifecycle || {};
      if (lc.refresh_mode === 'manual') return;
      if (!defKind(d)) return;
      const st = defStats(d);
      if (!st.kind) return;
      d.lifecycle = Object.assign({}, d.lifecycle, { last_calc_at: new Date().toISOString() });
      n++;
    });
    if (n) persist();
  } catch (e) {
    console.warn('[smart-marketing] 客群自动刷新失败：', e.message);
  }
}, AUTO_REFRESH_MS);
if (autoRefreshTimer.unref) autoRefreshTimer.unref();

module.exports = { handleSmartMarketingApi, PREFIX };
