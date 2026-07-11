import { useEffect, useMemo, useRef, useState } from 'react';
import { HistoryPanel } from '../HistoryPanel/HistoryPanel';
import { useAppStore } from '../../store/appStore';
import { api } from '../../api/client';
import type { AppMessage, WerewolfPhase } from '../../types';

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

function RoundSystemLine({ msg, onRollback }: { msg: AppMessage; onRollback: (round: number) => void }) {
  const match = msg.content.match(/第\s*(\d+)\s*轮完成/);
  const round = match ? Number(match[1]) : 0;
  return (
    <div className="system-line">
      {msg.content}
      {round > 0 && <button className="btn btn-small" style={{ marginLeft: 8 }} onClick={() => onRollback(round)}>回滚</button>}
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
        <div className="bubble">{msg.content}</div>
      </div>
    </div>
  );
}

export function ChatPage() {
  const store = useAppStore();
  const [goalInput, setGoalInput] = useState('');
const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [userInput, setUserInput] = useState('');
  const [showDirector, setShowDirector] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const convRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (convRef.current) convRef.current.scrollTop = convRef.current.scrollHeight;
  }, [store.messages.length]);

  // Auto-play: when round completes, continue if no human wait needed
  useEffect(() => {
    if (!autoPlay) return;
    if (store.isRunning) return;

    if (store.mode === 'werewolf') {
      if (store.werewolfPhase === 'ended' || store.werewolfPhase === 'game_over') return;
      if (store.werewolfWaitHuman) return;
      if (autoTimerRef.current) return;
      autoTimerRef.current = setTimeout(() => {
        autoTimerRef.current = null;
        const s = useAppStore.getState();
        if (s.werewolfWaitHuman || s.werewolfPhase === 'ended' || s.werewolfPhase === 'game_over') return;
        s.startRound(1);
      }, 500);
    } else {
      // Free / non-werewolf mode: reset autoPlay once round completes
      setAutoPlay(false);
    }
  }, [autoPlay, store.isRunning, store.werewolfWaitHuman, store.werewolfPhase, store.mode]);

  useEffect(() => {
    return () => { if (autoTimerRef.current) clearTimeout(autoTimerRef.current); };
  }, []);

  const handleStartGame = () => {
    setAutoPlay(true);
    store.startRound(1);
  };

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
      // Stop current round so main control input can take effect immediately
      await store.stop();
    }
    // Determine player name for werewolf mode
    const isWW = store.mode === 'werewolf';
    const playerName = isWW
      ? store.currentPlayer
      : (store.directorCharacter && store.directorCharacter !== '系统')
        ? store.directorCharacter
        : (store.agents.includes('me') ? 'me' : '');
    // Optimistically show the message immediately, before SSE events arrive
    if (isWW) {
      store.addAgentMsg(playerName, text);
    } else if (playerName && store.agents.includes(playerName)) {
      // If playerName is an agent, show message as that character speaking
      store.addAgentMsg(playerName, text);
    } else {
      // Otherwise show as user input (主控旁白)
      store.addUserMsg(text);
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
    if (store.agents.includes('me')) return '以 me 的身份发言...';
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
        <button className="btn" onClick={() => store.goToView('scene')}>场景</button>
        <button className="btn" onClick={() => store.goToView('config')}>角色库</button>
        <button className={`btn ${showHistory ? 'btn-primary' : ''}`} onClick={() => setShowHistory(!showHistory)}>📋 历史</button>
      </header>

      <div className={`workspace${store.mode === 'werewolf' ? ' werewolf-mode' : ''}`}>
        <aside className="panel panel-left">
          <div className="panel-body">
            <div className="section">
              <div className="label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>角色</span>
                <button className="btn btn-small btn-primary"
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
                <button className={`btn btn-small ${!store.historyFilter ? 'btn-primary' : ''}`} onClick={() => store.setHistoryFilter(null)}>全部</button>
                {store.agents.map(name => {
                  const active = store.historyFilter === name;
                  return (
                    <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <button className={`actor-chip ${active ? 'selected' : ''}`} onClick={() => store.setHistoryFilter(active ? null : name)}>
                        {name}
                      </button>
                      <button className="btn btn-small btn-icon"
                        onClick={async () => {
                          const newVal = !voiceEnabled;
                          setVoiceEnabled(newVal);
                          await fetch('/api/voice/toggle', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ voice_enabled: newVal }),
                          });
                        }}
                        style={{
                          padding: '0 4px', fontSize: 11, lineHeight: '20px', height: 20,
                          color: voiceEnabled ? '#7c4dff' : '#888',
                          background: voiceEnabled ? '#7c4dff22' : 'transparent',
                          border: '1px solid ' + (voiceEnabled ? '#7c4dff55' : '#444'),
                        }}
                        title={voiceEnabled ? '关闭语音' : '开启语音'}>
                        {voiceEnabled ? '🔊' : '🔇'}
                      </button>
                      <button className="btn btn-small btn-icon"
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
            </div>
          </aside>
        )}

        <main className="chat-main">
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
                <span>{getLoadingText(store.werewolfPhase, store.werewolfMyRole)}</span>
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
                    {round > 0 && <button className="btn btn-small" style={{ marginLeft: 8 }} onClick={() => rollback(round)}>回滚</button>}
                  </div>
                );
              }
              if (msg.role === 'arbiter') {
                return (
                  <div className="arbiter-box" key={`${msg.timestamp}-${i}`}>
                    <div className="message-meta"><strong>主控整合</strong></div>
                    <div>{msg.content}</div>
                    {msg.round_number > 0 && (
                      <button className="btn btn-small" style={{ marginTop: 8 }} onClick={() => rollback(msg.round_number)}>回滚到此轮</button>
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
            <button className="btn btn-primary round-actions" disabled={store.isRunning || autoPlay} onClick={handleStartGame}>开始游戏</button>
            {store.mode !== 'werewolf' && <button className="btn round-actions" disabled={store.isRunning} onClick={startAuto}>三轮</button>}
            <button className="btn btn-danger round-actions" disabled={!store.isRunning && !autoPlay} onClick={() => { setAutoPlay(false); store.stop(); }}>结束</button>
            <input value={userInput} onChange={e => setUserInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder={composerPlaceholder()} />
            <button className="btn btn-icon mic-btn" onClick={() => startVoice(setUserInput)} title="语音输入">🎤</button>
            <button
              className={`btn btn-icon ${store.voiceRunning ? 'active' : ''}`}
              onClick={() => store.voiceRunning ? store.stopVoice() : store.startVoice()}
              title={store.voiceRunning ? `语音闭环运行中 (${store.voiceState}) — 点击停止` : '启动语音闭环'}
              style={{ background: store.voiceRunning ? '#49c16d' : undefined }}
            >
              {store.voiceRunning ? '🔊' : '🔇'}
            </button>
            <button className="btn btn-primary" disabled={!userInput.trim()} onClick={send}>发送</button>
            <button className="btn btn-icon" onClick={() => setShowDirector(true)} title="导演面板">⚙️</button>
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
            <button className="btn btn-small" onClick={() => setShowDirector(false)}>✕</button>
          </div>
          <div className="panel-body">
            <div className="section">
              <details open>
                <summary className="label">剧情目标</summary>
                {store.goals.length === 0 ? <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>暂无目标，系统会自由推进。</div> : store.goals.map((goal, i) => (
                  <div className="goal-item" key={`${goal}-${i}`}>
                    <span>{goal}</span>
                    <button className="btn btn-small btn-icon" onClick={() => removeGoal(i)}>×</button>
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
      </div>
    </div>
  );
}
