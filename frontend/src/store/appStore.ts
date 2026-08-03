import { create } from 'zustand';
import type { Character, AppMessage, TrackConfig, Task, WerewolfPhase, WerewolfPlayer, Announcement } from '../types';
import { api, cancelAllRequests, getPlayerId } from '../api/client';

interface AppState {
  initialized: boolean;
  characters: Character[];
  scenes: any[];
  agents: string[];
  currentRound: number;
  isRunning: boolean;
  mode: string;
  protagonist: string;
  directorCharacter: string;
  goals: string[];
  trackHistory: TrackConfig[];
  sessionId: string;
  sceneDescription: string;
  view: 'home' | 'scene' | 'config' | 'chat';
  messages: AppMessage[];
  currentTasks: Task[];
  historyFilter: string | null;
  statusPhase: string;
  charStatuses: Record<string, 'active' | 'silent' | 'offline'>;
  roomCode: string;
  currentPlayer: string;
  onlinePlayers: string[];
  roomAssignments: Record<string, string>;
  roomError: string;
  // Werewolf state
  werewolfPhase: WerewolfPhase;
  werewolfRound: number;
  werewolfPlayers: WerewolfPlayer[];
  werewolfMyRole: string;
  werewolfWaitHuman: boolean;
  // P-0802-F：对局会话/存活/狼人互认/讨论/终局/审批（供狼人杀面板消费）
  werewolfSessionId: string;
  werewolfAlive: string[];
  werewolfVisible: Record<string, string>;
  werewolfDiscussion: { speaker: string; message: string }[];
  werewolfWinner: string;
  werewolfVoteCount: number;
  werewolfApproval: string;
  /** P-0802-I (G1-2)：女巫获知的被刀者（狼刀目标），获知事件推送后置位，新夜清空 */
  werewolfWitchVictim: string;
  /** P-0802-J：狼人杀本人 roleKey（重连/防冒充凭证；init/status 响应 role_key 发放） */
  werewolfRoleKey: string;
  // Script (剧本杀) state — SSE 驱动（GAP-8），轮询兜底写入
  scriptState: any;
  scriptPhase: string;
  scriptReveal: any;
  /** P-0802-J：剧本杀对局 session_id（SSE 会话定向连接与重连定位用） */
  scriptSessionId: string;
  /** P-0802-P1-demo：玩家身份 player_id（客户端生成 + localStorage 持久化，改造方案 §3.1） */
  playerId: string;
  /** P-0802-P4：已绑定角色名（「玩家本人角色」；localStorage 持久化镜像，对齐 getPlayerId 先例，改造方案 §6 Phase 4） */
  boundCharacterName: string;
  // 演讲+广播合并地基（announcement SSE 事件）
  announcements: Announcement[];   // 公告栏历史（最多 50 条）
  bannerQueue: Announcement[];     // 横幅队列（最多 3 条）
  // Auth
  isLoggedIn: boolean;
  userId: string;
  loginError: string;
  // TTS
  ttsStatus: string;
  // Voice
  voiceRunning: boolean;
  voiceState: string;
  // Per-character voice toggle (name -> enabled)
  voiceMap: Record<string, boolean>;

  setVoice: (charName: string, enabled: boolean) => void;
  toggleVoice: (charName: string) => void;

  login: (code: string) => Promise<boolean>;
  logout: () => void;
  checkLogin: () => void;
  setCurrentPlayer: (name: string) => void;
  createRoom: (playerName: string) => Promise<void>;
  joinRoom: (code: string, playerName: string) => Promise<void>;
  refreshRoom: () => Promise<void>;
  leaveRoom: () => Promise<void>;
  assignRoomCharacters: (characters: string[]) => Promise<Record<string, string>>;

  loadState: () => Promise<void>;
  loadHistory: () => Promise<void>;
  enterScene: (sceneId: string, agentNames: string[], currentPlayer?: string) => Promise<void>;
  goToView: (v: 'home' | 'scene' | 'config' | 'chat') => void;
  goChat: () => void;
  goConfig: () => void;
  startRound: (turns?: number) => Promise<void>;
  sendMessage: (text: string, playerName?: string) => Promise<void>;
  stop: () => Promise<void>;
  rollback: (round: number) => Promise<void>;
  setMode: (mode: string, protagonist?: string, directorCharacter?: string) => Promise<void>;
  setGoals: (goals: string[]) => Promise<void>;
  setCurrentRound: (r: number) => void;
  setCharStatus: (name: string, status: 'active' | 'silent' | 'offline') => void;
  setHistoryFilter: (name: string | null) => void;
  goHome: () => void;
  addSystemMsg: (text: string) => void;
  addAgentMsg: (name: string, content: string, trackId?: string, trackLabel?: string, trackMode?: string, visible_to?: string[]) => void;
  addUserMsg: (text: string) => void;
  addTaskBlock: (tasks: Task[]) => void;
  addIntegration: (narration: string) => void;
  setRunning: (v: boolean) => void;
  clearMessages: () => void;
  forceReset: () => Promise<void>;
  setWerewolfWaitHuman: (v: boolean) => void;
  setWerewolfPhase: (phase: WerewolfPhase, round?: number) => void;
  setWerewolfPlayers: (players: WerewolfPlayer[]) => void;
  setWerewolfMyRole: (role: string) => void;
  setWerewolfPlayerEliminated: (name: string, role: string) => void;
  setWerewolfSessionId: (v: string) => void;
  setWerewolfAlive: (v: string[]) => void;
  setWerewolfVisible: (v: Record<string, string>) => void;
  setWerewolfDiscussion: (v: { speaker: string; message: string }[]) => void;
  addWerewolfDiscussionTurn: (v: { speaker: string; message: string }) => void;
  setWerewolfWinner: (v: string) => void;
  setWerewolfVoteCount: (v: number) => void;
  setWerewolfApproval: (v: string) => void;
  /** P-0802-I (G1-2)：女巫获知被刀者 setter */
  setWerewolfWitchVictim: (v: string) => void;
  /** P-0802-J：狼人杀本人 roleKey（断线重连/防冒充凭证；init/status 响应 role_key 发放） */
  setWerewolfRoleKey: (v: string) => void;
  setScriptState: (s: any) => void;
  setScriptPhase: (p: string) => void;
  setScriptReveal: (r: any) => void;
  /** P-0802-J：剧本杀对局 session_id（SSE 会话定向连接与重连定位用） */
  setScriptSessionId: (v: string) => void;
  // ── P-0802-M：后端真·流式（agent_token 增量累积渲染） ──
  /** 流式增量缓冲（按 agent 名累积，暂停时仅缓冲不渲染） */
  streamingByAgent: Record<string, string>;
  /** 流式暂停（增量暂停=前端停止追加渲染，恢复时跳到最新） */
  streamPaused: boolean;
  appendAgentToken: (name: string, delta: string, trackId?: string, trackLabel?: string, trackMode?: string) => void;
  /** 结算所有未完成流式草稿（round_start/round_complete/error 时清理） */
  settleAllStreaming: () => void;
  setStreamPaused: (v: boolean) => void;
  resumeStreaming: () => void;
  /** P-0802-P4：已绑定角色名（「玩家本人角色」；localStorage 持久化镜像，对齐 getPlayerId 先例，改造方案 §6 Phase 4） */
  setBoundCharacterName: (v: string) => void;
  addAnnouncement: (a: Announcement) => void;
  clearAnnouncements: () => void;
  addAgent: (name: string, charStatus?: string) => void;
  removeAgent: (name: string) => Promise<void>;
  // Voice
  startVoice: () => Promise<void>;
  stopVoice: () => Promise<void>;
}

let pollingInterval: ReturnType<typeof setInterval> | null = null;
let pollingTimeout: ReturnType<typeof setTimeout> | null = null;

function normalizeMessage(m: any): AppMessage {
  return {
    role: m.role === 'arbiter' ? 'arbiter' : m.role === 'user' ? 'user' : m.role === 'agent' ? 'agent' : 'system',
    name: m.name || '',
    content: m.content || '',
    timestamp: m.timestamp || new Date().toISOString(),
    track_id: m.track_id || 'main',
    visible_to: m.visible_to || [],
    round_number: m.round_number || 0,
    track_label: m.track_label,
    track_mode: m.track_mode,
    streaming: m.streaming === true,
  } as AppMessage;
}

export const useAppStore = create<AppState>((set, get) => ({
  initialized: false,
  characters: [],
  scenes: [],
  agents: [],
  currentRound: 0,
  isRunning: false,
  mode: 'free',
  protagonist: '',
  directorCharacter: '',
  goals: [],
  trackHistory: [],
  sessionId: '',
  sceneDescription: '',
  view: 'home',
  messages: [],
  currentTasks: [],
  historyFilter: null,
  statusPhase: '就绪',
  charStatuses: {},
  roomCode: localStorage.getItem('roomCode') || '',
  currentPlayer: localStorage.getItem('playerName') || 'me',
  onlinePlayers: [],
  roomAssignments: {},
  roomError: '',
  // Voice
  voiceRunning: false,
  voiceState: 'idle',
  // Per-character voice toggle
  voiceMap: {},
  // TTS
  ttsStatus: '',
  // Werewolf
  werewolfPhase: 'day_discussion' as WerewolfPhase,
  werewolfRound: 1,
  werewolfPlayers: [],
  werewolfMyRole: '',
  werewolfWaitHuman: false,
  werewolfSessionId: '',
  werewolfAlive: [],
  werewolfVisible: {},
  werewolfDiscussion: [],
  werewolfWinner: '',
  werewolfVoteCount: 0,
  werewolfApproval: '',
  werewolfWitchVictim: '',
  // P-0802-J：狼人杀本人 roleKey（重连凭证，空=尚未发放/未获取）
  werewolfRoleKey: '',
  // Script (剧本杀)
  scriptState: null,
  scriptPhase: '',
  scriptReveal: null,
  // P-0802-J：剧本杀对局 session_id（SSE 定向连接 + 重连定位）
  scriptSessionId: '',
  // P-0802-M：后端真·流式（agent_token 增量缓冲 + 暂停标志）
  streamingByAgent: {},
  streamPaused: false,
  // P-0802-P1-demo：玩家身份 player_id（首次生成即持久化，同浏览器身份稳定）
  playerId: getPlayerId(),
  // P-0802-P4：已绑定角色名（localStorage 镜像；loadState 会按 player_id 重新推导，改名后 setBoundCharacterName 显式更新）
  boundCharacterName: (() => { try { return localStorage.getItem('boundCharacterName') || ''; } catch { return ''; } })(),
  // 演讲+广播合并地基
  announcements: [],
  bannerQueue: [],
  isLoggedIn: !!localStorage.getItem('token'),
  userId: localStorage.getItem('userId') || '',
  loginError: '',

  login: async (code: string) => {
    try {
      const res = await api.verifyCode(code);
      localStorage.setItem('token', res.token);
      localStorage.setItem('userId', res.user_id);
      set({ isLoggedIn: true, userId: res.user_id, loginError: '' });
      return true;
    } catch (e: any) {
      set({ loginError: e.message || '邀请码无效' });
      return false;
    }
  },
  logout: () => {
    localStorage.removeItem('token');
    localStorage.removeItem('userId');
    set({ isLoggedIn: false, userId: '' });
  },
  checkLogin: () => {
    const token = localStorage.getItem('token');
    set({ isLoggedIn: !!token, userId: localStorage.getItem('userId') || '' });
  },
  setCurrentPlayer: (name: string) => {
    const playerName = name.trim() || 'me';
    localStorage.setItem('playerName', playerName);
    set({ currentPlayer: playerName });
  },
  createRoom: async (playerName: string) => {
    const name = playerName.trim() || 'me';
    const res = await api.createRoom(name);
    const room = res.room;
    localStorage.setItem('playerName', name);
    localStorage.setItem('roomCode', room.code);
    set({ currentPlayer: name, roomCode: room.code, onlinePlayers: room.players || [], roomAssignments: room.assignments || {}, roomError: '' });
  },
  joinRoom: async (code: string, playerName: string) => {
    const name = playerName.trim() || 'me';
    const res = await api.joinRoom(code.trim().toUpperCase(), name);
    const room = res.room;
    localStorage.setItem('playerName', name);
    localStorage.setItem('roomCode', room.code);
    set({ currentPlayer: name, roomCode: room.code, onlinePlayers: room.players || [], roomAssignments: room.assignments || {}, roomError: '' });
  },
  refreshRoom: async () => {
    const code = get().roomCode;
    if (!code) return;
    try {
      const res = await api.getRoom(code);
      const room = res.room;
      set({ onlinePlayers: room.players || [], roomAssignments: room.assignments || {}, roomError: '' });
    } catch (e: any) {
      set({ roomError: e.message || '房间刷新失败' });
    }
  },
  leaveRoom: async () => {
    const { roomCode, currentPlayer } = get();
    if (roomCode) {
      try { await api.leaveRoom(roomCode, currentPlayer); } catch {}
    }
    localStorage.removeItem('roomCode');
    set({ roomCode: '', onlinePlayers: [], roomAssignments: {}, roomError: '' });
  },
  assignRoomCharacters: async (characters: string[]) => {
    const { roomCode } = get();
    if (!roomCode) return {};
    const res = await api.assignRoomCharacters(roomCode, characters);
    const room = res.room;
    const assignments = room.assignments || {};
    set({ onlinePlayers: room.players || [], roomAssignments: assignments, roomError: '' });
    return assignments;
  },

  loadState: async () => {
    const data = await api.getState();
    // Java backend returns agents/round/mode/... at TOP level (no `router` wrapper);
    // keep `data.router?.xxx` fallback for compatibility with the old response shape.
    const agents = data.agents || data.router?.agents || [];
    // P-0802-P4：按 player_id 推导「已绑定角色名」——角色列表里 player_id 等于本玩家的那个
    // 即玩家本人角色；改名为后角色名即最新绑定名（localStorage 镜像同步，供 client.ts 读）
    const myPid = get().playerId;
    const boundChar = (data.characters || []).find((c: any) => c.player_id === myPid);
    const boundName = boundChar ? String(boundChar.name || '') : '';
    try { localStorage.setItem('boundCharacterName', boundName); } catch { /* ignore */ }
    set({
      initialized: !!data.initialized || !!data.session_id || data.status === 'running' || data.status === 'initialized',
      characters: data.characters || [],
      scenes: data.scenes || [],
      agents,
      currentRound: data.round ?? data.router?.round ?? 0,
      mode: data.mode || data.router?.mode || 'free',
      protagonist: data.protagonist ?? data.router?.protagonist ?? '',
      directorCharacter: data.director_character ?? data.router?.director_character ?? '',
      goals: data.goals || data.router?.goals || [],
      trackHistory: data.track_history || data.router?.track_history || [],
      sessionId: data.session_id || data.router?.session_id || '',
      sceneDescription: data.scene_description || data.scene || data.router?.scene_description || '',
      charStatuses: Object.fromEntries(agents.map((n: string) => [n, get().charStatuses[n] || 'offline'])),
      boundCharacterName: boundName,
    });
  },

  loadHistory: async () => {
    try {
      const state = get();
      const params: Record<string, string> = { limit: '200' };
      // In werewolf/rules mode, filter by the user's character
      const wwModes = ['werewolf', 'rules'];  // script mode filtering handled on backend
      if (wwModes.includes(state.mode)) {
        params.player_name = state.directorCharacter || 'me';
      }
      const data = await api.getHistory(params);
      const rawMessages = Array.isArray(data) ? data : (data.messages || []);
      set({ messages: rawMessages.map(normalizeMessage) });
      await get().loadState();
    } catch {
      set({ statusPhase: '历史加载失败' });
    }
  },

  enterScene: async (sceneId, agentNames, currentPlayer) => {
    // If the scene doesn't exist in the backend, create it first
    const storeState = get();
    const sceneExists = storeState.scenes.some((s: any) => s.scene_id === sceneId);
    if (!sceneExists) {
      await api.createScene({
        scene_id: sceneId,
        name: sceneId,
        description: '',
        agent_names: agentNames,
      });
    }
    // Collect real character details (persona/voice/background) so the backend
    // builds real Personas instead of placeholders; fallback placeholder if unknown.
    const characterDetails = agentNames.map(name => {
      const ch = storeState.characters.find((c: Character) => c.name === name);
      return ch
        ? { name: ch.name, persona: ch.persona || '', voice: ch.voice || '', background: ch.background || '' }
        : { name, persona: `${name}，一个角色`, voice: '', background: '' };
    });
    const data = await api.startScene(sceneId, agentNames, currentPlayer, characterDetails);
    const state = await api.getState();
    set({
      view: 'chat',
      agents: agentNames,
      sessionId: data.session_id,
      currentRound: 0,
      messages: [],
      currentTasks: [],
      isRunning: false,
      statusPhase: '场景已就绪',
      sceneDescription: state.scene_description || state.scene || state.router?.scene_description || '',
      charStatuses: Object.fromEntries(agentNames.map(n => [n, 'active' as const])),
    });
  },

  startRound: async (turns = 1) => {
    set({ isRunning: true, statusPhase: turns > 1 ? `自动运行 ${turns} 轮` : '正在生成本轮' });
    startPolling();
    try {
      await api.startRound(turns);
    } catch (e: any) {
      set({ isRunning: false, statusPhase: e.message || '启动回合失败' });
      stopPolling();
    }
  },

  sendMessage: async (text, playerName?: string) => {
    set({ isRunning: true, statusPhase: '正在处理主控输入' });
    startPolling();
    try {
      const result = await api.send(text, playerName);
      if (!result) {
        set({ isRunning: false, statusPhase: '服务器无响应，请重试' });
        stopPolling();
        return;
      }
      if (result.agent_outputs && Array.isArray(result.agent_outputs)) {
        for (const out of result.agent_outputs) {
          if (out && out.agent_name) {
            get().addAgentMsg(out.agent_name, out.content || '', out.track_id, out.track_label, out.track_mode);
          }
        }
      }
      if (result.narration) {
        get().addIntegration(result.narration);
      }
      set({ isRunning: false, statusPhase: '回合完成' });
      stopPolling();
    } catch (e: any) {
      console.error('sendMessage error:', e);
      set({ isRunning: false, statusPhase: '发送失败: ' + (e.message || '') });
      stopPolling();
    }
  },

  stop: async () => {
    cancelAllRequests();
    await api.stop();
    stopPolling();
    set({ isRunning: false, statusPhase: '已停止' });
  },

  forceReset: async () => {
    cancelAllRequests();
    stopPolling();
    try { await api.stop(); } catch {}
    set({
      isRunning: false, currentTasks: [], statusPhase: '已解除运行状态',
      werewolfPhase: 'day_discussion', werewolfRound: 1, werewolfPlayers: [],
      werewolfMyRole: '', werewolfWaitHuman: false, werewolfSessionId: '', werewolfAlive: [],
      werewolfVisible: {}, werewolfDiscussion: [], werewolfWinner: '', werewolfVoteCount: 0, werewolfApproval: '',
      werewolfWitchVictim: '', werewolfRoleKey: '', scriptSessionId: '',
      streamingByAgent: {}, streamPaused: false,
    });
  },

  rollback: async (round) => {
    await api.rollback(round);
    set({ messages: [], currentRound: round, statusPhase: `已回滚到第 ${round} 轮` });
    await get().loadHistory();
  },

  setMode: async (mode, protagonist, directorCharacter) => {
    const prev = get().mode;
    await api.setMode(mode, protagonist, directorCharacter);
    set({
      mode, protagonist: protagonist || '', directorCharacter: directorCharacter || '',
      ...(mode !== prev ? {
        messages: [], currentTasks: [], werewolfWaitHuman: false,
        werewolfPhase: 'day_discussion', werewolfRound: 1, werewolfPlayers: [], werewolfMyRole: '',
        werewolfSessionId: '', werewolfAlive: [], werewolfVisible: {}, werewolfDiscussion: [],
        werewolfWinner: '', werewolfVoteCount: 0, werewolfApproval: '', werewolfWitchVictim: '',
        werewolfRoleKey: '', scriptSessionId: '',
        streamingByAgent: {}, streamPaused: false,
      } : {}),
    });
  },

  setGoals: async (goals) => {
    await api.setGoals(goals);
    set({ goals });
  },

  setCurrentRound: (r) => set({ currentRound: r }),
  setCharStatus: (name, status) => set(s => ({ charStatuses: { ...s.charStatuses, [name]: status } })),
  setHistoryFilter: (name) => set({ historyFilter: name }),
  goHome: () => set({ view: 'home', messages: [], currentTasks: [] }),
  goToView: (v: 'home' | 'scene' | 'config' | 'chat') => set({ view: v }),
  goChat: () => set({ view: 'chat' }),
  goConfig: () => set({ view: 'config' }),
  addSystemMsg: (text) => set(s => ({ messages: [...s.messages, normalizeMessage({ role: 'system', content: text, round_number: s.currentRound })] })),
  addAgentMsg: (name, content, trackId = 'main', trackLabel, trackMode, visible_to) => set(s => {
    const msgs = [...s.messages];
    // P-0802-M：agent_output 为流式增量的“结算事件”——存在同名流式草稿时直接替换为完整内容，
    // 避免“增量草稿 + 完整消息”双条重复；无草稿时行为与旧版一致（追加新消息）
    const idx = msgs.findIndex(m => m.role === 'agent' && m.name === name && m.streaming);
    const next = normalizeMessage({ role: 'agent', name, content, track_id: trackId, round_number: s.currentRound, track_label: trackLabel, track_mode: trackMode, visible_to, streaming: false });
    if (idx >= 0) msgs[idx] = next;
    else msgs.push(next);
    const buf = { ...s.streamingByAgent };
    delete buf[name];
    return { messages: msgs, streamingByAgent: buf };
  }),
  addUserMsg: (text) => set(s => ({ messages: [...s.messages, normalizeMessage({ role: 'user', name: '主控', content: text, round_number: s.currentRound })] })),
  addTaskBlock: (tasks) => set({ currentTasks: tasks }),
  addIntegration: (narration) => set(s => ({ messages: [...s.messages, normalizeMessage({ role: 'arbiter', name: '主控整合', content: narration, round_number: s.currentRound })] })),
  setRunning: (v) => {
    set({ isRunning: v, statusPhase: v ? '运行中' : '就绪' });
    if (v) startPolling(); else stopPolling();
  },
  clearMessages: () => set({ messages: [], currentTasks: [] }),
  setWerewolfWaitHuman: (v) => set({ werewolfWaitHuman: v }),
  setWerewolfPhase: (phase, round) => set({
    werewolfPhase: phase,
    ...(round !== undefined ? { werewolfRound: round } : {}),
  }),
  setWerewolfPlayers: (players) => set({ werewolfPlayers: players }),
  setWerewolfMyRole: (role) => set({ werewolfMyRole: role }),
  setWerewolfPlayerEliminated: (name, role) => set((s) => ({
    werewolfPlayers: s.werewolfPlayers.map((p) =>
      p.name === name ? { ...p, alive: false, role, roleRevealed: true } : p
    ),
  })),
  setWerewolfSessionId: (v) => set({ werewolfSessionId: v }),
  setWerewolfAlive: (v) => set({ werewolfAlive: v }),
  setWerewolfVisible: (v) => set({ werewolfVisible: v }),
  setWerewolfDiscussion: (v) => set({ werewolfDiscussion: v }),
  addWerewolfDiscussionTurn: (v) => set((s) => ({
    werewolfDiscussion: [...s.werewolfDiscussion, v].slice(-50),
  })),
  setWerewolfWinner: (v) => set({ werewolfWinner: v }),
  setWerewolfVoteCount: (v) => set({ werewolfVoteCount: v }),
  setWerewolfApproval: (v) => set({ werewolfApproval: v }),
  setWerewolfWitchVictim: (v) => set({ werewolfWitchVictim: v }),
  setWerewolfRoleKey: (v) => set({ werewolfRoleKey: v }),
  setScriptState: (s) => set({
    scriptState: s,
    ...(s?.phase ? { scriptPhase: s.phase } : {}),
  }),
  setScriptPhase: (p) => set({ scriptPhase: p }),
  setScriptReveal: (r) => set({ scriptReveal: r }),
  setScriptSessionId: (v) => {
    // P-0802-M：镜像到 localStorage —— client.ts 读镜像避免 api↔store 循环依赖（G2 修复依赖）
    try { localStorage.setItem('scriptSessionId', v || ''); } catch { /* ignore */ }
    set({ scriptSessionId: v });
  },
  /** P-0802-P4：设置已绑定角色名（「玩家本人角色」）——localStorage 镜像，client.ts 读镜像做绑定判断 */
  setBoundCharacterName: (v) => {
    try { localStorage.setItem('boundCharacterName', v || ''); } catch { /* ignore */ }
    set({ boundCharacterName: v || '' });
  },
  // ── P-0802-M：流式增量累积渲染 ──
  appendAgentToken: (name, delta, trackId = 'main', trackLabel, trackMode) => set(s => {
    const buf = { ...s.streamingByAgent };
    buf[name] = (buf[name] || '') + delta;
    // 暂停时仅缓冲不渲染（增量暂停=前端停止追加）；恢复时 resumeStreaming 跳到最新
    if (s.streamPaused) return { streamingByAgent: buf };
    const msgs = [...s.messages];
    const idx = msgs.findIndex(m => m.role === 'agent' && m.name === name && m.streaming);
    if (idx >= 0) {
      msgs[idx] = { ...msgs[idx], content: buf[name] };
    } else {
      msgs.push(normalizeMessage({ role: 'agent', name, content: buf[name], track_id: trackId, round_number: s.currentRound, track_label: trackLabel, track_mode: trackMode, streaming: true }));
    }
    return { messages: msgs, streamingByAgent: buf };
  }),
  settleAllStreaming: () => set(s => ({
    messages: s.messages.map(m => m.streaming ? { ...m, streaming: false } : m),
    streamingByAgent: {},
  })),
  setStreamPaused: (v) => set({ streamPaused: v }),
  resumeStreaming: () => set(s => ({
    streamPaused: false,
    // 恢复渲染：把缓冲里已到达的最新增量同步到草稿消息（跳过暂停期间未渲染的部分）
    messages: s.messages.map(m => {
      if (m.streaming && s.streamingByAgent[m.name] !== undefined) {
        return { ...m, content: s.streamingByAgent[m.name] };
      }
      return m;
    }),
  })),

  // 演讲+广播合并地基：SSE announcement → 公告栏历史 + 横幅队列
  addAnnouncement: (a) => set(s => ({
    announcements: [a, ...s.announcements].slice(0, 50),
    bannerQueue: [...s.bannerQueue, a].slice(-3),
  })),
  clearAnnouncements: () => set({ announcements: [], bannerQueue: [] }),

  addAgent: (name, charStatus = 'active') => set(s => {
    if (s.agents.includes(name)) return s;
    return {
      agents: [...s.agents, name],
      charStatuses: { ...s.charStatuses, [name]: charStatus as 'active' | 'silent' | 'offline' },
    };
  }),

  removeAgent: async (name) => {
    await api.removeAgent(name);
    set(s => ({
      agents: s.agents.filter(n => n !== name),
      charStatuses: { ...s.charStatuses },
    }));
  },
  // Per-character voice toggle
  setVoice: (charName: string, enabled: boolean) => set(s => ({
    voiceMap: { ...s.voiceMap, [charName]: enabled },
  })),
  toggleVoice: (charName: string) => set(s => ({
    voiceMap: { ...s.voiceMap, [charName]: !s.voiceMap[charName] },
  })),
  // Voice
  startVoice: async () => {
    try {
      await api.voiceStart();
      set({ voiceRunning: true, voiceState: 'listening' });
    } catch (e: any) {
      if (e.message !== 'Voice loop already running') throw e;
      set({ voiceRunning: true, voiceState: 'listening' });
    }
  },
  stopVoice: async () => {
    await api.voiceStop();
    set({ voiceRunning: false, voiceState: 'idle' });
  },
}));

function startPolling() {
  stopPolling();
  pollingInterval = setInterval(async () => {
    try {
      const data: any = await api.getState();

      // Always refresh frontend state (current round, scene, mode, etc.)
      await useAppStore.getState().loadState();

      // P0-2/E1：后端 /api/state 返回顶层 status（'running'/'idle'），原 data.router?.phase 是死代码永不命中；
      // SSE 断开时轮询必须能自行解除 isRunning，否则 send 前 stop 后永久停摆。
      if (data && data.status === 'idle') {
        const s = useAppStore.getState();
        if (s.isRunning) {
          useAppStore.setState({ isRunning: false, statusPhase: '就绪' });
          // Load conversation messages after round completes
          await useAppStore.getState().loadHistory();
        }
        stopPolling();
      }
    } catch {
      // ignore polling errors
    }
  }, 2000);

  pollingTimeout = setTimeout(() => {
    const s = useAppStore.getState();
    if (s.isRunning) {
      cancelAllRequests();
      useAppStore.setState({ isRunning: false, statusPhase: '运行超时，已自动解除锁定' });
    }
    stopPolling();
  }, 900000);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  if (pollingTimeout) {
    clearTimeout(pollingTimeout);
    pollingTimeout = null;
  }
}


