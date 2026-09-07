import { useEffect, useRef, useState } from 'react';
import { directorApi } from '../../api/director';

type ChatLine = { role: 'user' | 'assistant'; content: string };

function StateStrip({ state }: { state: any }) {
  if (!state) return null;
  return (
    <div style={{ display: 'grid', gap: 5, fontSize: 12, lineHeight: 1.55, padding: 10, borderRadius: 10, background: 'var(--color-bg-soft, rgba(255,255,255,.04))' }}>
      <div><strong>你的身份：</strong>{state.player?.name || '未指定'}</div>
      <div><strong>当前在场：</strong>{state.onstage?.join('、') || '无'}</div>
      <div><strong>当前离场：</strong>{state.offstage?.join('、') || '无'}</div>
      <div><strong>出场顺序：</strong>{state.entry_order?.join(' → ') || '未设置'}</div>
      {state.relationships?.length > 0 && <div><strong>关系：</strong>{state.relationships.join('；')}</div>}
    </div>
  );
}

export function DirectorPreflightPanel({
  preflightId,
  initialReply,
  initialState,
  onConfirmed,
  onBack,
}: {
  preflightId: string;
  initialReply: string;
  initialState: any;
  onConfirmed: (state: any) => void | Promise<void>;
  onBack: () => void;
}) {
  const [state, setState] = useState(initialState);
  const [lines, setLines] = useState<ChatLine[]>(initialReply ? [{ role: 'assistant', content: initialReply }] : []);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [lines]);

  const send = async (forced?: string) => {
    const text = String(forced ?? input).trim();
    if (!text || busy) return;
    setBusy(true); setErr('');
    setLines(v => [...v, { role: 'user', content: text }]);
    setInput('');
    try {
      const res = await directorApi.preflightChat(preflightId, text);
      setState(res.state);
      setLines(v => [...v, { role: 'assistant', content: res.reply || '已处理。' }]);
    } catch (e: any) {
      setErr(e?.message || '主控请求失败');
    } finally {
      setBusy(false);
    }
  };

  const confirmAndEnter = async () => {
    if (busy) return;
    if (state?.confirmed) {
      await onConfirmed(state);
      return;
    }
    setBusy(true); setErr('');
    setLines(v => [...v, { role: 'user', content: '确认进入场景' }]);
    try {
      const res = await directorApi.preflightChat(preflightId, '确认进入场景');
      setState(res.state);
      setLines(v => [...v, { role: 'assistant', content: res.reply || '进场配置已确认。' }]);
      if (res.state?.confirmed) await onConfirmed(res.state);
      else setErr('主控尚未确认进场配置，请继续补充。');
    } catch (e: any) {
      setErr(e?.message || '确认失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card2" style={{ maxWidth: 920, margin: '18px auto', padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <button className="btn2 btn2-ghost btn2-sm" onClick={onBack}>← 返回角色选择</button>
        <div>
          <div style={{ fontWeight: 800 }}>🎬 进场前 · 与主控确认</div>
          <div className="hint">主控先确认你的身份、关系、首场在场角色和出场顺序；确认后才创建真实场景。</div>
        </div>
      </div>

      <StateStrip state={state} />

      <div style={{ marginTop: 12, minHeight: 260, maxHeight: 430, overflowY: 'auto', display: 'grid', gap: 8, padding: 8 }}>
        {lines.map((m, i) => (
          <div key={i} style={{ justifySelf: m.role === 'user' ? 'end' : 'start', maxWidth: '82%' }}>
            <div style={{ fontSize: 11, opacity: .65, marginBottom: 3 }}>{m.role === 'user' ? '你' : '主控'}</div>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7, padding: '9px 11px', borderRadius: 10, background: m.role === 'user' ? 'rgba(120,120,255,.15)' : 'rgba(255,255,255,.06)' }}>
              {m.content}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {err && <div style={{ color: 'var(--color-danger)', fontSize: 12, margin: '6px 0' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input
          className="input2"
          style={{ flex: 1 }}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="例如：先让兔子和我在场，鲸鱼先离场；我说的时候再让鲸鱼进场。"
          disabled={busy}
        />
        <button className="btn2" disabled={busy || !input.trim()} onClick={() => void send()}>{busy ? '处理中…' : '发送'}</button>
        <button className="btn2" disabled={busy} onClick={() => void confirmAndEnter()}>
          {state?.confirmed ? '进入场景 →' : '确认并进入 →'}
        </button>
      </div>
    </div>
  );
}

export function DirectorRuntimePanel() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<any>(null);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const refresh = async () => {
    try {
      const res = await directorApi.runtimeState();
      setState(res.state);
    } catch { /* scene may not have a director binding */ }
  };

  useEffect(() => { if (open) void refresh(); }, [open]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true); setErr(''); setInput('');
    setLines(v => [...v, { role: 'user', content: text }]);
    try {
      const res = await directorApi.runtimeChat(text);
      setState(res.state);
      setLines(v => [...v, { role: 'assistant', content: res.reply || '已处理。' }]);
    } catch (e: any) {
      setErr(e?.message || '主控请求失败');
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button className="btn2 btn2-sm" style={{ position: 'fixed', right: 16, bottom: 18, zIndex: 2400 }} onClick={() => setOpen(true)}>
        🎬 主控
      </button>
    );
  }

  return (
    <div className="card2" style={{ position: 'fixed', right: 14, bottom: 14, zIndex: 2500, width: 'min(440px, calc(100vw - 28px))', maxHeight: '78vh', padding: 12, boxShadow: '0 16px 50px rgba(0,0,0,.35)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong>🎬 主控 Agent</strong>
        <button className="btn2 btn2-ghost btn2-sm" onClick={() => setOpen(false)}>✕</button>
      </div>
      <StateStrip state={state} />
      <div style={{ maxHeight: 300, overflowY: 'auto', display: 'grid', gap: 6, marginTop: 8 }}>
        {lines.map((m, i) => (
          <div key={i} style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.6, padding: 8, borderRadius: 8, background: m.role === 'user' ? 'rgba(120,120,255,.14)' : 'rgba(255,255,255,.05)' }}>
            <strong>{m.role === 'user' ? '你' : '主控'}：</strong>{m.content}
          </div>
        ))}
      </div>
      {err && <div style={{ color: 'var(--color-danger)', fontSize: 12, marginTop: 6 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input className="input2" style={{ flex: 1 }} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void send(); }} placeholder="对主控说：让鲸鱼离场…" />
        <button className="btn2 btn2-sm" disabled={busy || !input.trim()} onClick={() => void send()}>{busy ? '…' : '发送'}</button>
      </div>
    </div>
  );
}
