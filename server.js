'use strict';

/**
 * 最小宿主服务 —— 让工作台脱离 AI Harbor 门户独立运行。
 *
 * 这个文件是为本仓库新写的运行壳，不属于原平台代码。它只做三件事：
 *   1. 解析 .env（不引入 dotenv 依赖）
 *   2. 把 /api/smart-marketing/* 分发给 routes/smart-marketing-api.js
 *   3. 托管 tools/ 下的静态文件，目录请求回退 index.html
 *
 * 原平台 server.js 里的其它分区（知识图谱、投研、对公营销 Agent 等）不在此仓库内。
 * 没有实现 /api/ai-bank/v1/internal/model/* 模型网关：LLM 相关能力会自动降级为
 * 确定性模板；需要真实模型时请用 .env 里的 LLM_DIRECT_* 直连 OpenAI 兼容端点。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handleSmartMarketingApi } = require('./routes/smart-marketing-api.js');

/* ── .env：只填未定义的键，环境变量优先 ── */
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
})();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const TOOLS_ROOT = path.join(__dirname, 'tools');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function serveFile(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
    res.setHeader('Content-Type', MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
    // HTML 是开发态，改完要立刻看到；不允许启发式缓存旧页面。
    if (/\.html?$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
  } catch (_) {
    return sendJson(res, 400, { ok: false, error: 'BAD_REQUEST' });
  }
  // 原平台 server.js 的约定：预解析 pathname 挂到 req 上，供路由自检。
  req.pathname = pathname;

  if (handleSmartMarketingApi(req, res)) return;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(302, { Location: '/tools/smart-marketing/' });
    return res.end();
  }

  if (pathname.startsWith('/tools/')) {
    const rel = pathname.replace(/^\/tools\//, '');
    const abs = path.resolve(TOOLS_ROOT, path.normalize(rel));
    if (abs !== TOOLS_ROOT && !abs.startsWith(TOOLS_ROOT + path.sep)) {
      return sendJson(res, 403, { ok: false, error: 'FORBIDDEN' });
    }
    const target = fs.existsSync(abs) && fs.statSync(abs).isDirectory()
      ? path.join(abs, 'index.html')
      : abs;
    return serveFile(req, res, target);
  }

  return sendJson(res, 404, { ok: false, error: 'NOT_FOUND', path: pathname });
});

server.listen(PORT, HOST, () => {
  console.log(`智能营销工作台  http://${HOST}:${PORT}/`);
  console.log(`健康检查        http://${HOST}:${PORT}/api/smart-marketing/health`);
});
