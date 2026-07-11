import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { api } from '../../api/client';

interface SessionInfo {
  session_id: string;
  created_at: string;
  updated_at: string;
  round_count: number;
  message_count: number;
  agent_names: string[];
  scene_title?: string;
}

export function HomePage() {
  const goToView = useAppStore(s => s.goToView);
  const setMode = useAppStore(s => s.setMode);
  const logout = useAppStore(s => s.logout);
  const store = useAppStore();
  const [selectedMode, setSelectedMode] = useState<'free' | 'game' | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [playerName, setPlayerName] = useState(store.currentPlayer);
  const [joinCode, setJoinCode] = useState(store.roomCode);
  const [roomBusy, setRoomBusy] = useState(false);

  useEffect(() => { loadSessions(); }, []);

  const loadSessions = async () => {
    setLoading(true);
    try {
      const data = await api.getHistorySessions();
      setSessions(data.sessions || []);
    } catch (e: any) { console.error(e); }
    finally { setLoading(false); }
  };

  const loadSession = async (sessionId: string) => {
    setLoadErr('');
    try {
      await api.loadHistorySession(sessionId);
      await store.loadState();
      await store.loadHistory();
      goToView('chat');
    } catch (e: any) { setLoadErr(e.message || '加载失败'); }
  };

  const handleStart = async () => {
    if (!selectedMode) return;
    store.setCurrentPlayer(playerName);
    const m = selectedMode === 'free' ? 'free' : 'rules';
    await setMode(m);
    goToView('scene');
  };

  const createRoom = async () => {
    setRoomBusy(true);
    try { await store.createRoom(playerName); }
    finally { setRoomBusy(false); }
  };

  const joinRoom = async () => {
    if (!joinCode.trim()) return;
    setRoomBusy(true);
    try { await store.joinRoom(joinCode, playerName); }
    finally { setRoomBusy(false); }
  };

  const leaveRoom = async () => {
    setRoomBusy(true);
    try { await store.leaveRoom(); }
    finally { setRoomBusy(false); }
  };

  const experiences = [
    { id: 'free' as const, icon: '🎭', title: '一般模式', desc: '自由对话 / 角色扮演 / 私聊', detail: '选择角色和场景自由对话。2人以下无主控，2人以上主控自动登场协调剧情。' },
    { id: 'game' as const, icon: '🎲', title: '狼人杀模式', desc: '狼人杀（测试中）', detail: '经典狼人杀游戏，包含身份分配、昼夜交替、投票出局。⚠️ 功能尚不稳定。' },
  ];

  const formatDate = (isoStr: string) => {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch { return isoStr.slice(0, 16); }
  };

  const currentSessionId = store.sessionId;

  return (
    <div className="home-page">
      <div className="home-sidebar">
        <div className="home-logo">
          <div className="brand-mark">R</div>
          <span>Roleplay v4</span>
        </div>
        <div className="home-recent-list">
          <h4>最近故事
            <button className="btn-text btn-refresh" onClick={loadSessions} disabled={loading} style={{ marginLeft: 8, fontSize: 12 }}>
              {loading ? '...' : '刷新'}
            </button>
          </h4>
          <div className="recent-list-scroll">
            {sessions.length === 0 ? (
              <div className="recent-empty-small"><p>{loading ? '加载中...' : '还没有故事'}</p></div>
            ) : (
              sessions.slice(0, 20).map(s => (
                <div
                  key={s.session_id}
                  className={`recent-item ${currentSessionId === s.session_id ? 'current' : ''}`}
                  onClick={() => loadSession(s.session_id)}
                  title={`${s.round_count}轮 · ${s.message_count}条`}
                >
                  <div className="recent-item-name">
                    {s.scene_title || s.agent_names?.slice(0, 3).join('、') || '无角色'}
                  </div>
                  <div className="recent-item-meta">{s.round_count}轮 · {formatDate(s.updated_at || s.created_at)}</div>
                </div>
              ))
            )}
            {loadErr && <div className="recent-item" style={{ color: '#ff5252', fontSize: 11 }}>{loadErr}</div>}
          </div>
        </div>
        <div className="home-sidebar-footer">
          <button className="btn-text" onClick={() => goToView('config')} style={{ marginRight: 8 }}>⚙️ 设置</button>
          <button className="btn-text" onClick={logout}>退出登录</button>
        </div>
      </div>
      <div className="home-main">
        <div className="home-header-mini">
          <h1>创建故事</h1>
          <p>你想怎么开始？</p>
        </div>
        <div className="room-panel">
          <div className="room-panel-head">
            <div>
              <div className="room-title">联机房间</div>
              <div className="room-subtitle">同一房间的玩家会作为真人角色加入狼人杀</div>
            </div>
            {store.roomCode && <span className="status-pill good">房间 {store.roomCode}</span>}
          </div>
          <div className="room-row">
            <input value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="你的玩家名，如 me / 小王" />
            <button className="btn btn-primary" disabled={roomBusy || !playerName.trim()} onClick={createRoom}>创建房间</button>
            <input value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} placeholder="房间码" style={{ width: 110 }} />
            <button className="btn" disabled={roomBusy || !joinCode.trim()} onClick={joinRoom}>加入</button>
            {store.roomCode && <button className="btn btn-danger" disabled={roomBusy} onClick={leaveRoom}>离开</button>}
          </div>
          {store.roomCode && (
            <div className="room-players">
              {(store.onlinePlayers.length ? store.onlinePlayers : [store.currentPlayer]).map(name => (
                <span key={name} className={`chip ${name === store.currentPlayer ? 'selected' : ''}`}>{name}{name === store.currentPlayer ? ' · 我' : ''}</span>
              ))}
            </div>
          )}
          {store.roomError && <div className="status-pill warn">{store.roomError}</div>}
        </div>
        <div className="experience-cards">
          {experiences.map(exp => (
            <button
              key={exp.id}
              className={`experience-card ${selectedMode === exp.id ? 'selected' : ''}`}
              onClick={() => setSelectedMode(selectedMode === exp.id ? null : exp.id)}
            >
              <div className="exp-icon">{exp.icon}</div>
              <div className="exp-body">
                <div className="exp-title">{exp.title}</div>
                <div className="exp-desc">{exp.desc}</div>
                {selectedMode === exp.id && <div className="exp-detail">{exp.detail}</div>}
              </div>
            </button>
          ))}
        </div>
        <div className="home-start">
          <button className="btn btn-primary btn-large" disabled={!selectedMode} onClick={handleStart}>
            {selectedMode ? `进入${experiences.find(e => e.id === selectedMode)?.title || ''}` : '请选择一种模式'}
          </button>
        </div>
      </div>
    </div>
  );
}
