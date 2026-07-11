export interface Character {
  name: string;
  persona: string;
  voice: string;
  background: string;
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
