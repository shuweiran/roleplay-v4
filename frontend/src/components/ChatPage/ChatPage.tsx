import { useEffect, useMemo, useRef, useState } from 'react';
import { HistoryPanel } from '../HistoryPanel/HistoryPanel';
import { useAppStore } from '../../store/appStore';
import { api } from '../../api/client';
import type { AppMessage, WerewolfPhase } from '../../types';
import { ScriptDmPanel } from '../ScriptDmPanel';
import { PhaserSimulationView } from '../../phaser/PhaserSimulationView';

// Voice recognition — uses local Whisper model via backend
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];

async function startVoice(setText: (t: string) => void) {
  try {
    // Request microphone
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Show recording state
    const micBtn = document.querySelector('.mic-btn') as HTMLElement;
    if (micBtn) { micBtn.style.background = '#ff5252'; micBtn.textContent = '\u23f3'; }
    
    // Record audio
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      if (micBtn) { micBtn.style.background = ''; micBtn.textContent = '\ud83c\udfa4'; }
      stream.getTracks().forEach(t => t.stop());
      
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      const formData = new FormData();
      formData.append('audio', audioBlob, 'voice.webm');
      
      try {
        const res = await fetch('/api/voice/transcribe', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.text) setText(data.text);
      } catch (err) {
        console.error('Transcription error:', err);
        alert('\u8bed\u97f3\u8bc6\u522b\u5931\u8d25');
      }
    };
    
    mediaRecorder.start();
    
    // Auto-stop after 10 seconds
    setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    }, 10000);
  } catch (err) {
    console.error('Mic error:', err);
    alert('\u8bf7\u5141\u8bb8\u9ea6\u514b\u98ce\u6743\u9650');
  }
}

const COLORS = ['#6ca8ff', '#49c16d', '#d6a33d', '#b58cff', '#4fd6c8', '#ff8fb3', '#f28b82', '#c7a4ff'];

function colorFor(name = '') {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function trackModeName(mode?: string) {
  if (mode === 'weak') return '弱链';
  if (mode === 'isolated') return '隔离';
  return '强链';
}

/* ── Werewolf helper utils ─────────────────────── */
/** Normalize backend phase names to frontend-compatible keys */
function normalizePhase(p: string): string {
  if (p === 'discussion') return 'day_discussion';
  if (p === 'voting') return 'day_vote';
  return p;
}

const PHASE_EMOJI: Record<string, string> = {
  night: '🌙',
  day_discussion: '☀️',
  day_vote: '🗳️',
  ended: '🏁',
  game_over: '🏁',
};
const PHASE_LABEL: Record<string, string> = {
  night: '夜',
  day_discussion: '白天讨论',
  day_vote: '投票',
  ended: '已结束',
  game_over: '游戏结束',
};
const ROLE_EMOJI: Record<string, string> = {
  '狼人': '🐺',
  '预言家': '🔮',
  '女巫': '🧪',
  '猎人': '🏹',
  '平民': '😴',
  '守卫': '🛡️',
  '白痴': '🤡',
  '长老': '👴',
  '骑士': '⚔️',
};

function getPhaseGuide(phase: WerewolfPhase, role: string): string {
  const p = normalizePhase(phase);
  if (p === 'night') {
    const guides: Record<string, string> = {
      '狼人': '🐺 夜间时段，请与队友讨论并确定击杀目标',
      '预言家': '🔮 夜间时段，请选择要查验的目标玩家',
      '女巫': '🧪 夜间时段，请选择是否使用解药或毒药',
      '猎人': '🏹 夜间时段，请闭眼等待天亮',
      '平民': '😴 夜间时段，请闭眼等待天亮',
      '守卫': '🛡️ 夜间时段，请选择要守护的目标玩家',
    };
    return guides[role] || '🌙 夜间时段，请闭眼等待';
  }
  if (p === 'day_discussion') {
    return '🗣️ 白天讨论时间，请发表你的看法和推理';
  }
  if (p === 'day_vote') {
    return '🗳️ 投票时间，请输入「我投XXX」进行投票';
  }
  return '';
}

function getLoadingText(phase: WerewolfPhase, role: string): string {
  const p = normalizePhase(phase);
  if (p === 'night') {
    const texts: Record<string, string> = {
      '狼人': '🐺 狼人在行动...',
      '预言家': '🔮 预言家在查验...',
      '女巫': '🧪 女巫在思考...',
    };
    return texts[role] || '🌙 夜间阶段进行中...';
  }
  if (p === 'day_discussion') return '☀️ 白天讨论中...';
  if (p === 'day_vote') return '🗳️ 投票统计中...';
  return '⏳ 运行中...';
}

function phaseClassName(phase: WerewolfPhase): string {
  const p = normalizePhase(phase);
  if (p === 'night') return 'phase-night';
  if (p === 'day_discussion') return 'phase-day';
  if (p === 'day_vote') return 'phase-vote';
  return '';
}

/* ── Werewolf Game State Panel ─────────────────── */
function WerewolfStatePanel({ phase, round, players, myRole }: {
  phase: WerewolfPhase;
  round: number;
  players: { name: string; role: string; alive: boolean; roleRevealed: boolean }[];
  myRole: string;
}) {
  const alive = players.filter(p => p.alive);
  const dead = players.filter(p => !p.alive);
  const p = normalizePhase(phase);
  const phaseEmoji = PHASE_EMOJI[p] || '🎮';

  return (
    <div className="ww-panel">
      {/* Header — current phase */}
      <div className="ww-panel-header">
        <span>{phaseEmoji}</span>
        <span>第 {round} {PHASE_LABEL[p] || '阶段'}</span>
      </div>

      {/* My role */}
      {myRole && (
        <div className="ww-my-role-box">
          <span>{ROLE_EMOJI[myRole] || '🎭'}</span>
          <span>{myRole}</span>
        </div>
      )}

      {/* Alive players */}
      <div className="ww-panel-section">
        <div className="ww-panel-section-title">🟢 存活 ({alive.length})</div>
        <div className="ww-player-list">
          {alive.length === 0 && <div className="muted" style={{ fontSize: 11, padding: '0 10px' }}>无</div>}
          {alive.map(p => (
            <div className="ww-player-item" key={p.name}>
              <span className="ww-dot alive" />
              <span className="ww-name">{p.name}</span>
              <span className="ww-role">{p.roleRevealed ? p.role : ''}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Dead players */}
      <div className="ww-panel-section">
        <div className="ww-panel-section-title">❌ 已出局 ({dead.length})</div>
        <div className="ww-player-list">
          {dead.length === 0 && <div className="muted" style={{ fontSize: 11, padding: '0 10px' }}>无</div>}
          {dead.map(p => (
            <div className="ww-player-item" key={p.name}>
              <span className="ww-dot dead" />
              <span className="ww-name dead">{p.name}</span>
              <span className={`ww-role ${p.roleRevealed ? 'revealed' : ''}`}>
                {p.roleRevealed ? p.role : '???'}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Round counter */}
      <div style={{ padding: '4px 10px', fontSize: 11, color: 'var(--text-3)' }}>
        轮次 #{round}
      </div>
    </div>
  );
}

/* ── Werewolf Action Panel（P-0802-F：夜间行动/讨论发言/投票/猎人开枪/审批）── */
/** 狼人杀行动面板：按阶段与我的身份渲染行动区，直调 werewolf API（后端 autoPlay 自动推进，真人只需提交己方行动）。 */
function WerewolfActionPanel() {
  const store = useAppStore();
  const [target, setTarget] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const player = store.currentPlayer;
  const p = normalizePhase(store.werewolfPhase);
  const role = store.werewolfMyRole;
  const alive = store.werewolfAlive;
  const aliveOthers = alive.filter(n => n !== player);
  const isEliminated = store.werewolfPlayers.some(pw => pw.name === player && !pw.alive);
  const isGameOver = store.werewolfPhase === 'game_over' || store.werewolfPhase === 'ended' || !!store.werewolfWinner;

  const toast = (t: string) => store.addSystemMsg(t);
  const afterAction = () => { setTarget(''); setBusy(false); };

  const act = async (action: string) => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await api.werewolfNightAction(player, action, target);
      toast(res?.result || `行动完成（${action} → ${target}）`);
    } catch (e: any) { toast('⚠️ ' + (e.message || '夜间行动失败')); }
    afterAction();
  };
  // P-0802-I (G1-2)：女巫获知被刀者后直接救被刀者（无需选目标）/ 明确不使用解药 / 明确不使用毒药
  const saveWitchVictim = async () => {
    const victim = store.werewolfWitchVictim;
    if (!victim) return;
    setBusy(true);
    try {
      const res = await api.werewolfNightAction(player, 'save', victim);
      toast(res?.result || `已使用解药救 ${victim}`);
    } catch (e: any) { toast('⚠️ ' + (e.message || '救失败')); }
    setBusy(false);
  };
  const declineWitchSave = async () => {
    setBusy(true);
    try {
      const res = await api.werewolfNightAction(player, 'nosave', '');
      toast(res?.result || '已选择不使用解药（保留解药）');
    } catch (e: any) { toast('⚠️ ' + (e.message || '操作失败')); }
    setBusy(false);
  };
  const declineWitchPoison = async () => {
    setBusy(true);
    try {
      const res = await api.werewolfNightAction(player, 'nopoison', '');
      toast(res?.result || '已选择不使用毒药（保留毒药）');
    } catch (e: any) { toast('⚠️ ' + (e.message || '操作失败')); }
    setBusy(false);
  };
  const vote = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await api.werewolfVote(player, target);
      toast(res?.result || `已投票给 ${target}`);
    } catch (e: any) { toast('⚠️ ' + (e.message || '投票失败')); }
    afterAction();
  };
  const shoot = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await api.werewolfHunterShoot(player, target);
      toast(res?.result || `已开枪击杀 ${target}`);
    } catch (e: any) { toast('⚠️ ' + (e.message || '开枪失败')); }
    afterAction();
  };
  const say = async () => {
    if (!msg.trim()) return;
    setBusy(true);
    try {
      const res = await api.werewolfDiscussionSay(player, msg.trim());
      if (res?.ok) { toast(`🗣️ 你发言：${msg.trim()}`); setMsg(''); }
      else toast('⚠️ ' + (res?.error || '发言失败'));
    } catch (e: any) { toast('⚠️ ' + (e.message || '发言失败')); }
    setBusy(false);
  };
  const approve = async () => {
    setBusy(true);
    try { await api.approvalApprove(store.werewolfSessionId); toast('✅ 已批准投票结算'); }
    catch (e: any) { toast('⚠️ ' + (e.message || '批准失败')); }
    setBusy(false);
  };
  const reject = async () => {
    setBusy(true);
    try { await api.approvalReject(store.werewolfSessionId); toast('❌ 已驳回，重新投票'); }
    catch (e: any) { toast('⚠️ ' + (e.message || '驳回失败')); }
    setBusy(false);
  };

  const targetChips = (
    <div className="ww-action-targets">
      {aliveOthers.map(n => (
        <button
          key={n}
          className={`ww-target-chip${target === n ? ' on' : ''}`}
          onClick={() => setTarget(n)}
        >{n}</button>
      ))}
      {aliveOthers.length === 0 && <span className="muted">无存活目标</span>}
    </div>
  );

  // 已出局猎人：任何阶段（未终局）可开枪
  if (isEliminated && role === '猎人' && !isGameOver) {
    return (
      <div className="ww-action-box">
        <div className="ww-action-title">🏹 猎人反击（你已被淘汰，可开枪带走一人）</div>
        {targetChips}
        <button className="btn btn-small btn-danger" disabled={!target || busy} onClick={shoot}>🏹 开枪</button>
      </div>
    );
  }
  if (isGameOver) return null;

  if (p === 'night') {
    const canKill = role === '狼人';
    const canCheck = role === '预言家';
    const canWitch = role === '女巫';
    if (!canKill && !canCheck && !canWitch) {
      return <div className="ww-action-box muted">🌙 你闭眼等待天亮（AI 角色正在行动）…</div>;
    }
    // P-0802-I (G1-2)：女巫先获知被刀者（werewolf_witch_info 推送），再决定救/不救/毒
    if (canWitch) {
      const victim = store.werewolfWitchVictim;
      return (
        <div className="ww-action-box">
          <div className="ww-action-title">🌙 女巫夜间（先获知被刀者，再决定）</div>
          {!victim ? (
            <div className="muted" style={{ fontSize: 12, padding: '2px 0' }}>
              🌙 你正在等待获知昨夜被刀者…（狼人行动后显示）
            </div>
          ) : (
            <>
              <div className="ww-witch-victim" style={{ marginBottom: 6, fontSize: 13 }}>
                💀 昨夜被刀者：<b>{victim}</b>
              </div>
              <div className="ww-action-btns">
                <button className="btn btn-small" disabled={busy} onClick={saveWitchVictim}>💊 救 {victim}（解药）</button>
                <button className="btn btn-small" disabled={busy} onClick={declineWitchSave}>🚫 不使用解药（保留）</button>
                <button className="btn btn-small" disabled={busy} onClick={declineWitchPoison}>☠️ 不用毒（保留）</button>
              </div>
              <div style={{ marginTop: 6 }}>
                <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>☠️ 使用毒药（选择目标）：</div>
                {targetChips}
                <button className="btn btn-small btn-danger" disabled={!target || busy} onClick={() => act('poison')}>☠️ 毒药</button>
              </div>
            </>
          )}
        </div>
      );
    }
    return (
      <div className="ww-action-box">
        <div className="ww-action-title">🌙 夜间行动：{role}（选择目标）</div>
        {targetChips}
        <div className="ww-action-btns">
          {canKill && <button className="btn btn-small btn-danger" disabled={!target || busy} onClick={() => act('kill')}>🔪 刀杀</button>}
          {canCheck && <button className="btn btn-small" disabled={!target || busy} onClick={() => act('check')}>🔮 查验</button>}
        </div>
      </div>
    );
  }
  if (p === 'day_discussion') {
    return (
      <div className="ww-action-box">
        <div className="ww-action-title">☀️ 白天讨论（AI 自动发言，可插入你的推理）</div>
        <div className="ww-discussion">
          {store.werewolfDiscussion.slice(-15).map((t, i) => (
            <div key={i} className="ww-disc-turn"><b>{t.speaker}</b>：{t.message}</div>
          ))}
          {store.werewolfDiscussion.length === 0 && <div className="muted">暂无发言…</div>}
        </div>
        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
          <input
            className="input"
            style={{ flex: 1, fontSize: 12 }}
            placeholder="发表你的推理…"
            value={msg}
            onChange={e => setMsg(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') say(); }}
          />
          <button className="btn btn-small" disabled={busy || !msg.trim()} onClick={say}>💬 发言</button>
        </div>
      </div>
    );
  }
  if (p === 'day_vote') {
    return (
      <div className="ww-action-box">
        <div className="ww-action-title">🗳️ 投票：选择你怀疑的狼人</div>
        {targetChips}
        <div className="ww-action-btns">
          <button className="btn btn-small btn-primary" disabled={!target || busy} onClick={vote}>🗳️ 投票</button>
          {store.werewolfApproval === 'pending' && (
            <>
              <span className="muted" style={{ fontSize: 11 }}>⏳ 结算待审批</span>
              <button className="btn btn-small btn-primary" disabled={busy} onClick={approve}>✅ 批准</button>
              <button className="btn btn-small btn-danger" disabled={busy} onClick={reject}>❌ 驳回</button>
            </>
          )}
        </div>
      </div>
    );
  }
  return null;
}

/* ── Script (剧本杀) helpers ─────────────────────── */
const SCRIPT_PHASE_LABEL: Record<string, string> = {
  setup: '准备阶段', investigation: '搜证阶段', discussion: '讨论阶段',
  vote: '投票阶段', reveal: '揭晓阶段', ended: '已结束',
};
const SCRIPT_PHASE_EMOJI: Record<string, string> = {
  setup: '🎭', investigation: '🔍', discussion: '🗣️', vote: '🗳️', reveal: '🎬', ended: '🏁',
};

function ScriptStatePanel(props: {
  state: any;
  currentPlayer: string;
  foundClues: any[];
  publicClues: any[];
  reveal: any;
  voteTarget: string;
  setVoteTarget: (n: string) => void;
  simulation: any;
  busy: boolean;
  searchMsg: string;
  transferTargets: Record<string, string>;
  setTransferTargets: (m: Record<string, string>) => void;
  onSearch: (location: string) => void;
  onTransferClue: (clueId: string, target: string) => void;
  onStartDiscussion: () => void;
  onStartVoting: () => void;
  onVote: () => void;
  onResolve: () => void;
  onFinish: () => void;
  /** P0-3：内嵌 2D 模拟面板开关（替代 window.open 双开） */
  onOpen2D?: () => void;
}) {
  const {
    state, currentPlayer, foundClues, publicClues, reveal, voteTarget,
    setVoteTarget, simulation, busy, searchMsg, transferTargets, setTransferTargets,
    onSearch, onTransferClue, onStartDiscussion, onStartVoting, onVote, onResolve, onFinish,
    onOpen2D,
  } = props;
  if (!state) {
    return (
      <div className="ww-panel">
        <div className="muted" style={{ padding: 8, fontSize: 12 }}>剧本局加载中...</div>
      </div>
    );
  }
  const phase: string = state.phase || 'setup';
  const otherPlayers: string[] = (state.players || []).filter((n: string) => n !== currentPlayer);

  return (
    <div className="ww-panel">
      {/* Header — current phase */}
      <div className="ww-panel-header">
        <span>{SCRIPT_PHASE_EMOJI[phase] || '🎮'}</span>
        <span>{SCRIPT_PHASE_LABEL[phase] || phase}</span>
      </div>

      {/* My role */}
      <div className="ww-my-role-box">
        <span>🎭</span>
        <span>{state.your_role || '未分配角色'}</span>
      </div>

      {/* C2: 行动点余额（初始 = 基础值 + 角色 ap_bonus，搜证消耗） */}
      <div className="ww-my-role-box" style={{ marginTop: 4 }}>
        <span>⚡</span>
        <span>行动点 {state.ap ?? 0} / {state.ap_max ?? 0}</span>
      </div>

      {/* My secret (only visible to me) */}
      {state.your_secret && (
        <div className="card" style={{ margin: '4px 10px 8px', padding: 8, fontSize: 12, background: 'var(--bg-2)', color: 'var(--text-2)', lineHeight: 1.5 }}>
          🔒 <strong>你的秘密</strong>（只有你知道，切勿泄露）：{state.your_secret}
        </div>
      )}

      {/* Investigation: search locations (backend search 仅搜证阶段可用；C2: 搜索消耗 AP) */}
      {phase === 'investigation' && (
        <div className="ww-panel-section">
          <div className="ww-panel-section-title">🔍 搜证地点（⚡{state.ap ?? 0}）</div>
          <div style={{ padding: '0 10px 6px', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {(state.locations || []).map((loc: string) => (
              <button key={loc} className="btn btn-smallall" disabled={busy} onClick={() => onSearch(loc)}>📍 {loc}</button>
            ))}
          </div>
          {/* C2: 搜证结果/行动点不足提示 */}
          {searchMsg && (
            <div style={{ padding: '0 10px 6px', fontSize: 12, color: 'var(--text-2)' }}>{searchMsg}</div>
          )}
        </div>
      )}
      {/* 本次搜证结果（上次 search 响应；主反馈已走 searchMsg，此处保留线索明细） */}
      {(foundClues.length > 0 || publicClues.length > 0) && (
        <div className="ww-panel-section">
          <div style={{ padding: '0 10px 8px', fontSize: 12, color: 'var(--text-2)' }}>
            {foundClues.length > 0 && (
              <div style={{ marginBottom: 4 }}>
                <strong>本次搜证：</strong>
                {foundClues.map((c: any, i: number) => (
                  <div key={i} style={{ marginTop: 2 }}>• {c.content}</div>
                ))}
              </div>
            )}
            {publicClues.length > 0 && (
              <div>
                <strong>公开线索：</strong>
                {publicClues.map((c: any, i: number) => (
                  <div key={i} style={{ marginTop: 2 }}>• {c.content}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* C2: 我持有的线索（含转入的；investigation/discussion 均展示） */}
      {(phase === 'investigation' || phase === 'discussion') && (state.my_clues || []).length > 0 && (
        <div className="ww-panel-section">
          <div className="ww-panel-section-title">📋 我持有的线索</div>
          <div style={{ padding: '0 10px 8px', fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
            {(state.my_clues || []).map((c: any, i: number) => (
              <div key={c.id || i} style={{ marginTop: 2 }}>
                • {c.title || c.content}{c.transferable ? ' 🔁' : ''}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* C2: 线索转交（仅可转交线索；选择目标玩家后转交，ownership 变更） */}
      {(phase === 'investigation' || phase === 'discussion')
        && (state.my_clues || []).some((c: any) => c.transferable) && otherPlayers.length > 0 && (
        <div className="ww-panel-section" style={{ padding: '0 10px 8px' }}>
          <div className="ww-panel-section-title">🔁 线索转交</div>
          {(state.my_clues || []).filter((c: any) => c.transferable).map((c: any) => (
            <div key={c.id} style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 4, fontSize: 12 }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.title || (c.content || '').slice(0, 10)}
              </span>
              <select
                value={transferTargets[c.id] || ''}
                onChange={(e) => setTransferTargets({ ...transferTargets, [c.id]: e.target.value })}
                style={{ maxWidth: 90, fontSize: 12 }}
              >
                <option value="">选玩家</option>
                {otherPlayers.map((p: string) => <option key={p} value={p}>{p}</option>)}
              </select>
              <button
                className="btn btn-smallall"
                disabled={busy || !transferTargets[c.id]}
                onClick={() => onTransferClue(c.id, transferTargets[c.id])}
              >
                转交
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Phase transitions */}
      {phase === 'investigation' && (
        <div className="ww-panel-section" style={{ padding: '0 10px 8px' }}>
          <button className="btn btn-smallall" disabled={busy} onClick={onStartDiscussion}>🗣️ 结束搜证，进入讨论</button>
        </div>
      )}
      {phase === 'discussion' && (
        <div className="ww-panel-section" style={{ padding: '0 10px 8px' }}>
          <button className="btn btn-smallall" disabled={busy} onClick={onStartVoting}>🗳️ 结束讨论，进入投票</button>
        </div>
      )}

      {/* 2D simulation bridge */}
      {(phase === 'discussion' || state.simulation_started) && (
        <div className="ww-panel-section" style={{ padding: '0 10px 8px' }}>
          <div className="ww-panel-section-title">🗺️ 2D 空间讨论</div>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-2)', marginBottom: 6 }}>
            {state.simulation_started
              ? `已接入 2D 世界：${simulation?.agentCount ?? state.players?.length ?? 0} 名角色，tick ${simulation?.tick ?? 0}`
              : '进入讨论后会自动加载 2D 世界'}
          </div>
          <button className="btn btn-smallall" disabled={!state.simulation_started} onClick={() => onOpen2D && onOpen2D()}>
            查看 2D 模拟（内嵌）
          </button>
        </div>
      )}

      {/* Vote */}
      {phase === 'vote' && (
        <div className="ww-panel-section" style={{ padding: '0 10px 8px' }}>
          <div className="ww-panel-section-title">🗳️ 投票：你怀疑谁是真凶？</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
            {otherPlayers.map((n: string) => (
              <button key={n} className={`chip ${voteTarget === n ? 'selected' : ''}`} onClick={() => setVoteTarget(n)}>{n}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-smallall btn-primary" disabled={busy || !voteTarget} onClick={onVote}>投 {voteTarget || '...'}</button>
            <button className="btn btn-smallall" disabled={busy} onClick={onResolve}>🎬 揭晓真相</button>
          </div>
        </div>
      )}

      {/* Reveal result */}
      {(phase === 'reveal' || reveal) && (
        <div className="ww-panel-section" style={{ padding: '0 10px 8px' }}>
          <div className="ww-panel-section-title">🎬 揭晓</div>
          <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-2)' }}>
            <div>得票最多：{reveal?.most_voted || state.most_voted || '无'}</div>
            <div>结果：{reveal?.result || state.result || ''}</div>
            <div style={{ marginTop: 4 }}><strong>真相：</strong>{reveal?.truth || state.truth || ''}</div>
            {state.winner && <div style={{ marginTop: 4 }}>🏆 {state.winner}</div>}
          </div>
          {/* GAP-4b: REVEAL 展示后由前端确认进入 ENDED */}
          {phase === 'reveal' && (
            <button className="btn btn-smallall" style={{ marginTop: 6 }} disabled={busy} onClick={onFinish}>
              🏁 结束对局
            </button>
          )}
        </div>
      )}

      {/* GAP-4b: ENDED 终态展示 */}
      {phase === 'ended' && (
        <div className="ww-panel-section" style={{ padding: '0 10px 8px' }}>
          <div className="ww-panel-section-title">🏁 终局</div>
          <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-2)' }}>
            <div>被定罪：{state.winner || reveal?.most_voted || '无'}</div>
            <div>真凶：{reveal?.murderer || state.murderer || '未识别'}</div>
            <div>判定：{reveal?.correct === true ? '✅ 成功找到真凶' : reveal?.correct === false ? '❌ 冤枉了好人' : ''}</div>
            <div style={{ marginTop: 4 }}><strong>真相：</strong>{reveal?.truth || state.truth || ''}</div>
          </div>
        </div>
      )}

      <div style={{ padding: '4px 10px', fontSize: 11, color: 'var(--text-3)' }}>
        《{state.name}》 第 {state.round || 1} 轮
      </div>
    </div>
  );
}

function RoundSystemLine({ msg, onRollback }: { msg: AppMessage; onRollback: (round: number) => void }) {
  const match = msg.content.match(/第\s*(\d+)\s*轮完成/);
  const round = match ? Number(match[1]) : 0;
  return (
    <div className="system-line">
      {msg.content}
      {round > 0 && <button className="btn btn-smallall" style={{ marginLeft: 8 }} onClick={() => onRollback(round)}>回滚</button>}
    </div>
  );
}

function MessageView({ msg }: { msg: AppMessage }) {
  if (msg.role === 'system') return <RoundSystemLine msg={msg} onRollback={() => {}} />;

  if (msg.role === 'arbiter') {
    return (
      <div className="arbiter-box">
        <div className="message-meta"><strong>主控整合</strong></div>
        <div>{msg.content}</div>
      </div>
    );
  }

  if (msg.role === 'user') {
    return (
      <div className="message user">
        <div className="message-body">
          <div className="message-meta">主控输入</div>
          <div className="bubble">{msg.content}</div>
        </div>
      </div>
    );
  }

  const color = colorFor(msg.name);
  return (
    <div className="message">
      <div className="avatar" style={{ background: color }}>{msg.name?.[0] || '?'}</div>
      <div className="message-body">
        <div className="message-meta">
          <strong style={{ color }}>{msg.name}</strong>
          <span>{msg.track_label || msg.track_id}</span>
          <span>{trackModeName(msg.track_mode)}</span>
        </div>
        {/* P-0802-M：流式草稿带闪烁光标（ChatGPT 式逐字渲染）；agent_output 结算后光标消失 */}
        <div className="bubble">{msg.content}{msg.streaming && <span className="stream-caret">▍</span>}</div>
      </div>
    </div>
  );
}

export function ChatPage() {
  const store = useAppStore();
  const [goalInput, setGoalInput] = useState('');
  const [userInput, setUserInput] = useState('');
  const [showDirector, setShowDirector] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // P1-8：聊天设置面板（聊天模式切换 + 公告栏显示开关）
  const [showChatSettings, setShowChatSettings] = useState(false);
  const [annEnabled, setAnnEnabled] = useState(() => {
    try { return localStorage.getItem('roleplay_ann_show') !== '0'; } catch { return true; }
  });
  const toggleAnnEnabled = () => {
    setAnnEnabled(v => {
      const next = !v;
      try { localStorage.setItem('roleplay_ann_show', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };
  /** P1-8：聊天模式切换（自由对话 / 导演模式；狼人杀/剧本杀需在「场景」页开局，此处不提供） */
  const switchChatMode = async (m: string) => {
    if (m === store.mode) { setShowChatSettings(false); return; }
    setShowChatSettings(false);
    try {
      if (store.isRunning) await store.stop();
      if (m === 'director') {
        const dc = (store.directorCharacter && store.directorCharacter !== '系统') ? store.directorCharacter : store.currentPlayer;
        await store.setMode('director', '', dc);
      } else {
        await store.setMode('free', '', '');
      }
    } catch { /* ignore */ }
  };
  // C4: 主持人面板开关（剧本杀模式可见；对齐 Chronos DM 控制台）
  const [showDm, setShowDm] = useState(false);
  // C4: 恢复对局 UI（重连入口：session_id / room_code + player_key → resume）
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeGameId, setResumeGameId] = useState('');
  const [resumeRoomCode, setResumeRoomCode] = useState('');
  const [resumePlayerKey, setResumePlayerKey] = useState('');
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeInfo, setResumeInfo] = useState<any>(null);
  // P-0802-I: 狼人杀恢复对局（重连）UI 状态
  const [wwResumeOpen, setWwResumeOpen] = useState(false);
  const [wwResumeGameId, setWwResumeGameId] = useState('');
  const [wwResumeRoomCode, setWwResumeRoomCode] = useState('');
  // P-0802-J: 狼人杀恢复对局必填 roleKey（重连/防冒充凭证，防跨角色冒充）
  const [wwResumePlayerKey, setWwResumePlayerKey] = useState('');
  const [wwResumeBusy, setWwResumeBusy] = useState(false);
  const [wwResumeInfo, setWwResumeInfo] = useState<any>(null);
  const [autoPlay, setAutoPlay] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const convRef = useRef<HTMLDivElement>(null);

  // 剧本杀对局状态（SSE 优先 + 轮询 /api/script/status 兜底，仅 script 模式生效）
  // 状态存 zustand（App.tsx 的 script_* SSE 分支写入），本组件只读 + 轮询兜底写入
  const scriptState = store.scriptState;
  const scriptReveal = store.scriptReveal;
  const [scriptClues, setScriptClues] = useState<any[]>([]);
  const [scriptPublicClues, setScriptPublicClues] = useState<any[]>([]);
  const [scriptVoteTarget, setScriptVoteTarget] = useState('');
  const [scriptSimulation, setScriptSimulation] = useState<any>(null);
  const [scriptBusy, setScriptBusy] = useState(false);
  // C2: 搜证结果提示（搜证成功/行动点不足/转交反馈）
  const [scriptSearchMsg, setScriptSearchMsg] = useState('');
  // C2: 线索转交 —— clueId → 目标玩家
  const [transferTargets, setTransferTargets] = useState<Record<string, string>>({});

  // P0-3：内嵌 2D 模拟面板（单页不双开）——角色列表懒初始化一次（避免每渲染重建导致 Phaser 重挂载）
  const [simChars] = useState<Array<{ name: string; persona: string; voice: string; background: string }>>(() => {
    const st = useAppStore.getState();
    return st.agents.map(name => {
      const ch = st.characters.find((c: any) => c.name === name);
      return ch
        ? { name: ch.name, persona: ch.persona || '', voice: ch.voice || '', background: ch.background || '' }
        : { name, persona: name + '，一个角色', voice: '', background: '' };
    });
  });
  const [showSimPanel, setShowSimPanel] = useState(false);
  // C-1：2D 面板不再由 localStorage 自动展开——主入口合并到场景页「🎮 2D 模拟」按钮；
  // 此处仅保留剧本杀「查看 2D 模拟（内嵌）」按钮（onOpen2D）联动开关
  const toggleSimPanel = () => setShowSimPanel(v => !v);

  const refreshScript = async () => {
    try {
      const st = await api.scriptStatus(store.currentPlayer);
      store.setScriptState(st);
      // P-0802-J：轮询回写对局 session_id（SSE 会话定向连接；重连/多局场景按对局定位）
      if (st?.session_id) store.setScriptSessionId(st.session_id);
      if (st?.simulation_started) {
        try { setScriptSimulation(await api.simulationState()); } catch { /* ignore */ }
      }
    } catch { /* 服务未就绪时忽略 */ }
  };

  useEffect(() => {
    if (store.mode !== 'script') {
      store.setScriptState(null);
      store.setScriptReveal(null);
      setScriptClues([]);
      setScriptPublicClues([]);
      setScriptSimulation(null);
      setScriptSearchMsg('');
      setTransferTargets({});
      return;
    }
    let alive = true;
    const poll = async () => {
      try {
        const st = await api.scriptStatus(store.currentPlayer);
        if (alive) {
          store.setScriptState(st);
          // P-0802-J：轮询回写对局 session_id（SSE 会话定向连接）
          if (st?.session_id) store.setScriptSessionId(st.session_id);
          if (st?.simulation_started) {
            try { setScriptSimulation(await api.simulationState()); } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [store.mode, store.currentPlayer]);

  /** P-0802-F：狼人杀 3s 轮询（SSE 兜底）—— 刷新阶段/轮次/存活/狼人互认/讨论/我的身份 */
  useEffect(() => {
    if (store.mode !== 'werewolf') return;
    let aliveFlag = true;
    const wwRoleCn: Record<string, string> = { werewolf:'狼人', wolf:'狼人', seer:'预言家', witch:'女巫', hunter:'猎人', villager:'平民' };
    const poll = async () => {
      try {
        // P-0802-I：显式传 session_id（重连/多局场景按对局定位）
        const st = await api.werewolfStatus(store.currentPlayer, store.werewolfSessionId || undefined);
        if (!aliveFlag || !st || typeof st !== 'object') return;
        if (st.session_id) store.setWerewolfSessionId(st.session_id);
        if (st.phase) store.setWerewolfPhase(normalizePhase(st.phase) as WerewolfPhase, st.round);
        if (st.your_role) store.setWerewolfMyRole(wwRoleCn[st.your_role] || st.your_role);
        if (Array.isArray(st.alive)) {
          store.setWerewolfAlive(st.alive);
          const players: { name: string; role: string; alive: boolean; roleRevealed: boolean }[] =
            (st.alive as string[]).map(n => ({ name: n, role: '', alive: true, roleRevealed: false }));
          if (Array.isArray(st.eliminated)) {
            (st.eliminated as any[]).forEach((e: any) => {
              if (e && e.name) players.push({ name: e.name, role: '', alive: false, roleRevealed: false });
            });
          }
          store.setWerewolfPlayers(players);
        }
        if (st.visible && typeof st.visible === 'object') store.setWerewolfVisible(st.visible);
        if (Array.isArray(st.discussion)) store.setWerewolfDiscussion(st.discussion);
        // P-0802-J：轮询兜底刷新本人 roleKey（重连/防冒充凭证，init/status 响应发放）
        if (st.role_key) store.setWerewolfRoleKey(String(st.role_key));
        // P-0802-I (G1-2)：轮询兜底刷新女巫获知被刀者（SSE 丢失/重连后仍能恢复）
        if (st.witch_victim) store.setWerewolfWitchVictim(String(st.witch_victim));
        if (st.winner) store.setWerewolfWinner(st.winner);
      } catch { /* 服务未就绪时忽略 */ }
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => { aliveFlag = false; clearInterval(t); };
  }, [store.mode, store.currentPlayer]);

  const doScriptSearch = async (location: string) => {
    setScriptBusy(true);
    try {
      const res = await api.scriptSearch(store.currentPlayer, location);
      setScriptClues(res.clues || []);
      setScriptPublicClues(res.public_clues || []);
      // C2: 搜证反馈（行动点不足/搜证成功/无线索）
      setScriptSearchMsg(res.error ? `⚠️ ${res.error}` : (res.result || ''));
      // C2: AP 变化立即刷新状态（不用等 3s 轮询）
      await refreshScript();
    } catch { /* ignore */ }
    setScriptBusy(false);
  };
  /** C2: 线索转交 —— 转交后 ownership 变更，接收方 status 可见 */
  const doScriptTransferClue = async (clueId: string, target: string) => {
    if (!target) return;
    setScriptBusy(true);
    try {
      const res = await api.scriptTransferClue(store.currentPlayer, target, clueId);
      setScriptSearchMsg(res.error ? `⚠️ ${res.error}` : (res.result || `已将线索转交给 ${target}`));
      setTransferTargets({});
      await refreshScript();
    } catch { /* ignore */ }
    setScriptBusy(false);
  };
  const doScriptStartDiscussion = async () => {
    setScriptBusy(true);
    try {
      const res = await api.scriptStartDiscussion();
      if (res?.simulation_started) {
        try { setScriptSimulation(await api.simulationState()); } catch { /* ignore */ }
      }
      await refreshScript();
    } catch { /* ignore */ }
    setScriptBusy(false);
  };
  const doScriptStartVoting = async () => {
    setScriptBusy(true);
    try { await api.scriptStartVoting(); await refreshScript(); } catch { /* ignore */ }
    setScriptBusy(false);
  };
  const doScriptVote = async () => {
    if (!scriptVoteTarget) return;
    setScriptBusy(true);
    try {
      await api.scriptVote(store.currentPlayer, scriptVoteTarget);
      setScriptVoteTarget('');
      await refreshScript();
    } catch { /* ignore */ }
    setScriptBusy(false);
  };
  const doScriptResolve = async () => {
    setScriptBusy(true);
    try {
      const res = await api.scriptResolve();
      store.setScriptReveal(res);
      await refreshScript();
    } catch { /* ignore */ }
    setScriptBusy(false);
  };
  const doScriptFinish = async () => {
    setScriptBusy(true);
    try { await api.scriptFinish(); await refreshScript(); } catch { /* ignore */ }
    setScriptBusy(false);
  };
  /** P-0802-I：狼人杀断线重连恢复 —— 按 session_id/room_code 拉取当前对局状态并写入 store；
   *  P-0802-J：必须携带本人 roleKey（player_key）—— 对齐剧本杀 C3 roleKey 体系，防止拿 session_id 冒充任意角色。 */
  const doWerewolfResume = async () => {
    if (!wwResumeGameId.trim() && !wwResumeRoomCode.trim()) {
      setWwResumeInfo({ error: '请输入对局ID（session_id）或房间码' });
      return;
    }
    if (!wwResumePlayerKey.trim()) {
      setWwResumeInfo({ error: '请输入玩家 roleKey（重连凭证，见下方「我的 roleKey」）' });
      return;
    }
    setWwResumeBusy(true);
    setWwResumeInfo(null);
    try {
      const res = await api.werewolfResume({
        session_id: wwResumeGameId.trim(),
        room_code: wwResumeRoomCode.trim(),
        player: store.currentPlayer,
        player_key: wwResumePlayerKey.trim(),
      });
      if (res?.error) {
        setWwResumeInfo({ error: res.error });
      } else {
        if (res.session_id) store.setWerewolfSessionId(res.session_id);
        // P-0802-J：恢复响应携带本人 role_key，回写 store（后续重连免手工输入）
        if (res.role_key) store.setWerewolfRoleKey(res.role_key);
        if (res.phase) store.setWerewolfPhase(normalizePhase(res.phase) as WerewolfPhase, res.round);
        if (res.your_role) {
          const wwRoleCn: Record<string, string> = { werewolf:'狼人', wolf:'狼人', seer:'预言家', witch:'女巫', hunter:'猎人', villager:'平民' };
          store.setWerewolfMyRole(wwRoleCn[res.your_role] || res.your_role);
        }
        if (Array.isArray(res.alive)) store.setWerewolfAlive(res.alive);
        if (res.visible && typeof res.visible === 'object') store.setWerewolfVisible(res.visible);
        if (Array.isArray(res.discussion)) store.setWerewolfDiscussion(res.discussion);
        // P-0802-I (G1-2)：恢复后女巫获知的被刀者同步回面板
        if (res.witch_victim) store.setWerewolfWitchVictim(String(res.witch_victim));
        if (res.winner) store.setWerewolfWinner(res.winner);
        if (res.phase === 'ended' || res.terminal) store.setWerewolfPhase('game_over');
        setWwResumeInfo({ ok: true, restored: res.restored, phase: res.phase, terminal: res.terminal, winner: res.winner });
      }
    } catch (e: any) {
      setWwResumeInfo({ error: e.message || '恢复失败' });
    }
    setWwResumeBusy(false);
  };

  /** C4: 恢复对局（重连）—— 输入 session_id 或 room_code + player_key → POST /api/script/resume → 恢复玩家视图 */
  const doScriptResume = async () => {
    const body: { game_id?: string; room_code?: string; player_key?: string } = {};
    if (resumeGameId.trim()) body.game_id = resumeGameId.trim();
    else if (resumeRoomCode.trim()) body.room_code = resumeRoomCode.trim().toUpperCase();
    if (resumePlayerKey.trim()) body.player_key = resumePlayerKey.trim();
    if (!body.game_id && !body.room_code) { setResumeInfo({ error: '请输入对局ID（session_id）或房间码' }); return; }
    if (!body.player_key) { setResumeInfo({ error: '请输入玩家 roleKey（重连凭证）' }); return; }
    setResumeBusy(true);
    setResumeInfo(null);
    try {
      const res = await api.scriptResume(body);
      if (res.error) {
        setResumeInfo({ error: res.error });
      } else {
        store.setScriptState(res);
        if (res.phase) store.setScriptPhase(res.phase);
        // P-0802-J：恢复后回写对局 session_id（SSE 会话定向连接）
        if (res.session_id) store.setScriptSessionId(res.session_id);
        setResumeInfo({
          ok: true,
          player: res.player,
          phase: res.phase,
          restored: res.restored === true,
          terminal: res.terminal === true,
          murderer: res.murderer,
          correct: res.correct,
          truth: res.truth,
          votes: res.votes,
          winner: res.winner,
        });
      }
    } catch (e: any) {
      setResumeInfo({ error: e.message || '恢复失败' });
    }
    setResumeBusy(false);
  };

  useEffect(() => {
    if (convRef.current) convRef.current.scrollTop = convRef.current.scrollHeight;
    // P-0802-M：流式增量只改 content 不改 length → 依赖末尾消息内容才能逐字跟滚
  }, [store.messages.length, store.messages[store.messages.length - 1]?.content]);

  // Auto-play: when round completes, continue if no human wait needed
  useEffect(() => {
    if (!autoPlay) return;
    if (store.isRunning) return;

    if (store.mode === 'werewolf') {
      // P-0802-F：狼人杀改为后端自动推进（AI 夜间行动器 + 白天讨论引擎 + 投票自动结算），
      // 前端不再调 startRound 走一般对话管线（旧行为="仍按一般模式交流"，调研报告 §1.2 根因⑥）
      setAutoPlay(false);
      return;
    } else {
      // Free / non-werewolf mode: reset autoPlay once round completes
      setAutoPlay(false);
    }
  }, [autoPlay, store.isRunning, store.werewolfWaitHuman, store.werewolfPhase, store.mode]);

  useEffect(() => {
    return () => { if (autoTimerRef.current) clearTimeout(autoTimerRef.current); };
  }, []);


  const visibleMessages = useMemo(() => {
    // Werewolf mode: filter messages visible to current human player
    const filterName = store.historyFilter ||
      (store.mode === 'werewolf'
        ? store.currentPlayer
        : (store.directorCharacter && store.directorCharacter !== '系统'
          ? store.directorCharacter
          : null));
    if (!filterName) return store.messages;
    return store.messages.filter(m => {
      if (m.visible_to && m.visible_to.length > 0) {
        return m.visible_to.includes(filterName);
      }
      return true;  // No visibility restriction = public
    });
  }, [store.historyFilter, store.messages, store.mode, store.directorCharacter]);

  const latestTrackConfig = store.trackHistory[store.trackHistory.length - 1];

  const startAuto = () => store.startRound(3);
  const send = async () => {
    const text = userInput.trim();
    if (!text) return;
    if (store.isRunning) {
      // P0-2：stop 后再 send 不再永久停摆（后端 runRound 对非空会话自动恢复 running）
      await store.stop();
    }
    // Determine player name（P0-1：不再硬编码 'me'，用当前玩家名）
    const isWW = store.mode === 'werewolf';
    const playerName = isWW
      ? store.currentPlayer
      : (store.directorCharacter && store.directorCharacter !== '系统')
        ? store.directorCharacter
        : (store.agents.includes(store.currentPlayer) ? store.currentPlayer : '');
    // P0-2/E6：非狼人杀不再乐观渲染（后端 speaker 命中 agent 时 SSE user_input 带 character 回显，
    // 避免同一条消息双重展示：先显示为角色、再显示为主控输入）
    if (isWW) {
      // 狼人杀无 SSE 回显通道，保留乐观显示
      store.addAgentMsg(playerName, text);
    }
    store.sendMessage(text, playerName);
    setUserInput('');
  };
  const effectivePlayer = () => {
    if (store.directorCharacter && store.directorCharacter !== '系统') return store.directorCharacter;
    return '';
  };
  const composerPlaceholder = () => {
    const player = effectivePlayer();
    if (store.werewolfWaitHuman && player) return `你是 ${player}，请发言...`;
    if (store.directorCharacter && store.directorCharacter !== '系统') return `以 ${store.directorCharacter} 的身份发言...`;
    if (store.agents.includes(store.currentPlayer)) return `以 ${store.currentPlayer} 的身份发言...`;
    // 批次 D 收尾（P0-1 发言门控）：剧本杀模式下提示 @ 点名——后端 SpeechGate 对人类发言含
    // 「@角色名 / 句首角色名 / 标点后角色名」判定为点名 → 该 AI 强制发言（不受健谈度限制）。
    // TODO（后续批次）：@ 提及的输入增强（角色名自动补全/高亮）与讨论区静默占位「……（沉默）」
    //   的特殊样式（当前按普通文本渲染，功能可用仅无样式）；开发期改动未跑 npm run build，
    //   产物同步待 Phaser 批次（P-0801-B）构建链完成后一并处理。
    if (store.mode === 'script') return '输入旁白或 @角色名 点名 AI（被点名者将强制发言）...';
    return '输入主控旁白，例如：让苏哲先检查门锁，林诗保持警惕';
  };
  const addGoal = async () => {
    const text = goalInput.trim();
    if (!text) return;
    await store.setGoals([...store.goals, text]);
    setGoalInput('');
  };
  const removeGoal = async (index: number) => {
    await store.setGoals(store.goals.filter((_, i) => i !== index));
  };
  const rollback = async (round: number) => {
    if (round > 0 && confirm(`回滚到第 ${round} 轮完成后的状态？`)) await store.rollback(round);
  };

  const handleAddAgent = async (name: string) => {
    setShowAddAgent(false);
    if (store.isRunning) {
      await store.stop();
    }
    await api.addAgent(name);
    store.addAgent(name, 'active');
    await store.loadState();
  };

  const handleRemoveAgent = async (name: string) => {
    if (store.isRunning) {
      await store.stop();
    }
    await store.removeAgent(name);
    await store.loadState();
  };

  const inactiveCharacters = store.characters.filter(
    (c: any) => !store.agents.includes(c.name)
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">R</div>
          <div style={{ minWidth: 0 }}>
            <div className="brand-title">Roleplay v4</div>
            <div className="brand-subtitle">{store.sceneDescription || '未加载场景描述'}</div>
          </div>
        </div>
        <div className="topbar-spacer" />
        <span className="status-pill">{store.isRunning ? '⏳ 运行中' : '⏸ 空闲'}</span>
        <span className="status-pill">第 {store.currentRound} 轮</span>
        <button className={`btn ${showDirector ? 'btn-primary' : ''}`} onClick={() => setShowDirector(!showDirector)}>🎬 导演</button>
        <button className={`btn ${showChatSettings ? 'btn-primary' : ''}`} onClick={() => setShowChatSettings(!showChatSettings)}>⚙️ 设置</button>
        {store.mode === 'script' && (
          <button className={`btn ${showDm ? 'btn-primary' : ''}`} onClick={() => setShowDm(!showDm)}>🎛 主持人</button>
        )}
        <button className="btn" onClick={() => store.goToView('scene')}>场景</button>
        <button className="btn" onClick={() => store.goToView('config')}>角色库</button>
        <button className={`btn ${showHistory ? 'btn-primary' : ''}`} onClick={() => setShowHistory(!showHistory)}>📋 历史</button>
      </header>

      {/* P-0802-L：script 模式同样渲染 3 列（panel-left + 剧本杀状态面板 + chat-main），加 script-mode 类使 grid 三列正确分栏（否则 chat-main 被挤成左下 140px 窄条） */}
      <div className={`workspace${store.mode === 'werewolf' ? ' werewolf-mode' : ''}${store.mode === 'script' ? ' script-mode' : ''}`}>
        {/* P1-8：聊天设置面板（模式切换 + 公告栏开关；点外部关闭） */}
        {showChatSettings && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 98 }} onClick={() => setShowChatSettings(false)} />
        )}
        {showChatSettings && (
          <div style={{
            position: 'fixed', right: 16, top: 56, zIndex: 99, width: 280,
            background: 'var(--bg-2, #1e293b)', border: '1px solid var(--border, #334155)',
            borderRadius: 10, padding: 12, boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
          }}>
            <div className="label" style={{ marginBottom: 6 }}>⚙️ 聊天设置</div>
            <div className="label" style={{ fontSize: 12, color: 'var(--text-3)', margin: '8px 0 4px' }}>聊天模式</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                className={`chip ${store.mode === 'free' ? 'active' : ''}`}
                onClick={() => switchChatMode('free')}
                title="自由对话：角色自动互动"
              >自由对话</button>
              <button
                className={`chip ${store.mode === 'director' ? 'active' : ''}`}
                onClick={() => switchChatMode('director')}
                title="导演模式：以某个角色身份引导剧情"
              >导演模式</button>
              <button className="chip" disabled style={{ opacity: 0.45, cursor: 'not-allowed' }} title="狼人杀/剧本杀请在「场景」页开局">狼人杀</button>
              <button className="chip" disabled style={{ opacity: 0.45, cursor: 'not-allowed' }} title="狼人杀/剧本杀请在「场景」页开局">剧本杀</button>
            </div>
            <div className="label" style={{ fontSize: 12, color: 'var(--text-3)', margin: '10px 0 4px' }}>公告栏（2D 游戏内）</div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={annEnabled} onChange={toggleAnnEnabled} />
              显示演讲/广播公告（横幅 + 公告栏）
            </label>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6, lineHeight: 1.5 }}>
              公告仅在 2D 模拟视图内出现（场景页「🎮 2D 模拟」入口，或剧本杀「查看 2D 模拟（内嵌）」按钮）。
            </div>
          </div>
        )}
        <aside className="panel panel-left">
          <div className="panel-body">
            <div className="section">
              <div className="label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>角色</span>
                <button className="btn btn-smallall btn-primary"
                  onClick={() => setShowAddAgent(!showAddAgent)}
                  title="添加角色">
                  + 
                </button>
              </div>
              {showAddAgent && (
                <div className="dropdown-agent" style={{
                  marginTop: 4, maxHeight: 200, overflowY: 'auto',
                  background: 'var(--bg-2)', borderRadius: 6, border: '1px solid var(--border)',
                }}>
                  {inactiveCharacters.length === 0 ? (
                    <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-3)' }}>所有角色已在会话中</div>
                  ) : inactiveCharacters.map((ch: any) => (
                    <div key={ch.name}
                      className="dropdown-agent-item"
                      onClick={() => handleAddAgent(ch.name)}
                      style={{
                        padding: '6px 10px', cursor: 'pointer', fontSize: 13,
                        borderBottom: '1px solid var(--border)',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-3)')}
                      onMouseLeave={e => (e.currentTarget.style.background = '')}
                    >
                      <span style={{ fontWeight: 600 }}>{ch.name}</span>
                      <span style={{ color: 'var(--text-3)', marginLeft: 8, fontSize: 11 }}>
                        {ch.persona ? ch.persona.slice(0, 24) : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                <button className={`btn btn-smallall ${!store.historyFilter ? 'btn-primary' : ''}`} onClick={() => store.setHistoryFilter(null)}>全部</button>
                {store.agents.map(name => {
                  const active = store.historyFilter === name;
                  return (
                    <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <button className={`actor-chip ${active ? 'selected' : ''}`} onClick={() => store.setHistoryFilter(active ? null : name)}>
                        {name}
                      </button>
                      <button className="btn btn-smallall btn-icon"
                        onClick={() => store.toggleVoice(name)}
                        style={{
                          padding: '0 4px', fontSize: 11, lineHeight: '20px', height: 20,
                          color: store.voiceMap[name] ? '#7c4dff' : '#888',
                          background: store.voiceMap[name] ? '#7c4dff22' : 'transparent',
                          border: '1px solid ' + (store.voiceMap[name] ? '#7c4dff55' : '#444'),
                        }}
                        title={store.voiceMap[name] ? '关闭语音' : '开启语音'}>
                        {store.voiceMap[name] ? '🔊' : '🔇'}
                      </button>
                      <button className="btn btn-smallall btn-icon"
                        onClick={() => handleRemoveAgent(name)}
                        style={{ padding: '0 3px', fontSize: 11, lineHeight: '20px', height: 20, color: 'var(--text-3)' }}
                        title={`移除 ${name}`}>
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </aside>

        {/* Werewolf game state panel */}
        {store.mode === 'werewolf' && store.werewolfPhase !== 'game_over' && store.werewolfPhase !== 'ended' && (
          <aside className="panel panel-werewolf">
            <div className="panel-body" style={{ padding: '8px' }}>
              <WerewolfStatePanel
                phase={store.werewolfPhase}
                round={store.werewolfRound}
                players={store.werewolfPlayers}
                myRole={store.werewolfMyRole}
              />
              <WerewolfActionPanel />
              {/* P-0802-I: 狼人杀恢复对局（重连）入口 —— session_id / room_code → resume 拉取当前对局状态 */}
              <div className="ww-panel" style={{ marginTop: 8 }}>
                <div
                  className="ww-panel-header"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setWwResumeOpen(!wwResumeOpen)}
                >
                  <span>🔄 恢复狼人杀对局（重连）</span>
                  <span>{wwResumeOpen ? '▾' : '▸'}</span>
                </div>
                {wwResumeOpen && (
                  <div style={{ padding: '8px 10px', fontSize: 12 }}>
                    <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                      <input
                        className="input"
                        style={{ flex: 1, fontSize: 12 }}
                        placeholder="对局ID（session_id）"
                        value={wwResumeGameId}
                        onChange={e => setWwResumeGameId(e.target.value)}
                      />
                      <input
                        className="input"
                        style={{ flex: 1, fontSize: 12 }}
                        placeholder="或 房间码"
                        value={wwResumeRoomCode}
                        onChange={e => setWwResumeRoomCode(e.target.value.toUpperCase())}
                      />
                    </div>
                    {/* P-0802-J：roleKey 必填（重连/防冒充凭证，对齐剧本杀 C3 roleKey 体系） */}
                    <input
                      className="input"
                      style={{ width: '100%', fontSize: 12, marginBottom: 4 }}
                      placeholder="玩家 roleKey（必填，重连凭证）"
                      value={wwResumePlayerKey}
                      onChange={e => setWwResumePlayerKey(e.target.value)}
                    />
                    <div style={{ marginBottom: 4, color: 'var(--text-dim)', fontSize: 11 }}>
                      我的 roleKey：<code style={{ wordBreak: 'break-all' }}>{store.werewolfRoleKey || '（未获取，开局后自动发放）'}</code>
                    </div>
                    <button className="btn btn-small btn-primary" disabled={wwResumeBusy} onClick={doWerewolfResume}>
                      {wwResumeBusy ? '恢复中...' : '恢复'}
                    </button>
                    {wwResumeInfo?.error && <div style={{ color: '#ff5252', marginTop: 4 }}>⚠️ {wwResumeInfo.error}</div>}
                    {wwResumeInfo?.ok && !wwResumeInfo.terminal && (
                      <div style={{ color: 'var(--accent)', marginTop: 4 }}>
                        ✅ 已恢复（{wwResumeInfo.restored ? '从快照重建' : '内存命中'}）· 阶段：{wwResumeInfo.phase}
                      </div>
                    )}
                    {wwResumeInfo?.ok && wwResumeInfo.terminal && (
                      <div style={{ marginTop: 4 }}>🏁 对局已结束（胜方：{wwResumeInfo.winner || '未知'}）</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </aside>
        )}

        {/* Script (剧本杀) game state panel */}
        {store.mode === 'script' && (
          <aside className="panel panel-werewolf">
            <div className="panel-body" style={{ padding: '8px' }}>
              {/* C4: 恢复对局（重连）入口 —— 输入 session_id / room_code + player_key */}
              <div className="ww-panel" style={{ marginBottom: 8 }}>
                <div
                  className="ww-panel-header"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setResumeOpen(!resumeOpen)}
                >
                  <span>🔄 恢复对局（重连）</span>
                  <span>{resumeOpen ? '▾' : '▸'}</span>
                </div>
                {resumeOpen && (
                  <div style={{ padding: '8px 10px', fontSize: 12 }}>
                    <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                      <input
                        className="input"
                        style={{ flex: 1, fontSize: 12 }}
                        placeholder="对局ID（session_id）"
                        value={resumeGameId}
                        onChange={e => setResumeGameId(e.target.value)}
                      />
                      <input
                        className="input"
                        style={{ flex: 1, fontSize: 12 }}
                        placeholder="或 房间码"
                        value={resumeRoomCode}
                        onChange={e => setResumeRoomCode(e.target.value.toUpperCase())}
                      />
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                      <input
                        className="input"
                        style={{ flex: 1, fontSize: 12 }}
                        placeholder="玩家 roleKey（重连凭证，DM 面板可查）"
                        value={resumePlayerKey}
                        onChange={e => setResumePlayerKey(e.target.value)}
                      />
                      <button className="btn btn-smallall btn-primary" disabled={resumeBusy} onClick={doScriptResume}>
                        {resumeBusy ? '恢复中...' : '恢复'}
                      </button>
                    </div>
                    {resumeInfo?.error && <div style={{ color: '#ff5252', marginBottom: 4 }}>⚠️ {resumeInfo.error}</div>}
                    {resumeInfo?.ok && !resumeInfo.terminal && (
                      <div style={{ color: 'var(--accent)', marginBottom: 4 }}>
                        ✅ 已恢复玩家 <strong>{resumeInfo.player}</strong> 的视图（{resumeInfo.restored ? '从快照重建' : '内存命中'}）· 阶段：{resumeInfo.phase}
                      </div>
                    )}
                    {resumeInfo?.ok && resumeInfo.terminal && (
                      <div className="card" style={{ marginTop: 4, padding: 8, background: 'var(--bg-2)', lineHeight: 1.6, color: 'var(--text-2)' }}>
                        <div style={{ marginBottom: 4 }}>🏁 <strong>对局已结束</strong>（终态结果）</div>
                        <div>被定罪：{resumeInfo.winner || '无'}</div>
                        <div>真凶：{resumeInfo.murderer || '未识别'}</div>
                        <div>判定：{resumeInfo.correct === true ? '✅ 成功找到真凶' : resumeInfo.correct === false ? '❌ 冤枉了好人' : '—'}</div>
                        {resumeInfo.truth && <div style={{ marginTop: 4 }}><strong>真相：</strong>{resumeInfo.truth}</div>}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <ScriptStatePanel
                state={scriptState}
                currentPlayer={store.currentPlayer}
                foundClues={scriptClues}
                publicClues={scriptPublicClues}
                reveal={scriptReveal}
                voteTarget={scriptVoteTarget}
                setVoteTarget={setScriptVoteTarget}
                simulation={scriptSimulation}
                busy={scriptBusy}
                searchMsg={scriptSearchMsg}
                transferTargets={transferTargets}
                setTransferTargets={setTransferTargets}
                onSearch={doScriptSearch}
                onTransferClue={doScriptTransferClue}
                onStartDiscussion={doScriptStartDiscussion}
                onStartVoting={doScriptStartVoting}
                onVote={doScriptVote}
                onResolve={doScriptResolve}
                onFinish={doScriptFinish}
                onOpen2D={toggleSimPanel}
              />
            </div>
          </aside>
        )}

        <main className="chat-main">
          {/* C-1：内嵌 2D 模拟面板（左地图 + 右聊天，可折叠；剧本杀「查看 2D 模拟」按钮联动开关） */}
          {showSimPanel && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
                  🗺️ 2D 模拟（左地图 · 右聊天）
                </span>
                <button className="btn btn-smallall btn-danger" onClick={toggleSimPanel}>✕ 关闭</button>
              </div>
              <PhaserSimulationView
                characters={simChars}
                scene="park"
                playerName={store.currentPlayer}
                height={420}
              />
            </div>
          )}
          {/* Loading progress bar */}
          {store.isRunning && (
            <>
              <div className="loading-bar-wrap">
                <div className="loading-bar-track">
                  <div className="loading-bar-fill" />
                </div>
              </div>
              <div className="loading-status-text">
                <span className="spinner" />
                <span>{store.mode === 'script' ? '🎭 剧本杀进行中...' : store.mode === 'werewolf' ? getLoadingText(store.werewolfPhase, store.werewolfMyRole) : '⏳ 运行中...'}</span>
              </div>
            </>
          )}

          {/* Phase guide banner */}
          {store.mode === 'werewolf' && (() => {
            const p = normalizePhase(store.werewolfPhase);
            return (
              <div className={`phase-banner ${phaseClassName(store.werewolfPhase)}`}>
                {PHASE_EMOJI[p] || '🎮'} 第 {store.werewolfRound} {PHASE_LABEL[p] || '阶段'}
                {' — '}{getPhaseGuide(store.werewolfPhase, store.werewolfMyRole)}
              </div>
            );
          })()}

          {/* Script phase banner */}
          {store.mode === 'script' && scriptState && (
            <div className="phase-banner phase-day">
              {SCRIPT_PHASE_EMOJI[scriptState.phase] || '🎮'} {SCRIPT_PHASE_LABEL[scriptState.phase] || scriptState.phase}
              {' — '}
              {scriptState.phase === 'investigation' && '在左侧面板选择地点搜证，收集线索后可进入讨论'}
              {scriptState.phase === 'discussion' && '交流线索、互相试探，时机成熟后进入投票'}
              {scriptState.phase === 'vote' && '在左侧面板选择你怀疑的真凶，然后揭晓真相'}
              {scriptState.phase === 'reveal' && '真相已揭晓，游戏结束'}
              {!['investigation', 'discussion', 'vote', 'reveal'].includes(scriptState.phase) && '剧本杀对局进行中'}
            </div>
          )}

          <div className="presence-bar">
            {store.agents.map(name => {
              const status = store.charStatuses[name] || 'offline';
              const statusLabels: Record<string, string> = { active: '活跃', silent: '静默', offline: '离线' };
              const isFiltered = store.historyFilter === name;
              return (
                <button key={name}
                  className={`presence-chip ${isFiltered ? 'active' : ''}`}
                  onClick={() => store.setHistoryFilter(isFiltered ? null : name)}
                >
                  <span className="avatar" style={{ background: colorFor(name) }}>{name[0]}</span>
                  <span className="presence-name">{name}</span>
                  <span className={`dot ${status}`} />
                  <span className="presence-status">{statusLabels[status]}</span>
                </button>
              );
            })}
          </div>

          <div ref={convRef} className="conversation">
            {visibleMessages.length === 0 ? (
              <div className="empty-state">
                <div className="empty-title">从一轮对话开始</div>
                <div>点击“推进一轮”让角色自动互动，或在底部输入主控旁白来改变节奏、补充事实、指定行动方向。</div>
  
              </div>
            ) : visibleMessages.map((msg, i) => {
              if (msg.role === 'system') {
                const match = msg.content.match(/第\s*(\d+)\s*轮完成/);
                const round = match ? Number(match[1]) : 0;
                return (
                  <div className="system-line" key={`${msg.timestamp}-${i}`}>
                    {msg.content}
                    {round > 0 && <button className="btn btn-smallall" style={{ marginLeft: 8 }} onClick={() => rollback(round)}>回滚</button>}
                  </div>
                );
              }
              if (msg.role === 'arbiter') {
                return (
                  <div className="arbiter-box" key={`${msg.timestamp}-${i}`}>
                    <div className="message-meta"><strong>主控整合</strong></div>
                    <div>{msg.content}</div>
                    {msg.round_number > 0 && (
                      <button className="btn btn-smallall" style={{ marginTop: 8 }} onClick={() => rollback(msg.round_number)}>回滚到此轮</button>
                    )}
                  </div>
                );
              }
              return <MessageView key={`${msg.timestamp}-${i}`} msg={msg} />;
            })}
          </div>

          {store.currentTasks.length > 0 && (
            <div className="task-box">
              <div className="label" style={{ marginBottom: 5 }}>本轮任务分配</div>
              {store.currentTasks.map((task, i) => (
                <div className="task-row" key={`${task.agent_name}-${i}`}><strong>{task.agent_name}</strong>：{task.task}</div>
              ))}
            </div>
          )}

          {store.ttsStatus && <div className="tts-indicator">{store.ttsStatus}</div>}
          <div className="composer">
            {store.werewolfWaitHuman && effectivePlayer() && (
              <div className="wait-human-banner" style={{ borderRadius: 4, marginBottom: 6 }}>
                🎯 轮到你了！以 <strong>{effectivePlayer()}</strong> 的身份发言
                <div className="ww-sub">
                  {getPhaseGuide(store.werewolfPhase, store.werewolfMyRole)}
                </div>
              </div>
            )}
            {store.mode !== 'werewolf' && <button className="btn round-actions" disabled={store.isRunning} onClick={startAuto}>三轮</button>}
            <button className="btn btn-danger round-actions" disabled={!store.isRunning && !autoPlay} onClick={() => { setAutoPlay(false); store.stop(); }}>结束</button>
            <input value={userInput} onChange={e => setUserInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder={composerPlaceholder()} />
            <button className="btn btn-icon mic-btn" onClick={() => startVoice(setUserInput)} title="语音输入">🎤</button>
            <button className="btn btn-primary" disabled={!userInput.trim()} onClick={send}>发送</button>
          </div>
        </main>

        {showHistory && <div className="drawer-overlay" onClick={() => setShowHistory(false)} />}
        <aside className={`panel drawer drawer-history ${showHistory ? 'open' : ''}`}>
          <HistoryPanel onClose={() => setShowHistory(false)} />
        </aside>

        {showDirector && <div className="drawer-overlay" onClick={() => setShowDirector(false)} />}
        <aside className={`panel drawer ${showDirector ? 'open' : ''}`}>
          <div className="panel-header">
            <h2 className="panel-title">🎬 导演面板</h2>
            <button className="btn btn-smallall" onClick={() => setShowDirector(false)}>✕</button>
          </div>
          <div className="panel-body">
            <div className="section">
              <details open>
                <summary className="label">剧情目标</summary>
                {store.goals.length === 0 ? <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>暂无目标，系统会自由推进。</div> : store.goals.map((goal, i) => (
                  <div className="goal-item" key={`${goal}-${i}`}>
                    <span>{goal}</span>
                    <button className="btn btn-smallall btn-icon" onClick={() => removeGoal(i)}>×</button>
                  </div>
                ))}
                <div className="form-row" style={{ marginTop: 8 }}>
                  <input style={{ flex: 1 }} value={goalInput} onChange={e => setGoalInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && addGoal()} placeholder="添加剧情目标" />
                  <button className="btn" onClick={addGoal}>添加</button>
                </div>
              </details>
            </div>

            <div className="section">
              <details open>
                <summary className="label">场景事实</summary>
                <div className="card" style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text-2)', marginTop: 8 }}>{store.sceneDescription || '暂无场景描述'}</div>
              </details>
            </div>

            <div className="section">
              <details>
                <summary className="label">当前轨道</summary>
                <div style={{ marginTop: 8 }}>
                {!latestTrackConfig ? <div className="muted" style={{ fontSize: 12 }}>推进一轮后显示轨道分配。</div> : latestTrackConfig.tracks.map(track => (
                  <div className="card" key={track.id} style={{ marginBottom: 6 }}>
                    <div className="section-row">
                      <strong>{track.label || track.id}</strong>
                      <span className="status-pill">{trackModeName(track.mode)}</span>
                    </div>
                    <div className="chip-list">
                      {track.agents.map(name => <span className="chip" key={name}>{name} · {track.agent_actions[name] || 'active'}</span>)}
                    </div>
                  </div>
                ))}
                </div>
              </details>
            </div>

            <div className="section">
              <details>
                <summary className="label">系统状态</summary>
                <div className="kv" style={{ marginTop: 8 }}>
                  <span>会话</span><strong>{store.sessionId || '未创建'}</strong>
                  <span>回合</span><strong>{store.currentRound}</strong>
                  <span>角色</span><strong>{store.agents.length}</strong>
                </div>
              </details>
            </div>
          </div>
        </aside>

        {/* C4: 主持人面板（DM）抽屉 —— 剧本杀模式专属 */}
        {showDm && <div className="drawer-overlay" onClick={() => setShowDm(false)} />}
        <aside className={`panel drawer ${showDm ? 'open' : ''}`}>
          <div className="panel-body" style={{ padding: '12px' }}>
            <ScriptDmPanel sessionId={scriptState?.session_id || ''} onClose={() => setShowDm(false)} />
          </div>
        </aside>
      </div>
    </div>
  );
}
