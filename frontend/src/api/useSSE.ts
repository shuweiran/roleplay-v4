import { useEffect, useRef, useCallback } from 'react';

type SSEHandler = (eventType: string, data: any) => void;

export function useSSE(onEvent: SSEHandler) {
  const esRef = useRef<EventSource | null>(null);
  const reconnectRef = useRef(0);

  const connect = useCallback(() => {
    if (esRef.current) esRef.current.close();
    const es = new EventSource('/api/events');
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
      'werewolf_wait_human', 'werewolf_phase', 'werewolf_player_update',
      'werewolf_my_role', 'werewolf_player_eliminated', 'werewolf_witch_info',
      'werewolf_game_over', 'agent_added', 'agent_removed',
      'track_created', 'track_closed', 'phase_changed',
      'tts_start', 'tts_chunk', 'tts_end', 'tts_error'];
    events.forEach(evt => {
      es.addEventListener(evt, (e: MessageEvent) => {
        try { onEvent(evt, JSON.parse(e.data)); } catch {}
      });
    });
  }, [onEvent]);

  useEffect(() => {
    connect();
    return () => { esRef.current?.close(); };
  }, [connect]);
}
