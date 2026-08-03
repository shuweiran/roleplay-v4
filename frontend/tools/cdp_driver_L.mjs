/**
 * cdp_driver.mjs — 极简 CDP 驱动（Node 内置 WebSocket，无依赖）
 * 用法: node cdp_driver.mjs <scenario> [outDir]
 *   场景: scene2d   = ScenePage 2D 全屏模式遮挡实测
 *         chat2d    = ChatPage 内嵌 2D 面板遮挡实测（剧本杀）
 *         help
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9222;
const BASE = `http://127.0.0.1:${PORT}`;   // CDP 调试端口
const SITE = process.env.TEST_BASE || 'http://localhost:8000';  // 被测前端站点（默认 8000；本地代理验证时指 8099）
const VH = parseInt(process.env.TEST_VH || '900', 10);

// ── 简单 CDP 客户端 ──
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)(m); c.pending.delete(m.id); }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    if (r.result?.data) { writeFileSync(file, Buffer.from(r.result.data, 'base64')); console.log('[shot]', file); }
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function launch() {
  const args = [
    '--headless=new', '--no-proxy-server', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1440,' + VH,
    '--user-data-dir=C:\\Temp\\edge-cdp-profile-' + Date.now(),
    'about:blank',
  ];
  const child = spawn(EDGE, args, { stdio: 'ignore', detached: true });
  // 等调试端口就绪
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/json/version`);
      if (res.ok) break;
    } catch { /* retry */ }
    await sleep(500);
  }
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 强制一致视口（不受遗留窗口/缩放影响）
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: VH, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setVisibleSize', { width: 1440, height: VH });
  return { child, cdp };
}

async function nav(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await sleep(2500);
}

async function login(cdp) {
  // 后端 invite-enabled=false（verify 403），checkLogin 只认 localStorage token
  await cdp.eval(`localStorage.setItem('token','test-token-abc123'); localStorage.setItem('userId','玩家'); location.reload(); true`);
  await sleep(2500);
}

/** 按文本找按钮并点击 */
async function clickByText(cdp, text, tag = 'button') {
  const ok = await cdp.eval(`(() => {
    const els = [...document.querySelectorAll('${tag}')];
    const el = els.find(e => (e.textContent||'').trim().includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click(); return true;
  })()`);
  if (!ok) console.warn('[clickByText] 未找到:', text);
  await sleep(600);
  return ok;
}

/** 页面遮挡几何审计：找出所有 fixed/absolute/zIndex 元素中与目标选择器矩形重叠且在上层的 */
async function auditOverlay(cdp, targetSel, label) {
  const report = await cdp.eval(`(() => {
    const t = document.querySelector(${JSON.stringify(targetSel)});
    if (!t) return { target: null, overlays: [] };
    const tr = t.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight;
    const out = [];
    const all = [...document.querySelectorAll('body *')];
    for (const el of all) {
      const cs = getComputedStyle(el);
      const pos = cs.position;
      if (!['fixed','absolute','sticky'].includes(pos)) continue;
      const z = parseInt(cs.zIndex || '0', 10);
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // 与目标矩形重叠（含边缘）
      const ox = Math.max(0, Math.min(r.right, tr.right) - Math.max(r.left, tr.left));
      const oy = Math.max(0, Math.min(r.bottom, tr.bottom) - Math.max(r.top, tr.top));
      if (ox < 4 || oy < 4) continue;
      const overlapPct = (ox * oy / (tr.width * tr.height)) * 100;
      // 中心点 elementFromPoint 判定是否真正盖在目标上
      const cx = Math.max(r.left + 2, Math.min(r.right - 2, tr.left + tr.width / 2));
      const cy = Math.max(r.top + 2, Math.min(r.bottom - 2, tr.top + tr.height / 2));
      const topEl = document.elementFromPoint(cx, cy);
      let covers = false;
      if (topEl) {
        let p = topEl;
        while (p) { if (p === el || (el.contains(p) && p !== t && !t.contains(el))) { covers = true; break; } p = p.parentElement; }
      }
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 60) : '',
        pos, z, overlapPct: +overlapPct.toFixed(1),
        rect: { l: +r.left.toFixed(0), t: +r.top.toFixed(0), w: +r.width.toFixed(0), h: +r.height.toFixed(0) },
        covers,
      });
    }
    out.sort((a, b) => b.overlapPct - a.overlapPct);
    return {
      target: { cls: t.className?.slice?.(0,60) || t.tagName, rect: { l: +tr.left.toFixed(0), t: +tr.top.toFixed(0), w: +tr.width.toFixed(0), h: +tr.height.toFixed(0) } },
      overlays: out.filter(o => o.covers || o.overlapPct > 2).slice(0, 15),
    };
  })()`);
  console.log(`\n===== 遮挡审计 [${label}] 目标=${targetSel} =====`);
  if (!report.target) { console.log('目标元素不存在'); return; }
  console.log('目标 rect:', JSON.stringify(report.target.rect));
  if (report.overlays.length === 0) console.log('✅ 未发现 fixed/absolute 元素覆盖目标');
  for (const o of report.overlays) {
    console.log(`  ${o.covers ? '⚠️覆盖' : ' 重叠'} <${o.tag} class="${o.cls}"> pos=${o.pos} z=${o.z} overlap=${o.overlapPct}% rect=${JSON.stringify(o.rect)}`);
  }
  return report;
}

/** 截图当前视口并附几何摘要 */
async function snap(cdp, file, extraEval) {
  await cdp.shot(file);
  if (extraEval) {
    const s = await cdp.eval(extraEval);
    console.log(s);
  }
}

// ═══════════ 场景 A：ScenePage 2D 全屏模式 ═══════════
async function scenarioScene2d(outDir) {
  const { child, cdp } = await launch();
  try {
    await nav(cdp, SITE + '/');
    await login(cdp);
    await snap(cdp, `${outDir}/a0_home.png`);
    // 进入场景页：选「一般模式」卡 → 点「进入一般模式」
    await cdp.eval(`(() => { const c = document.querySelector('.experience-card'); if (c) c.click(); return !!c; })()`);
    await sleep(500);
    await clickByText(cdp, '进入一般');
    await sleep(1200);
    await snap(cdp, `${outDir}/a1_scene.png`);
    // 选择场景（第一个场景卡片）与 2 个角色
    await cdp.eval(`(() => {
      const cards = [...document.querySelectorAll('.item-card')];
      if (cards[0]) cards[0].click();
      return cards.length;
    })()`);
    await sleep(400);
    await cdp.eval(`(() => {
      const cs = [...document.querySelectorAll('.char-card')];
      // 跳过 me 卡与已选，点前两个普通角色
      const norm = cs.filter(c => !c.querySelector('.me-char-content'));
      let n = 0;
      for (const c of norm) { if (n >= 2) break; if (!c.classList.contains('selected')) { c.click(); n++; } }
      return n;
    })()`);
    await sleep(600);
    // 进入 2D
    await clickByText(cdp, '2D 模拟');
    await sleep(4500); // 等 Phaser 挂载 + SSE
    await snap(cdp, `${outDir}/a2_2d_fullscreen.png`);
    const info = await cdp.eval(`(() => {
      const v = document.querySelector('.phaser-sim-view');
      const host = document.querySelector('.phaser-sim-view > div:nth-child(4) > div > div');
      const canvas = document.querySelector('.phaser-sim-view canvas');
      const body = document.body;
      const setup = document.querySelector('.setup-page');
      const panel = document.querySelector('.setup-page > .panel');
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l:+b.left.toFixed(0), t:+b.top.toFixed(0), r:+b.right.toFixed(0), b:+b.bottom.toFixed(0), w:+b.width.toFixed(0), h:+b.height.toFixed(0) }; };
      // 页面滚动情况
      const over = document.documentElement.scrollHeight - innerHeight;
      return {
        viewport: { w: innerWidth, h: innerHeight },
        bodyScrollH: document.documentElement.scrollHeight,
        overflowY: over,
        phaserView: r(v), host: r(host), canvas: r(canvas),
        setupPage: r(setup), panel: r(panel),
        headerText: (document.querySelector('.topbar')?.textContent || '').slice(0, 40),
        hasTopbar: !!document.querySelector('.topbar'),
      };
    })()`);
    console.log('[几何]', JSON.stringify(info, null, 1));
    await auditOverlay(cdp, '.phaser-sim-view', 'ScenePage 2D 全屏');
    // 是否还有场景设置 UI 残留（角色卡/场景卡）
    const leftover = await cdp.eval(`({
      charCards: document.querySelectorAll('.char-card').length,
      itemCards: document.querySelectorAll('.item-card').length,
      rulesPanel: !!document.querySelector('.ww-room-section'),
      status: (document.querySelector('.status')||{}).textContent || '',
    })`);
    console.log('[残留]', JSON.stringify(leftover));
  } finally {
    child.kill();
    try { (await fetch(`${BASE}/json/version`)).ok; } catch {}
    await sleep(300);
  }
}

// ═══════════ 场景 B：ChatPage 内嵌 2D 面板（剧本杀） ═══════════
async function scenarioChat2d(outDir) {
  const { child, cdp } = await launch();
  const waitFor = async (fnExpr, timeoutMs = 60000, label = '') => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = await cdp.eval(fnExpr);
      if (hit) return true;
      await sleep(1500);
    }
    console.warn('[waitFor 超时]', label || fnExpr.slice(0, 60));
    return false;
  };
  try {
    await nav(cdp, SITE + '/');
    await login(cdp);
    await snap(cdp, `${outDir}/b0_home.png`);
    // 进场景页（规则模式）：选「狼人杀模式」卡 → 点「进入狼人杀」→ ScenePage rules 模式
    await cdp.eval(`(() => { const cs = document.querySelectorAll('.experience-card'); if (cs[1]) cs[1].click(); return cs.length; })()`);
    await sleep(500);
    await clickByText(cdp, '进入狼人');
    await sleep(1200);
    await snap(cdp, `${outDir}/b0b_scene_rules.png`);
    // 剧本杀 Tab
    await clickByText(cdp, '剧本杀');
    await sleep(800);
    await snap(cdp, `${outDir}/b1_script_tab.png`);
    // 选 2 个角色（剧本杀 Tab 不自动选角）
    const sel = await cdp.eval(`(() => {
      const cs = [...document.querySelectorAll('.char-card')];
      const norm = cs.filter(c => !c.querySelector('.me-char-content'));
      let n = 0;
      for (const c of norm) { if (n >= 2) break; if (!c.classList.contains('selected')) { c.click(); n++; } }
      return n;
    })()`);
    console.log('[选中角色]', sel);
    await sleep(500);
    // 输入剧本 prompt
    await cdp.eval(`(() => {
      const ta = document.querySelector('textarea');
      if (ta) { const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, '民国悬疑命案，5个角色各有秘密'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
      return !!ta;
    })()`);
    await sleep(300);
    await clickByText(cdp, 'AI 生成剧本');
    console.log('[生成剧本] 已点击（一步式：成功后自动进对局）...');
    const inGame = await waitFor(`document.querySelector('.chat-main') !== null && document.querySelector('.panel-werewolf') !== null`, 240000, '剧本生成+进入对局');
    if (!inGame) {
      // 超时诊断：dump 当前 DOM 状态（视图/按钮/状态文案/错误）
      const diag = await cdp.eval(`(() => {
        const btns = [...document.querySelectorAll('button')].map(b => (b.textContent||'').trim()).filter(t => t && t.length < 30).slice(0, 25);
        const statusEls = [...document.querySelectorAll('.status, .status-pill, .error, .loading-status-text')].map(e => (e.textContent||'').trim().slice(0, 60)).slice(0, 8);
        return { view: !!document.querySelector('.experience-card') ? 'home' : !!document.querySelector('.setup-page') ? 'scene' : !!document.querySelector('.chat-main') ? 'chat' : 'other',
          btns, statusEls, bodyText: (document.body.textContent||'').replace(/\s+/g,' ').slice(0, 200) };
      })()`);
      console.log('[生成剧本超时诊断]', JSON.stringify(diag));
    }
    await sleep(3000);
    await snap(cdp, `${outDir}/b3_script_chat.png`);
    // 工作区几何（验证 script 模式 grid 布局）
    const wsGeo = await cdp.eval(`(() => {
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l:+b.left.toFixed(0), t:+b.top.toFixed(0), r:+b.right.toFixed(0), b:+b.bottom.toFixed(0), w:+b.width.toFixed(0), h:+b.height.toFixed(0) }; };
      const ws = document.querySelector('.workspace');
      return { ws: r(ws), left: r(document.querySelector('.panel-left')), ww: r(document.querySelector('.panel-werewolf')), main: r(document.querySelector('.chat-main')), cols: ws ? getComputedStyle(ws).gridTemplateColumns : '' };
    })()`);
    console.log('[script 模式 workspace 几何]', JSON.stringify(wsGeo));
    // 结束搜证 → 进入讨论（启动 2D 模拟）
    await clickByText(cdp, '结束搜证');
    console.log('[结束搜证] 已点击');
    // P-0802-L：前端 scriptStartDiscussion 硬编码空 session_id（既有 Bug，任务指定只记录不改，见报告）——
    // P-0802-J per-game 隔离后空 session 定位不到对局，讨论不启动。验证层直接以真实 session_id 调后端推进（非产品路径）。
    const sid = await cdp.eval(`(async () => {
      const r = await fetch('/api/script/status?player=');
      const st = await r.json();
      return st.session_id || '';
    })()`);
    console.log('[真实 session_id]', sid);
    if (sid) {
      const inj = await cdp.eval(`(async () => {
        const r = await fetch('/api/script/start_discussion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: ${JSON.stringify('__SID__')} }) });
        return r.status;
      })()`.replace('"__SID__"', JSON.stringify(sid)));
      console.log('[注入 start_discussion] HTTP', inj);
    }
    await waitFor(`!![...document.querySelectorAll('button')].find(b=>(b.textContent||'').includes('查看 2D 模拟'))`, 60000, '讨论启动/2D 按钮出现');
    await sleep(1500);
    await clickByText(cdp, '查看 2D 模拟');
    console.log('[查看 2D 模拟] 已点击');
    await waitFor(`document.querySelector('.phaser-sim-view') !== null`, 30000, '2D 面板挂载');
    await sleep(4500);
    await snap(cdp, `${outDir}/b4_chat_2d_panel.png`);
    const info = await cdp.eval(`(() => {
      const v = document.querySelector('.phaser-sim-view');
      const canvas = document.querySelector('.phaser-sim-view canvas');
      const main = document.querySelector('.chat-main');
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l:+b.left.toFixed(0), t:+b.top.toFixed(0), r:+b.right.toFixed(0), b:+b.bottom.toFixed(0), w:+b.width.toFixed(0), h:+b.height.toFixed(0) }; };
      return { viewport:{w:innerWidth,h:innerHeight}, main: r(main), phaserView: r(v), canvas: r(canvas), bodyScrollH: document.documentElement.scrollHeight, overflowY: document.documentElement.scrollHeight - innerHeight };
    })()`);
    console.log('[几何]', JSON.stringify(info, null, 1));
    await auditOverlay(cdp, '.phaser-sim-view', 'ChatPage 内嵌 2D');
    const mainKids = await cdp.eval(`(() => {
      const m = document.querySelector('.chat-main');
      if (!m) return [];
      return [...m.children].map(c => { const b = c.getBoundingClientRect(); return { cls: (c.className||'').slice(0,40)||c.tagName, l:+b.left.toFixed(0), t:+b.top.toFixed(0), w:+b.width.toFixed(0), h:+b.height.toFixed(0) }; });
    })()`);
    console.log('[chat-main 子元素]', JSON.stringify(mainKids));
  } finally {
    child.kill();
    await sleep(300);
  }
}

const scenario = process.argv[2] || 'help';
const outDir = process.argv[3] || 'C:\\Temp\\cdp2d';
mkdirSync(outDir, { recursive: true });
console.log('输出目录:', outDir, '场景:', scenario);
if (scenario === 'scene2d') await scenarioScene2d(outDir);
else if (scenario === 'chat2d') await scenarioChat2d(outDir);
else {
  console.log('usage: node cdp_driver.mjs <scene2d|chat2d> [outDir]');
}
console.log('DONE');
process.exit(0);
