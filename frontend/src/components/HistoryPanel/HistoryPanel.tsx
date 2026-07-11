import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useAppStore } from '../../store/appStore';

interface SessionInfo {
  session_id: string;
  created_at: string;
  updated_at: string;
  round_count: number;
  message_count: number;
  agent_names: string[];
}

interface SessionMessages {
  session_id: string;
  messages: any[];
  total: number;
  round_logs: any[];
}

export function HistoryPanel({ onClose }: { onClose: () => void }) {
  const store = useAppStore();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<SessionMessages | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = async () => {
    setLoading(true);
    try {
      const data = await api.getHistorySessions();
      setSessions(data.sessions || []);
    } catch (e: any) {
      console.error('Failed to load sessions:', e);
    } finally {
      setLoading(false);
    }
  };

  const viewSession = async (sessionId: string) => {
    setSelectedSession(sessionId);
    setLoadingSession(true);
    setLoadError('');
    try {
      const data = await api.getHistorySessionMessages(sessionId);
      setSessionMessages(data);
    } catch (e: any) {
      setLoadError(e.message || '加载失败');
      setSessionMessages(null);
    } finally {
      setLoadingSession(false);
    }
  };

  const loadSession = async (sessionId: string) => {
    setLoadError('');
    try {
      const data = await api.loadHistorySession(sessionId);
      store.addSystemMsg(`已加载历史会话：${sessionId}（第${data.round}轮，${data.agents?.length || 0}个角色）`);
      // Refresh state
      await store.loadState();
      await store.loadHistory();
      onClose();
    } catch (e: any) {
      setLoadError(e.message || '加载失败');
    }
  };

  const formatDate = (isoStr: string) => {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      return d.toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return isoStr.slice(0, 16);
    }
  };

  const currentSessionId = store.sessionId;

  return (
    <div className="history-panel">
      <div className="history-panel-header">
        <h3>📋 历史会话</h3>
        <button className="btn btn-small" onClick={onClose}>✕</button>
      </div>

      {loadError && (
        <div className="error-banner" style={{ padding: '8px 12px', fontSize: 12, color: '#ff5252', background: 'rgba(255,82,82,0.1)' }}>
          {loadError}
        </div>
      )}

      {/* Session list */}
      <div className="history-session-list">
        <div className="history-list-header">
          <span>会话列表</span>
          <button className="btn btn-small" onClick={loadSessions} disabled={loading}>
            {loading ? '⟳' : '↻'}
          </button>
        </div>

        {loading && sessions.length === 0 ? (
          <div className="history-empty">加载中...</div>
        ) : sessions.length === 0 ? (
          <div className="history-empty">暂无历史会话</div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.session_id}
              className={`history-session-item ${selectedSession === s.session_id ? 'selected' : ''} ${currentSessionId === s.session_id ? 'current' : ''}`}
              onClick={() => viewSession(s.session_id)}
            >
              <div className="history-session-id" title={s.session_id}>
                {s.session_id.replace('roleplay_', '').replace('script_', '').replace('werewolf_', '')}
              </div>
              <div className="history-session-meta">
                <span>{s.round_count}轮</span>
                <span>{s.message_count}条</span>
                <span>{s.agent_names?.length || 0}人</span>
              </div>
              <div className="history-session-date">{formatDate(s.updated_at || s.created_at)}</div>
              {currentSessionId === s.session_id && (
                <div className="history-session-current-badge">当前</div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Message preview for selected session */}
      {selectedSession && (
        <div className="history-message-preview">
          <div className="history-preview-header">
            <span>消息预览</span>
            <button
              className="btn btn-small btn-primary"
              onClick={() => loadSession(selectedSession)}
              disabled={loadingSession}
            >
              加载此会话
            </button>
          </div>

          {loadingSession ? (
            <div className="history-empty">加载消息中...</div>
          ) : sessionMessages ? (
            <div className="history-preview-messages">
              {sessionMessages.messages.slice(-30).map((msg: any, i: number) => (
                <div key={i} className={`history-preview-msg role-${msg.role || 'system'}`}>
                  <span className="history-preview-name">{msg.name || msg.role}</span>
                  <span className="history-preview-content">
                    {msg.content?.length > 120 ? msg.content.slice(0, 120) + '…' : msg.content}
                  </span>
                </div>
              ))}
              {sessionMessages.messages.length > 30 && (
                <div className="history-preview-more">
                  ... 共 {sessionMessages.total} 条消息（显示最近30条）
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
