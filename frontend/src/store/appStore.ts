import { create } from 'zustand';
import type { Character, AppMessage, TrackConfig, Task, WerewolfPhase, WerewolfPlayer } from '../types';
import { api, cancelAllRequests } from '../api/client';

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
  // Auth
  isLoggedIn: boolean;
  userId: string;
  loginError: string;
  // TTS
  ttsStatus: string;
  // Voice
  voiceRunning: boolean;
  voiceState: string;

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
  // TTS
  ttsStatus: '',
  // Werewolf
  werewolfPhase: 'day_discussion' as WerewolfPhase,
  werewolfRound: 1,
  werewolfPlayers: [],
  werewolfMyRole: '',
  werewolfWaitHuman: false,
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
    const agents = data.router?.agents || [];
    set({
      initialized: data.initialized,
      characters: data.characters || [],
      scenes: data.scenes || [],
      agents,
      currentRound: data.router?.round || 0,
      mode: data.router?.mode || 'free',
      protagonist: data.router?.protagonist || '',
      directorCharacter: data.router?.director_character || '',
      goals: data.router?.goals || [],
      trackHistory: data.router?.track_history || [],
      sessionId: data.router?.session_id || '',
      sceneDescription: data.router?.scene_description || '',
      charStatuses: Object.fromEntries(agents.map((n: string) => [n, get().charStatuses[n] || 'offline'])),
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
    const data = await api.startScene(sceneId, agentNames, currentPlayer);
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
      sceneDescription: state.router?.scene_description || '',
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
      await api.send(text, playerName);
    } catch (e: any) {
      set({ isRunning: false, statusPhase: e.message || '发送失败' });
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
      werewolfMyRole: '', werewolfWaitHuman: false,
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
  addAgentMsg: (name, content, trackId = 'main', trackLabel, trackMode, visible_to) => set(s => ({ messages: [...s.messages, normalizeMessage({ role: 'agent', name, content, track_id: trackId, round_number: s.currentRound, track_label: trackLabel, track_mode: trackMode, visible_to })] })),
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

      if (data.router?.phase === 'idle') {
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


