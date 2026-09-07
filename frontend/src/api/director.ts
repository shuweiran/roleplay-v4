type Json = Record<string, any>;

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function directorRequest<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
  return data as T;
}

export const directorApi = {
  createPreflight: (body: Json) => directorRequest('/api/director/preflight', {
    method: 'POST', body: JSON.stringify(body),
  }),

  preflightChat: (preflightId: string, text: string) =>
    directorRequest(`/api/director/preflight/${encodeURIComponent(preflightId)}/chat`, {
      method: 'POST', body: JSON.stringify({ text }),
    }),

  getPreflight: (preflightId: string) =>
    directorRequest(`/api/director/preflight/${encodeURIComponent(preflightId)}`),

  runtimeChat: (text: string) => directorRequest('/api/director/chat', {
    method: 'POST', body: JSON.stringify({ text }),
  }),

  runtimeState: () => directorRequest('/api/director/state'),

  startScene: (
    sceneId: string,
    agents: string[],
    me: string | undefined,
    characters: Json[],
    preflightId: string,
    sceneDescription = '',
  ) => {
    const qs = `?agents=${encodeURIComponent(agents.join(','))}${me ? `&me=${encodeURIComponent(me)}` : ''}`;
    return directorRequest(`/api/scenes/${encodeURIComponent(sceneId)}/start${qs}`, {
      method: 'POST',
      body: JSON.stringify({
        agents,
        me: me || '',
        characters,
        preflight_id: preflightId,
        scene_description: sceneDescription,
      }),
    });
  },
};
