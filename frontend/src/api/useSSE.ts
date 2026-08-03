import { useEffect, useRef, useCallback } from 'react';

type SSEHandler = (eventType: string, data: any) => void;

/**
 * SSE 连接钩子。
 * @param onEvent 事件处理器
 * @param sessionId 可选会话标识（P-0802-I）：带 session_id 的连接只接收该对局的定向事件
 *   （werewolf_* 经 SSEController.broadcastToSession 定向推送），同时仍接收全部全局广播；
 *   为空时与旧版一致（全局广播全覆盖）。sessionId 变化时自动重连。
 */
export function useSSE(onEvent: SSEHandler, sessionId?: string) {
  const esRef = useRef<EventSource | null>(null);
  const reconnectRef = useRef(0);

  const connect = useCallback(() => {
    if (esRef.current) esRef.current.close();
    const url = sessionId
      ? `/api/events?session_id=${encodeURIComponent(sessionId)}`
      : '/api/events';
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => { reconnectRef.current = 0; };
    es.onerror = () => {
      es.close();
      reconnectRef.current++;
      const delay = Math.min(1000 * Math.pow(2, reconnectRef.current), 30000);
      setTimeout(connect, delay);
    };

    const events = ['round_start', 'arbiter_task', 'agent_output', 'agent_silent',
      'arbiter_integrate', 'round_complete', 'compression', 'user_input',
      'auto_complete', 'stopped', 'error', 'saved',
      // P-0802-M：LLM 流式增量（逐字渲染）
      'agent_token',
      'werewolf_wait_human', 'werewolf_phase', 'werewolf_player_update',
      'werewolf_my_role', 'werewolf_player_eliminated', 'werewolf_witch_info',
      'werewolf_game_over', 'werewolf_night_result', 'werewolf_vote_update',
      'werewolf_speech', 'werewolf_status', 'agent_added', 'agent_removed',
      'script_phase', 'script_status', 'script_reveal',
      'track_created', 'track_closed', 'phase_changed',
      'announcement',
      'tts_start', 'tts_chunk', 'tts_end', 'tts_error'];
    events.forEach(evt => {
      es.addEventListener(evt, (e: MessageEvent) => {
        try { onEvent(evt, JSON.parse(e.data)); } catch {}
      });
    });
  }, [onEvent, sessionId]);

  useEffect(() => {
    connect();
    return () => { esRef.current?.close(); };
  }, [connect]);
}
