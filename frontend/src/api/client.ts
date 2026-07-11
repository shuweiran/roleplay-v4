const BASE = '';

const _controllers = new Map<number, AbortController>();
let _id = 0;

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  if (token) {
    return { 'Authorization': `Bearer ${token}` };
  }
  return {};
}

async function request<T>(url: string, options?: RequestInit & { timeout?: number }): Promise<T> {
  const controller = new AbortController();
  const cid = ++_id;
  _controllers.set(cid, controller);

  const timeout = options?.timeout || 60000;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${BASE}${url}`, {
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      signal: controller.signal,
      ...options,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
    _controllers.delete(cid);
  }
}

export function cancelAllRequests() {
  _controllers.forEach(c => c.abort());
  _controllers.clear();
}

export const api = {
  cancelAll: cancelAllRequests,
  verifyCode: (code: string) => request<any>('/api/auth/verify', {
    method: 'POST', body: JSON.stringify({ code }),
  }),
  getMe: () => request<any>('/api/auth/me'),
  getState: () => request<any>('/api/state'),
  init: (data?: any) => request<any>('/api/init', { method: 'POST', body: JSON.stringify(data || {}) }),
  createCharacter: (data: any) => request<any>('/api/characters', { method: 'POST', body: JSON.stringify(data) }),
  updateCharacter: (oldName: string, data: any) => request<any>(`/api/characters/${encodeURIComponent(oldName)}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteCharacter: (name: string) => request<any>(`/api/characters/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  createScene: (data: any) => request<any>('/api/scenes', { method: 'POST', body: JSON.stringify(data) }),
  updateScene: (id: string, data: any) => request<any>(`/api/scenes/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteScene: (id: string) => request<any>(`/api/scenes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  generateScene: (keywords: string) => request<any>('/api/scenes/generate', { method: 'POST', body: JSON.stringify({ keywords }) }),
  generateCharacter: (keywords: string) => request<any>('/api/characters/generate', { method: 'POST', body: JSON.stringify({ keywords }) }),
  startScene: (sceneId: string, agents: string[]) =>
    request<any>(`/api/scenes/${encodeURIComponent(sceneId)}/start?agents=${encodeURIComponent(agents.join(','))}`, { method: 'POST' }),
  startRound: (turns: number = 1) => request<any>('/api/round/start', { method: 'POST', body: JSON.stringify({ turns }) }),
  rollback: (round: number) => request<any>('/api/round/rollback', { method: 'POST', body: JSON.stringify({ round }) }),
  send: (text: string, playerName?: string) => request<any>('/api/send', { method: 'POST', body: JSON.stringify({ text, player_name: playerName || '' }) }),
  stop: () => request<any>('/api/stop', { method: 'POST' }),
  setMode: (mode: string, protagonist?: string, directorCharacter?: string) => request<any>('/api/mode', { method: 'POST', body: JSON.stringify({ mode, protagonist: protagonist || '', director_character: directorCharacter || '' }) }),
  setGoals: (goals: string[]) => request<any>('/api/goals', { method: 'POST', body: JSON.stringify({ goals }) }),
  getGoals: () => request<any>('/api/goals'),
  getHistory: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any>(`/api/history${qs}`);
  },
  getHistorySessions: () => request<any>('/api/history/sessions'),
  getHistorySessionMessages: (sessionId: string, params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any>(`/api/history/sessions/${encodeURIComponent(sessionId)}${qs}`);
  },
  loadHistorySession: (sessionId: string) => request<any>(`/api/history/load/${encodeURIComponent(sessionId)}`, { method: 'POST' }),
  addAgent: (name: string) => request<any>('/api/agents', { method: 'POST', body: JSON.stringify({ name }) }),
  removeAgent: (name: string) => request<any>(`/api/agents/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  createRoom: (playerName: string, mode = 'rules') => request<any>('/api/rooms', { method: 'POST', body: JSON.stringify({ player_name: playerName, mode }) }),
  joinRoom: (code: string, playerName: string, mode = 'rules') => request<any>(`/api/rooms/${encodeURIComponent(code)}/join`, { method: 'POST', body: JSON.stringify({ player_name: playerName, mode }) }),
  getRoom: (code: string) => request<any>(`/api/rooms/${encodeURIComponent(code)}`),
  leaveRoom: (code: string, playerName: string) => request<any>(`/api/rooms/${encodeURIComponent(code)}/leave`, { method: 'POST', body: JSON.stringify({ player_name: playerName }) }),
  assignRoomCharacters: (code: string, characters: string[]) => request<any>(`/api/rooms/${encodeURIComponent(code)}/assign`, { method: 'POST', body: JSON.stringify({ characters }) }),
  werewolfInit: (playerName: string, humanPlayers: string[] = []) => request<any>(`/api/werewolf/init?player_name=${encodeURIComponent(playerName)}&human_players=${encodeURIComponent(humanPlayers.join(','))}`, { method: 'POST' }),
  werewolfStatus: (playerName: string) => request<any>(`/api/werewolf/status?player_name=${encodeURIComponent(playerName)}`),
  // Voice loop
  voiceStatus: () => request<any>('/api/voice/status'),
  voiceStart: () => request<any>('/api/voice/start', { method: 'POST' }),
  voiceStop: () => request<any>('/api/voice/stop', { method: 'POST' }),
  getApiKeyConfig: () => request<any>('/api/config/apikey'),
  setApiKeyConfig: (apiKey: string, apiBase?: string, model?: string) =>
    request<any>('/api/config/apikey', { method: 'POST', body: JSON.stringify({ api_key: apiKey, api_base: apiBase || '', model: model || '' }) }),
};
