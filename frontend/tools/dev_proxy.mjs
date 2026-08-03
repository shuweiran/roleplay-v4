/**
 * dev_proxy.mjs — P-0802-L 零风险实测代理
 * 用途：8000 后端从 jar 内提供 static（新前端产物需打包重启才上线），
 *      本代理在 8099 提供 frontend/dist 静态 + /api/* 与 /sse 转发 8000，
 *      使 Edge headless 可实测新前端产物而无需触碰运行中的 8000 实例。
 * 用法: node dev_proxy.mjs [port] [upstream]
 *   默认: port=8099  upstream=http://127.0.0.1:8000
 * 注意: 仅测试工具，不入生产；测试完可保留供后续批次复用。
 */
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = parseInt(process.argv[2] || '8099', 10);
const UPSTREAM = process.argv[3] || 'http://127.0.0.1:8000';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // API/SSE → 8000（流式透传，SSE 长连接不缓冲）
  if (p.startsWith('/api/')) {
    const fwd = { ...req.headers, host: new URL(UPSTREAM).host };
    // 后端 CORS 过滤器只放行白名单 Origin（localhost:8000 等）；本地代理验证场景浏览器会带
    // Origin: http://127.0.0.1:8099 → 403 Invalid CORS request。剥离 Origin/Referer 使请求
    // 视为同源/无来源（与 curl 直接请求 8000 行为一致），仅测试工具行为。
    delete fwd.origin;
    delete fwd.referer;
    const up = http.request(
      UPSTREAM + p + url.search,
      { method: req.method, headers: fwd },
      (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      }
    );
    up.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('proxy error: ' + e.message); });
    req.pipe(up);
    return;
  }

  // 静态（dist）
  let file = path.join(DIST, p === '/' ? 'index.html' : p);
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`[dev_proxy] http://localhost:${PORT} -> ${UPSTREAM}  (static: ${DIST})`);
});
