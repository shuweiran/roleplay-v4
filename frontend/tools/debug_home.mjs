// debug_home.mjs — 首页按钮/文本 dump
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9223;
const BASE = `http://127.0.0.1:${PORT}`;
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)(m); c.pending.delete(m.id); } };
    return c;
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve) => { this.pending.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error('eval failed'); return r.result?.result?.value; }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const child = spawn(EDGE, ['--headless=new','--no-proxy-server','--disable-gpu','--no-sandbox',`--remote-debugging-port=${PORT}`,'--window-size=1440,900','--user-data-dir=C:\\Temp\\edge-dbg', 'about:blank'], { stdio: 'ignore', detached: true });
for (let i = 0; i < 30; i++) { try { const res = await fetch(`${BASE}/json/version`); if (res.ok) break; } catch {} await sleep(500); }
const list = await (await fetch(`${BASE}/json/list`)).json();
const page = list.find(t => t.type === 'page');
const cdp = await CDP.connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
await cdp.send('Page.navigate', { url: 'http://localhost:8000/' });
await sleep(3000);
const btns = await cdp.eval(`[...document.querySelectorAll('button')].map(b => (b.textContent||'').trim()).filter(Boolean)`);
console.log('BUTTONS:', JSON.stringify(btns, null, 1));
const text = await cdp.eval(`document.body.innerText.slice(0, 600)`);
console.log('TEXT:', JSON.stringify(text));
await cdp.eval(`localStorage.setItem('token','test-token-abc123'); localStorage.setItem('userId','玩家'); location.reload(); true`);
await sleep(3000);
const btns2 = await cdp.eval(`[...document.querySelectorAll('button')].map(b => (b.textContent||'').trim()).filter(Boolean)`);
console.log('BUTTONS_AFTER_LOGIN:', JSON.stringify(btns2, null, 1));
const bodyTxt = await cdp.eval(`document.body.innerText.slice(0, 800)`);
console.log('BODY_AFTER_LOGIN:', JSON.stringify(bodyTxt));
child.kill();
process.exit(0);
