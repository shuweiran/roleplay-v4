export interface Character {
  name: string;
  persona: string;
  voice: string;
  background: string;
  /** P-0802-P1-demo：玩家身份绑定（改造方案 §3.2）；null/缺省 = 未绑定 */
  player_id?: string | null;
}

export interface Scene {
  scene_id: string;
  name: string;
  description: string;
  initial_agent_names: string[];
}

export interface Track {
  id: string;
  agents: string[];
  agent_actions: Record<string, 'active' | 'silent' | 'offline'>;
  mode: 'merged' | 'weak' | 'isolated';
  color: string;
  label: string;
}

export interface TrackConfig {
  round: number;
  tracks: Track[];
  description: string;
}

export interface AppMessage {
  role: 'system' | 'agent' | 'user' | 'arbiter';
  name: string;
  content: string;
  timestamp: string;
  track_id: string;
  visible_to: string[];
  round_number: number;
  track_label?: string;
  track_mode?: string;
  character?: string;
  /** P-0802-M：流式增量草稿标记（agent_token 累积中，收到 agent_output 结算后置 false） */
  streaming?: boolean;
}

export interface Task {
  agent_name: string;
  task: string;
}

export interface AgentOutput {
  agent_name: string;
  content: string;
  track_id: string;
  track_label?: string;
  track_mode?: string;
}

// ── Werewolf / 狼人杀 ──────────────────────────────
export type WerewolfPhase = 'night' | 'day_discussion' | 'day_vote' | 'ended' | 'game_over';

export interface WerewolfPlayer {
  name: string;
  role: string;
  alive: boolean;
  roleRevealed: boolean;
}

// ── 演讲+广播合并地基（announcement SSE 事件）──────────────────
export interface Announcement {
  id: string;
  /** SYSTEM | EVENT | PLAYER | NPC */
  level: string;
  /** global | area | system */
  channel: string;
  speaker: string;
  text: string;
  x?: number;
  y?: number;
  radius?: number;
  /** speech=演讲（带空间范围）| announcement=公告 */
  mode: string;
  timestamp: number;
}
