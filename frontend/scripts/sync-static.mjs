/**
 * sync-static.mjs — 构建产物 → static 同步脚本（阶段① P-0809-A）
 *
 * 背景（docs/ui-api-survey.md §4.3 发现③）：此前构建→static 同步为手工流程
 * （vite build 后手动拷 dist → static/assets、手工改 static/index.html 引用、残留旧产物）。
 * 本脚本脚本化该流程，并在结束时输出 SHA256 校验（dist ↔ static 一致）：
 *
 *   1. 读 dist/index.html，解析引用的产物文件名（/assets/index-*.js|css）
 *   2. dist/index.html → src/main/resources/static/index.html
 *   3. 引用的 dist/assets 产物 → static/assets/
 *   4. 清理 static/assets 下不再被引用的旧 index-*.js / index-*.css 产物（保留其他资源子目录）
 *   5. SHA256 校验 dist ↔ static 并打印
 *
 * 用法（frontend 目录下）：node scripts/sync-static.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(__dirname, '..');
const distDir = join(frontendDir, 'dist');
const staticDir = resolve(frontendDir, '../../src/main/resources/static');

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function fail(msg) {
  console.error(`[sync-static] ✗ ${msg}`);
  process.exit(1);
}

if (!existsSync(join(distDir, 'index.html'))) {
  fail(`dist 不存在或未构建（${distDir}）。请先执行 npm run build。`);
}
if (!existsSync(staticDir)) {
  fail(`static 目录不存在（${staticDir}）。请确认前端位于 roleplay-v4/frontend。`);
}

// 1. 解析 dist/index.html 引用的产物
const distHtml = readFileSync(join(distDir, 'index.html'), 'utf8');
const refs = [...distHtml.matchAll(/\/assets\/(index-[A-Za-z0-9_-]+\.(?:js|css))/g)].map(m => m[1]);
if (refs.length === 0) {
  fail('dist/index.html 中未找到 /assets/index-*.js|css 引用，中止（避免误清 static）。');
}
console.log(`[sync-static] 引用产物：${refs.join(', ')}`);

// 2. index.html 同步
writeFileSync(join(staticDir, 'index.html'), distHtml, 'utf8');
console.log('[sync-static] ✓ static/index.html 已更新');

// 3. 产物拷贝
for (const f of refs) {
  const src = join(distDir, 'assets', f);
  if (!existsSync(src)) fail(`dist 产物缺失：${src}`);
  copyFileSync(src, join(staticDir, 'assets', f));
  console.log(`[sync-static] ✓ assets/${f} 已拷贝`);
}

// 4. 清理旧产物（仅 index-*.js / index-*.css；保留 assets/ 子目录与其他资源）
const kept = new Set(refs);
let removed = 0;
const assetsDir = join(staticDir, 'assets');
if (existsSync(assetsDir)) {
  for (const f of readdirSync(assetsDir)) {
    if (!/^index-[A-Za-z0-9_-]+\.(js|css)$/.test(f)) continue; // 非构建产物不动
    if (kept.has(f)) continue;
    const p = join(assetsDir, f);
    unlinkSync(p);
    removed++;
    console.log(`[sync-static] 🗑 删除旧产物 assets/${f}`);
  }
}
console.log(`[sync-static] 清理旧产物 ${removed} 个`);

// 5. SHA256 校验 dist ↔ static
let allMatch = true;
for (const f of ['index.html', ...refs]) {
  const a = sha256(join(distDir, f === 'index.html' ? 'index.html' : 'assets', f === 'index.html' ? '' : f));
  const b = sha256(join(staticDir, f === 'index.html' ? 'index.html' : 'assets', f === 'index.html' ? '' : f));
  const ok = a === b;
  if (!ok) allMatch = false;
  console.log(`[sync-static] ${ok ? '✓' : '✗'} SHA256 ${f}: ${a.slice(0, 16)}...`);
}
if (allMatch) {
  console.log('[sync-static] ✅ dist ↔ static SHA256 全部一致，同步完成。');
} else {
  fail('SHA256 校验不一致！');
}
