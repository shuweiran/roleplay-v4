/**
 * probe_scene.mjs — 快速探测 ScenePage 状态（P-0802-L 调试用）
 * 用法: node probe_scene.mjs <site>
 */
import { spawn } from 'node:child_process';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9223;
const SITE = process.argv[2] || 'http://127.0.0.1:8099';

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
    if (r.result?.exceptionDetails) return { __error: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
    return r.result?.result?.value;
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const child = spawn(EDGE, [
    '--headless=new', '--no-proxy-server', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1440,900',
    '--user-data-dir=C:\\Temp\\edge-cdp-profile-probe-' + Date.now(),
    'about:blank',
  ], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 30; i++) {
    try { const res = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (res.ok) break; } catch {}
    await sleep(500);
  }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const errors = [];
  cdp.ws.addEventListener('message', (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push('log: ' + m.params.entry.text.slice(0, 300));
    } catch {}
  });

  await cdp.send('Page.navigate', { url: SITE + '/' });
  await sleep(2500);
  await cdp.eval(`localStorage.setItem('token','test-token-abc123'); localStorage.setItem('userId','玩家'); location.reload(); true`);
  await sleep(2500);

  // home → 一般模式
  await cdp.eval(`(() => { const c = document.querySelector('.experience-card'); if (c) c.click(); return !!c; })()`);
  await sleep(500);
  const startBtn = await cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').includes('进入一般')); return b ? b.textContent.trim() : null; })()`);
  console.log('start 按钮:', startBtn);
  if (startBtn) { await cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').includes('进入一般')); b.click(); return true; })()`); }
  await sleep(1500);

  const state1 = await cdp.eval(`({
    view: (document.querySelector('.setup-page') ? 'scene' : document.querySelector('.experience-card') ? 'home' : 'other'),
    rootChildren: document.getElementById('root')?.children.length ?? -1,
    hasPhaserView: !!document.querySelector('.phaser-sim-view'),
    itemCards: document.querySelectorAll('.item-card').length,
    charCards: document.querySelectorAll('.char-card').length,
    buttons2d: [...document.querySelectorAll('button')].filter(b => (b.textContent||'').includes('2D')).map(b => b.textContent.trim()).slice(0,5),
    bodyText: (document.body.textContent || '').slice(0, 120).replace(/\\n/g, ' '),
  })`);
  console.log('scene 状态:', JSON.stringify(state1));

  // 选场景 + 角色
  await cdp.eval(`(() => { const cards = [...document.querySelectorAll('.item-card')]; if (cards[0]) cards[0].click(); return cards.length; })()`);
  await sleep(400);
  await cdp.eval(`(() => {
    const cs = [...document.querySelectorAll('.char-card')];
    const norm = cs.filter(c => !c.querySelector('.me-char-content'));
    let n = 0;
    for (const c of norm) { if (n >= 2) break; if (!c.classList.contains('selected')) { c.click(); n++; } }
    return n;
  })()`);
  await sleep(600);
  const state2 = await cdp.eval(`({
    buttons2d: [...document.querySelectorAll('button')].filter(b => (b.textContent||'').includes('2D')).map(b => b.textContent.trim()).slice(0,5),
    startBtnText: [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('进入'))?.textContent?.trim() || '',
  })`);
  console.log('选角后:', JSON.stringify(state2));

  console.log('console errors:', errors.length ? errors : 'none');
  child.kill();
  process.exit(0);
}
main().catch(e => { console.error('probe failed', e); process.exit(1); });
