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
    // P1-6：后端 DELETE（/api/scenes/{id}、/api/characters/{name} 等）返回 200 空 body，
    // 原无条件 res.json() 会抛 "Failed to execute 'json' on 'Response': Unexpected end of JSON input"。
    // 改为：空 body → 返回 null（调用方视为成功）；有 body → JSON 解析，非 JSON 也按成功空结果处理。
    const text = await res.text();
    if (!text) return null as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // 200 但内容不是合法 JSON（如空字符串/纯文本）→ 不崩，视为成功空结果
      return null as unknown as T;
    }
  } finally {
    clearTimeout(timer);
    _controllers.delete(cid);
  }
}

export function cancelAllRequests() {
  _controllers.forEach(c => c.abort());
  _controllers.clear();
}

/**
 * P-0802-P1-demo：玩家身份模型（改造方案 §3.1）——player_id 客户端生成 + localStorage 持久化。
 * 同一浏览器身份稳定：首次 crypto.randomUUID() 生成，之后复用；与 appStore 同键（'playerId'）读写。
 */
export function getPlayerId(): string {
  let pid = localStorage.getItem('playerId');
  if (!pid) {
    pid = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : 'pid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('playerId', pid);
  }
  return pid;
}

/**
 * G2（P-0802-M）：剧本杀对局 session_id 读取 —— appStore.setScriptSessionId 写入时镜像到
 * localStorage（避免 api↔store 循环依赖）；script 四端点（start_discussion/start_voting/
 * resolve/finish）据此携带真实 session_id，修复硬编码 '' 阻断讨论推进的缺陷。
 */
function getScriptSessionId(): string {
  try { return localStorage.getItem('scriptSessionId') || ''; } catch { return ''; }
}

/**
 * P-0802-P4（改造方案 §3.2）：已绑定角色名读取 —— appStore.setBoundCharacterName 写入时镜像到
 * localStorage（对齐 getPlayerId/getScriptSessionId 先例，避免 api↔store 循环依赖）。
 * 用途：① createCharacter 仅当无绑定角色时携带 player_id（第一个角色自动绑定为「玩家本人角色」，
 * 之后创建的不携带 → 不受「一玩家一角色」唯一约束，消除 409 副作用）；
 * ② updateCharacter 仅编辑已绑定角色时携带 player_id（保留绑定）；编辑未绑定角色不携带。
 */
function getBoundCharacterName(): string {
  try { return localStorage.getItem('boundCharacterName') || ''; } catch { return ''; }
}

export const api = {
  cancelAll: cancelAllRequests,
  verifyCode: (code: string) => request<any>('/api/auth/verify', {
    method: 'POST', body: JSON.stringify({ code }),
  }),
  getMe: () => request<any>('/api/auth/me'),
  getState: () => request<any>('/api/state'),
  init: (data?: any) => request<any>('/api/init', { method: 'POST', body: JSON.stringify(data || {}) }),
  createCharacter: (data: any) => request<any>('/api/characters', {
    method: 'POST',
    // P-0802-P4（改造方案 §6 Phase 4）：仅当当前无绑定角色时携带 player_id —— 第一个创建的角色
    // 自动绑定为「玩家本人角色」；之后创建的新角色不携带 player_id（普通 NPC 角色，不受
    // 「一玩家一角色」唯一约束，消除 Phase 1 遗留的 409 副作用）；data 显式提供时以 data 为准
    body: JSON.stringify({ ...(!getBoundCharacterName() ? { player_id: getPlayerId() } : {}), ...data }),
  }),
  updateCharacter: (oldName: string, data: any) => request<any>(`/api/characters/${encodeURIComponent(oldName)}`, {
    method: 'PUT',
    // P-0802-P4（改造方案 §6 Phase 4）：仅编辑已绑定的本人角色时携带 player_id（保留绑定）；
    // 编辑未绑定角色不携带（普通 NPC 编辑，不触发绑定校验）；data 显式提供时以 data 为准
    body: JSON.stringify({ ...(oldName === getBoundCharacterName() ? { player_id: getPlayerId() } : {}), ...data }),
  }),
  /**
   * P-0802-P4（改造方案 §4.1 新端点）：玩家本人角色（已绑定 player_id）局中改名 ——
   * 后端编排 角色库改名 + Router/2D/狼人杀/剧本杀四处运行态同步 + 撞名校验② + 失败回滚。
   * 仅绑定角色改名调用；非绑定角色改名仍走 updateCharacter（PUT /api/characters/{name}，无局中同步，降级可接受）。
   */
  playerRename: (oldName: string, newName: string) => request<any>('/api/player/rename', {
    method: 'POST',
    body: JSON.stringify({ player_id: getPlayerId(), old_name: oldName, new_name: newName }),
  }),
  deleteCharacter: (name: string) => request<any>(`/api/characters/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  createScene: (data: any) => request<any>('/api/scenes', { method: 'POST', body: JSON.stringify(data) }),
  updateScene: (id: string, data: any) => request<any>(`/api/scenes/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteScene: (id: string) => request<any>(`/api/scenes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  generateScene: (keywords: string) => request<any>('/api/scenes/generate', { method: 'POST', body: JSON.stringify({ keywords }) }),
  generateCharacter: (keywords: string) => request<any>('/api/characters/generate', { method: 'POST', body: JSON.stringify({ keywords }) }),
  startScene: (sceneId: string, agents: string[], me?: string, characterDetails?: Array<{ name: string; persona?: string; voice?: string; background?: string }>) => {
    // Keep query params for backward compatibility (backend accepts both query + body)
    const qs = `?agents=${encodeURIComponent(agents.join(','))}${me ? `&me=${encodeURIComponent(me)}` : ''}`;
    return request<any>(`/api/scenes/${encodeURIComponent(sceneId)}/start${qs}`, {
      method: 'POST',
      body: JSON.stringify({ agents, me: me || '', characters: characterDetails || [] }),
    });
  },
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
  /** P-0802-C：狼人杀 init 改 JSON body 全量进局（players=真人+AI 全集，roles=职业配置按玩家映射）。
   *  修复根因（调研报告 §二）：原 query 方式 human_players 未建房=空 → 1 人村民死局、AI 从未进 GameState；
   *  职业配置原走 query 被后端静默丢弃。注意 roles 值须用后端枚举名（werewolf/seer/witch/hunter/villager）。 */
  werewolfInit: (playerName: string, players: string[], roles?: Record<string, string>, roomCode?: string) =>
    request<any>(`/api/werewolf/init?player_name=${encodeURIComponent(playerName)}`, {
      method: 'POST',
      body: JSON.stringify({ players, roles: roles || {}, ...(roomCode ? { room_code: roomCode } : {}) }),
    }),
  /** P-0802-I：status 支持显式 session_id（重连/多局场景按对局定位，优先于玩家名反查） */
  werewolfStatus: (playerName: string, sessionId?: string) =>
    request<any>(`/api/werewolf/status?player_name=${encodeURIComponent(playerName)}${sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ''}`),
  /** P-0802-I：断线重连恢复 —— body: session_id 或 room_code + player；
   *  P-0802-J：+player_key（本人 roleKey，必填，防跨角色冒充；对齐剧本杀 C3 roleKey 体系） */
  werewolfResume: (body: { session_id?: string; room_code?: string; player?: string; player_key?: string }) =>
    request<any>('/api/werewolf/resume', { method: 'POST', body: JSON.stringify(body) }),
  // P-0802-C：狼人杀游戏端点封装（调研报告 G0 阶段缺口：原仅 init/status 两个封装，游戏端点前端零调用）
  werewolfNightAction: (player: string, action: string, target: string) =>
    request<any>('/api/werewolf/night_action', { method: 'POST', body: JSON.stringify({ player, action, target }) }),
  werewolfHunterShoot: (player: string, target: string) =>
    request<any>('/api/werewolf/hunter_shoot', { method: 'POST', body: JSON.stringify({ player, target }) }),
  werewolfVote: (player: string, target: string) =>
    request<any>('/api/werewolf/vote', { method: 'POST', body: JSON.stringify({ player, target }) }),
  werewolfResolveNight: (sessionId?: string) =>
    request<any>('/api/werewolf/resolve_night', { method: 'POST', body: JSON.stringify({ session_id: sessionId || '' }) }),
  werewolfStartVoting: (sessionId?: string) =>
    request<any>('/api/werewolf/start_voting', { method: 'POST', body: JSON.stringify({ session_id: sessionId || '' }) }),
  werewolfResolveVote: (sessionId?: string) =>
    request<any>('/api/werewolf/resolve_vote', { method: 'POST', body: JSON.stringify({ session_id: sessionId || '' }) }),
  /** P-0802-F：白天讨论人类发言（接入后端讨论引擎，下轮入发言记录） */
  werewolfDiscussionSay: (player: string, message: string) =>
    request<any>('/api/werewolf/discussion_say', { method: 'POST', body: JSON.stringify({ player, message }) }),
  // 剧本杀 (Script murder mystery)
  scriptInit: (theme: string, players: string[]) =>
    request<any>('/api/script/init', { method: 'POST', body: JSON.stringify({ theme, players }), timeout: 120000 }), // P-0802-L: LLM 剧本生成真实耗时可达 70s+，60s 默认超时会 abort（scriptMap 同路径已用 120s，对齐）
  /** 阶段 2: 生成/获取对局地图（LLM 统一路径 → 校验 → BSP 降级，契约 v1） */
  scriptMap: (body: { session_id?: string; theme?: string; seed?: number; regenerate?: boolean }) =>
    request<any>('/api/script/map', { method: 'POST', body: JSON.stringify(body), timeout: 120000 }),
  scriptStatus: (player?: string) =>
    request<any>(`/api/script/status?player=${encodeURIComponent(player || '')}`),
  scriptSearch: (player: string, location: string) =>
    request<any>('/api/script/search', { method: 'POST', body: JSON.stringify({ player, location }) }),
  /** C2: 线索转交（body: player, target_player, clue_id）—— 转交后 ownership 变更，接收方 status 可见 */
  scriptTransferClue: (player: string, targetPlayer: string, clueId: string) =>
    request<any>('/api/script/transfer_clue', { method: 'POST', body: JSON.stringify({ player, target_player: targetPlayer, clue_id: clueId }) }),
  // G2（P-0802-M）：session_id 读 localStorage 镜像（store 同键持久化），不再硬编码 ''
  scriptStartDiscussion: () =>
    request<any>('/api/script/start_discussion', { method: 'POST', body: JSON.stringify({ session_id: getScriptSessionId() }) }),
  scriptStartVoting: () =>
    request<any>('/api/script/start_voting', { method: 'POST', body: JSON.stringify({ session_id: getScriptSessionId() }) }),
  scriptVote: (player: string, suspect: string) =>
    request<any>('/api/script/vote', { method: 'POST', body: JSON.stringify({ player, suspect }) }),
  scriptResolve: () =>
    request<any>('/api/script/resolve', { method: 'POST', body: JSON.stringify({ session_id: getScriptSessionId() }) }),
  scriptFinish: () =>
    request<any>('/api/script/finish', { method: 'POST', body: JSON.stringify({ session_id: getScriptSessionId() }) }),
  /** C4: DM 全量视图（state:dm_dashboard）—— 所有玩家角色/秘密/AP/线索/投票/roleKey + 对局元数据 */
  scriptDmStatus: (sessionId: string, dmKey?: string) =>
    request<any>(`/api/script/dm/status?session_id=${encodeURIComponent(sessionId)}`, {
      ...(dmKey ? { headers: { 'Content-Type': 'application/json', 'X-DM-Key': dmKey } } : {}),
    }),
  /** C4: DM 手动推进阶段（dm:advance）—— INVESTIGATION→DISCUSSION→VOTE→REVEAL→ENDED；VOTE 步经审批门（阻塞等待批准） */
  scriptAdvance: (sessionId: string, dmKey?: string) =>
    request<any>('/api/script/advance', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId }),
      timeout: 100000,
      ...(dmKey ? { headers: { 'Content-Type': 'application/json', 'X-DM-Key': dmKey } } : {}),
    }),
  /** C3: DM 分发 roleKey（全员令牌一览） */
  scriptKeys: (sessionId: string) =>
    request<any>(`/api/script/keys?session_id=${encodeURIComponent(sessionId)}`),
  /** P-0802-J: 狼人杀 roleKey 分发（全员令牌一览，对齐剧本杀 scriptKeys） */
  werewolfKeys: (sessionId: string) =>
    request<any>(`/api/werewolf/keys?session_id=${encodeURIComponent(sessionId)}`),
  /** C3: 断线重连恢复 —— body: game_id 或 room_code + player_key → 恢复玩家视图（ENDED 含终态结果） */
  scriptResume: (body: { game_id?: string; room_code?: string; player_key?: string }) =>
    request<any>('/api/script/resume', { method: 'POST', body: JSON.stringify(body) }),
  /** C4: D7 审批门 —— DM 批准 / 驳回 / 查询状态（主持人面板用） */
  approvalApprove: (sessionId: string) =>
    request<any>('/api/approval/approve', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) }),
  approvalReject: (sessionId: string, reason = 'DM 驳回') =>
    request<any>('/api/approval/reject', { method: 'POST', body: JSON.stringify({ session_id: sessionId, reason }) }),
  approvalStatus: (sessionId: string) =>
    request<any>(`/api/approval/status?session_id=${encodeURIComponent(sessionId)}`),
  simulationState: () => request<any>('/api/simulation/state'),
  simulationTrackState: () => request<any>('/api/simulation/track/state'),
  /**
   * P-0803-G（轨道系统用户加入，方案A 前端）：玩家加入 2D 世界现有对话组。
   * POST /api/simulation/group/{groupId}/join  body {player_name}
   * 成功 → {status:"ok", group:{id,mode,participants}}；失败 → {status:"error", message}（组不存在/角色不在场/已在组/组已满）。
   */
  joinConversation: (groupId: string, playerName: string) =>
    request<any>(`/api/simulation/group/${encodeURIComponent(groupId)}/join`, {
      method: 'POST',
      body: JSON.stringify({ player_name: playerName }),
    }),
  /** P-0803-G：玩家离开对话组（组内无人时后端自动解散）。POST /api/simulation/group/{groupId}/leave */
  leaveConversation: (groupId: string, playerName: string) =>
    request<any>(`/api/simulation/group/${encodeURIComponent(groupId)}/leave`, {
      method: 'POST',
      body: JSON.stringify({ player_name: playerName }),
    }),
  // 演讲+广播合并地基（demo 入口）
  /** 玩家发广播：POST /api/announcements（默认 PLAYER 级全局公告） */
  announcementSend: (text: string, opts?: { level?: string; channel?: string; mode?: string; speaker?: string }) =>
    request<any>('/api/announcements', {
      method: 'POST',
      body: JSON.stringify({ text, level: opts?.level || 'PLAYER', channel: opts?.channel || 'global', mode: opts?.mode || 'announcement', speaker: opts?.speaker || '玩家' }),
    }),
  /** AI 自动演讲/广播：POST /api/simulation/speech（形态由系统自动判定） */
  simulationSpeech: (speaker?: string, text?: string) =>
    request<any>('/api/simulation/speech', {
      method: 'POST',
      body: JSON.stringify({ speaker: speaker || '', text: text || '' }),
    }),
  announcementRecent: (since = 0) =>
    request<any>(`/api/announcements/recent?since=${since}`),
  /** 演讲广播模式查看：GET /api/announcements/mode（merged=正式版默认 / auto=方案A 旧行为 / split=方案B 旧行为） */
  broadcastModeGet: () =>
    request<{ mode: string }>('/api/announcements/mode'),
  /** 演讲广播模式切换：POST /api/announcements/mode（{mode:'merged'|'auto'|'split'}） */
  broadcastModeSet: (mode: string) =>
    request<any>('/api/announcements/mode', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  // Voice loop
  voiceStatus: () => request<any>('/api/voice/status'),
  voiceStart: () => request<any>('/api/voice/start', { method: 'POST' }),
  voiceStop: () => request<any>('/api/voice/stop', { method: 'POST' }),
  getApiKeyConfig: () => request<any>('/api/config/apikey'),
  setApiKeyConfig: (apiKey: string, apiBase?: string, model?: string, language?: string, trackActivity?: string) =>
    request<any>('/api/config/apikey', { method: 'POST', body: JSON.stringify({ api_key: apiKey, api_base: apiBase || '', model: model || '', language: language || 'zh', track_activity: trackActivity || 'auto' }) }),
  getLanguage: () => request<{language: string}>('/api/config/language'),
  setLanguage: (language: string) => request<any>('/api/config/language', { method: 'POST', body: JSON.stringify({ language }) }),
  getModelRecommendations: () => request<any>('/api/config/models'),
  getVoiceConfig: () => request<any>('/api/config/voice'),
  setVoiceConfig: (voiceEnabled: boolean) => request<any>('/api/config/voice', { method: 'POST', body: JSON.stringify({ voice_enabled: voiceEnabled }) }),
};

