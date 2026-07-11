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
  const playerName = store.currentPlayer;
  const [showSettings, setShowSettings] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiBase, setApiBase] = useState('https://api.deepseek.com');
  const [model, setModel] = useState('deepseek-chat');
  const [language, setLanguage] = useState('zh');
  const [settingsMsg, setSettingsMsg] = useState('');

  useEffect(() => { loadSessions(); }, []);

  useEffect(() => {
    api.getApiKeyConfig().then(d => {
      if (d.api_base) setApiBase(d.api_base);
      if (d.model) setModel(d.model);
      if (d.language) setLanguage(d.language);
      setApiKey('');  // API key stays empty in UI (secret)
    }).catch(() => {});
  }, []);

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

  const handleSaveSettings = async () => {
    try {
      await api.setApiKeyConfig(apiKey, apiBase, model, language);
      setSettingsMsg('设置已保存');
      setTimeout(() => setSettingsMsg(''), 2000);
    } catch (e: any) {
      setSettingsMsg('保存失败: ' + (e.message || ''));
    }
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
        {/* 展开式设置面板 */}
        <div className="home-settings-panel">
          <button className="btn btn-text" onClick={() => setShowSettings(!showSettings)} style={{ marginBottom: 8 }}>
            {showSettings ? '收起设置 ▲' : '⚙️ 展开设置 ▼'}
          </button>
          
          {showSettings && (
            <div className="settings-inline">
              <div className="settings-inline-row">
                <div className="settings-inline-item">
                  <label>🔑 API Key</label>
                  <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-... 或你的 API Key" />
                </div>
                <div className="settings-inline-item">
                  <label>🌐 API 地址</label>
                  <input value={apiBase} onChange={e => setApiBase(e.target.value)} placeholder="https://api.deepseek.com" />
                </div>
                <div className="settings-inline-item">
                  <label>🧠 模型</label>
                  <input value={model} onChange={e => setModel(e.target.value)} placeholder="deepseek-chat" />
                </div>
                <div className="settings-inline-item">
                  <label>🔤 语言</label>
                  <select value={language} onChange={e => setLanguage(e.target.value)}>
                    <option value="zh">中文</option>
                    <option value="en">English</option>
                  </select>
                </div>
              </div>
              <button className="btn btn-sm btn-primary" onClick={handleSaveSettings}>保存设置</button>
              <span style={{ marginLeft: 8, fontSize: 12, color: '#888' }}>{settingsMsg}</span>
            </div>
          )}
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
