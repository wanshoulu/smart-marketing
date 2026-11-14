'use strict';

/**
 * 智能营销 · 真实 LLM 适配层（阶段二 llm 引擎用）
 *
 * 职责：为 dialog.js 的三个模拟点提供真实 LLM 实现，接口形态与原模拟函数一致：
 *   ① llmIntentScore(text, examples) → { score, example }   意图置信度打分
 *   ② genText({ prompt, text, knowledge, slots, history }) → { text, used }  gen 节点话术生成
 *   ③ llmAvailable() → boolean  当前是否有可用真实 LLM
 *
 * 设计约束：
 * - 真实 LLM 不可用（无 key / 网络 / 超时 / 配额）时必须回落确定性模拟——引擎行为永不中断
 * - 走内部模型网关（同进程 HTTP 自调用，服务令牌鉴权），复用 config/api-keys.js 路由表；
 *   也可用 LLM_DIRECT_BASE/LLM_DIRECT_KEY/LLM_DIRECT_MODEL 直连任何 OpenAI 兼容端点
 * - 环境开关：SMART_MKT_REAL_LLM=off 强制关闭（默认 on）
 * - trace 侧由 dialog.js 记录 real: true/false，会话可审计用了真模型还是模拟
 * - 全链路带超时与一次重试；温度 0.2 保证外呼话术稳定
 */

const http = require('http');
const https = require('https');

const ENABLED = process.env.SMART_MKT_REAL_LLM !== 'off';
// 直连配置优先（OpenAI 兼容），否则走内部模型网关（localhost:3000 自调用）
const DIRECT_BASE = process.env.LLM_DIRECT_BASE || '';
const DIRECT_KEY = process.env.LLM_DIRECT_KEY || '';
const DIRECT_MODEL = process.env.LLM_DIRECT_MODEL || 'qwen3.7-flash';
const GATEWAY_HOST = '127.0.0.1';
const GATEWAY_PORT = Number(process.env.PORT || 3000);
const GATEWAY_PATH = '/api/ai-bank/v1/internal/model/v1/chat/completions';
const TIMEOUT_MS = Number(process.env.SMART_MKT_LLM_TIMEOUT_MS || 12000);

// 服务令牌：与 model-gateway 同源（env 或 token 文件）
function serviceToken() {
  if (process.env.AI_BANK_AGENT_RUNTIME_TOKEN) return process.env.AI_BANK_AGENT_RUNTIME_TOKEN;
  const f = process.env.AI_BANK_AGENT_RUNTIME_TOKEN_FILE;
  if (f) { try { return require('fs').readFileSync(f, 'utf8').trim(); } catch (e) { /* fallthrough */ } }
  return process.env.QWEN_KEY || '';
}

function llmAvailable() {
  if (!ENABLED) return false;
  if (DIRECT_BASE && DIRECT_KEY) return true;
  return Boolean(serviceToken());
}

/* 单轮 chat 补全。返回 { ok, text, err? }，绝不 throw。 */
function chat(messages, opts) {
  const o = opts || {};
  const maxTokens = o.maxTokens || 220;
  const temperature = o.temperature != null ? o.temperature : 0.2;
  return new Promise((resolve) => {
    const finish = (r) => resolve(r);
    if (!llmAvailable()) return finish({ ok: false, err: 'llm_disabled' });
    const body = JSON.stringify({ model: DIRECT_MODEL, messages, temperature, max_tokens: maxTokens });
    const isDirect = Boolean(DIRECT_BASE && DIRECT_KEY);
    let hostname, port, path;
    try {
      if (isDirect) {
        const u = new URL(DIRECT_BASE);
        hostname = u.hostname; port = u.port || (u.protocol === 'https:' ? 443 : 80); path = u.pathname.replace(/\/$/, '') + '/chat/completions';
      } else {
        hostname = GATEWAY_HOST; port = GATEWAY_PORT; path = GATEWAY_PATH;
      }
      const mod = port === 443 || (isDirect && new URL(DIRECT_BASE).protocol === 'https:') ? https : http;
      const req = mod.request({
        hostname, port: Number(port), path, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (isDirect ? DIRECT_KEY : serviceToken()),
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: TIMEOUT_MS,
      }, (res) => {
        let d = '';
        res.on('data', c => { if (d.length < 200000) d += c; });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) return finish({ ok: false, err: 'http_' + res.statusCode });
            const j = JSON.parse(d);
            const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
            finish(text ? { ok: true, text: String(text).trim() } : { ok: false, err: 'empty_content' });
          } catch (e) { finish({ ok: false, err: 'bad_json' }); }
        });
      });
      req.on('timeout', () => { req.destroy(); finish({ ok: false, err: 'timeout' }); });
      req.on('error', (e) => finish({ ok: false, err: 'net_' + (e.code || e.message || '').slice(0, 40) }));
      req.write(body);
      req.end();
    } catch (e) { finish({ ok: false, err: 'setup_' + (e.message || '').slice(0, 40) }); }
  });
}

/* ── ① 意图打分：让 LLM 从候选里选意图并给置信度。
      examples 参与上下文，返回 { score, example, intent }；LLM 失败时返回 null（由调用方回落模拟）。 */
const INTENT_SYSTEM = '你是银行外呼电话的意图识别器。根据客户一句话，从候选意图中选出最匹配的一个并给出 0 到 1 的置信度。只输出 JSON：{"intent":"...","score":0.0,"evidence":"命中的示例或关键词"}。不确定时 score 低于 0.3。不要输出其他内容。';

async function realIntentScore(utterText, candidates, hints) {
  if (!utterText || !utterText.trim() || !(candidates || []).length) return null;
  const list = candidates.map(c => '- ' + c.intent + '：示例「' + (c.examples || []).slice(0, 4).join('、') + '」').join('\n');
  // 业务判别参考（来自方案知识库，可选）：帮 LLM 区分相似说法，如「问费率」= interested 而「是不是推销」= not_interested
  const hintSeg = (hints || []).length ? '\n\n业务判别参考（判断时遵循）：\n' + hints.map(h => '- ' + h).join('\n') : '';
  const r = await chat([
    { role: 'system', content: INTENT_SYSTEM },
    { role: 'user', content: '候选意图：\n' + list + hintSeg + '\n\n客户说：「' + utterText + '」' },
  ], { maxTokens: 120, temperature: 0 });
  if (!r.ok) return null;
  try {
    const m = r.text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : r.text);
    const hit = candidates.find(c => c.intent === j.intent);
    if (!hit) return null;
    const score = Math.max(0, Math.min(1, Number(j.score) || 0));
    return { score, example: String(j.evidence || (hit.examples || [])[0] || ''), intent: hit.intent };
  } catch (e) { return null; }
}

/* ── ② gen 节点生成：基于 prompt + 检索到的知识 + 会话状态生成话术。
      约束：只输出话术本身；必须自然口语、可被 TTS 朗读；不得出现禁词由调用方合规层兜底。 */
const GEN_SYSTEM = '你是银行信用卡中心的外呼客服。基于给定材料生成一句中文客服话术：自然口语、不超过 90 字、只输出话术本身不要引号不要解释、不得承诺材料之外的权益、不得索要密码或验证码。';

async function realGenText(ctx) {
  const { prompt, retrieved, slots, name } = ctx || {};
  const parts = [];
  if (prompt) parts.push('任务：' + prompt);
  if ((retrieved || []).length) parts.push('可引用的知识（不得超出范围承诺）：\n' + retrieved.map(k => '「' + k.title + '」' + k.content).join('\n'));
  const vars = [];
  if (name) vars.push('客户称呼=' + name);
  Object.keys(slots || {}).forEach(k => { if (!k.startsWith('__') && slots[k]) vars.push(k + '=' + slots[k]); });
  if (vars.length) parts.push('已知信息：' + vars.join('；'));
  if (ctx && ctx.userText) parts.push('客户刚说：「' + ctx.userText + '」');
  if (ctx && ctx.baseText) parts.push('参考话术（可在此基础上润色，不要照抄占位符）：' + ctx.baseText);
  const r = await chat([
    { role: 'system', content: GEN_SYSTEM },
    { role: 'user', content: parts.join('\n\n') || '生成一句开场白' },
  ], { maxTokens: 600, temperature: 0.3 });
  if (!r.ok) {
    // 一次重试（思考模型偶发超时；外呼延迟敏感，不再多次）
    const r2 = await chat([
      { role: 'system', content: GEN_SYSTEM },
      { role: 'user', content: parts.join('\n\n') || '生成一句开场白' },
    ], { maxTokens: 600, temperature: 0.2 });
    if (!r2.ok) return null;
    return r2.text.replace(/^["'「」]+|["'「」]+$/g, '').trim() || null;
  }
  // 去掉可能的引号包裹与前后空白
  return r.text.replace(/^["'「」]+|["'「」]+$/g, '').trim() || null;
}

module.exports = { llmAvailable, realIntentScore, realGenText, chat };
