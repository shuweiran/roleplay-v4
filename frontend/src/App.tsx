import { useEffect, useRef } from 'react';
import { useAppStore } from './store/appStore';
import { useSSE } from './api/useSSE';
import { ScenePage } from './components/ScenePage/ScenePage';
import { ChatPage } from './components/ChatPage/ChatPage';
import type { WerewolfPhase } from './types';
import { LoginPage } from './components/LoginPage/LoginPage';
import { HomePage } from './components/HomePage/HomePage';
import { MaterialPage } from './components/MaterialPage/MaterialPage';
import { SettingsPage } from './components/SettingsPage/SettingsPage';

export default function App() {
  const s = useAppStore();
  const isLoggedIn = useAppStore(s => s.isLoggedIn);
  const checkLogin = useAppStore(s => s.checkLogin);
  const view = useAppStore(s => s.view);

  useEffect(() => { checkLogin(); }, []);
  useEffect(() => { if (isLoggedIn) s.loadState(); }, [isLoggedIn]);

  if (!isLoggedIn) {
    return <LoginPage />;
  }

  // Stable SSE handler ref to prevent reconnects on every render
  const sseHandlerRef = useRef((eventType: string, data: any) => {
    const store = useAppStore.getState();
    switch (eventType) {
      case 'round_start': {
        store.setCurrentRound(data.round);
        store.addSystemMsg(`第 ${data.round} 轮开始`);
        break;
      }
      case 'arbiter_task': {
        // Hide task assignments in werewolf mode (reveals player identities)
        const state = useAppStore.getState();
        if (state.mode !== 'werewolf' && data.tasks?.length) store.addTaskBlock(data.tasks);
        break;
      }
      case 'agent_output': {
        store.addAgentMsg(data.agent_name, data.content, data.track_id, data.track_label, data.track_mode, data.visible_to);
        store.setCharStatus(data.agent_name, 'active');
        break;
      }
      case 'agent_silent': {
        store.addSystemMsg(`${data.agent_name} 本轮旁听`);
        store.setCharStatus(data.agent_name, 'silent');
        break;
      }
      case 'arbiter_integrate': {
        if (data.narration) store.addIntegration(data.narration);
        break;
      }
      case 'round_complete': {
        store.setCurrentRound(data.round);
        store.setRunning(false);
        store.addSystemMsg(`第 ${data.round} 轮完成`);
        break;
      }
      case 'compression': {
        store.addSystemMsg(`记忆压缩完成：${data.summary || '已更新长期摘要'}`);
        break;
      }
      case 'user_input': {
        if (data.category === 'director_speech' && data.character) {
          store.addAgentMsg(data.character, data.content, 'main', '', 'merged');
        } else if (data.category === 'human_discussion' && data.character) {
          store.addAgentMsg(data.character, data.content, 'day_discussion', '', 'merged');
          store.setWerewolfWaitHuman(false);
        } else if (data.category === 'human_vote' && data.character) {
          store.addAgentMsg(data.character, data.content, 'day_vote', '', 'merged');
          store.setWerewolfWaitHuman(false);
        } else if (data.category === 'human_speech' && data.character) {
          store.addAgentMsg(data.character, data.content, 'main', '', 'merged');
        } else if (data.content?.startsWith?.('[系统] 狼人已选择')
                || data.content?.startsWith?.('[系统] 你已选择')
                || data.content?.startsWith?.('[系统] 你已使用')) {
          store.addSystemMsg(data.content.replace('[系统] ', ''));
          store.setWerewolfWaitHuman(false);
        } else if (data.content?.startsWith?.('[系统] ')) {
          store.addSystemMsg(data.content.replace('[系统] ', ''));
        } else {
          store.addUserMsg(data.content?.replace?.('[主控旁白] ', '') || data.content);
        }
        break;
      }
      case 'werewolf_phase': {
        console.log('[SSE] werewolf_phase:', data);
        // Normalize phase name for frontend compatibility
        const _normalizePhase = (p: string) => {
          if (p === 'discussion') return 'day_discussion';
          if (p === 'voting') return 'day_vote';
          return p;
        };
        const phase = _normalizePhase(data.phase) as WerewolfPhase;
        store.setWerewolfPhase(phase, data.round);
        const phaseLabels: Record<string, string> = {
          night: '夜间',
          day_discussion: '白天讨论',
          day_vote: '投票',
          ended: '已结束',
          game_over: '游戏结束',
        };
        const label = phaseLabels[phase] || phase;
        const roundNum = data.round || store.werewolfRound;
        store.addSystemMsg(`🌙 第 ${roundNum} ${label} 开始`);
        store.setWerewolfWaitHuman(false);
        break;
      }
      case 'werewolf_player_update': {
        console.log('[SSE] werewolf_player_update:', data);
        if (data.players) {
          console.log('[SSE] players count:', data.players.length);
          store.setWerewolfPlayers(data.players);
          store.addSystemMsg(`[玩家列表] ${data.players.length} 人`);
        } else {
          console.log('[SSE] NO players in data!');
        }
        break;
      }
      case 'werewolf_my_role': {
        console.log('[SSE] werewolf_my_role:', data.role);
        // Map English role names to Chinese (matching ChatPage ROLE_EMOJI keys)
        const roleMap: Record<string, string> = {
          wolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人',
          villager: '平民', guard: '守卫', idiot: '白痴', elder: '长老', knight: '骑士',
        };
        if (data.role) store.setWerewolfMyRole(roleMap[data.role] || data.role);
        break;
      }
      case 'werewolf_player_eliminated': {
        if (data.name && data.role) {
          const roleMap: Record<string, string> = {
            wolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人',
            villager: '平民', guard: '守卫', idiot: '白痴', elder: '长老', knight: '骑士',
          };
          store.setWerewolfPlayerEliminated(data.name, roleMap[data.role] || data.role);
          store.addSystemMsg(`${data.name} 出局 (${roleMap[data.role] || data.role})`);
        }
        break;
      }
      case 'werewolf_wait_human': {
        store.setWerewolfWaitHuman(true);
        store.addSystemMsg(data.message || '请真人玩家发言');
        if (data.phase) store.setWerewolfPhase(data.phase, data.round || store.werewolfRound);
        break;
      }
      case 'werewolf_game_over': {
        store.addSystemMsg(data.message || '游戏结束');
        store.setRunning(false);
        store.setWerewolfPhase('game_over');
        useAppStore.setState({ isRunning: false, werewolfPhase: 'game_over', werewolfWaitHuman: false });
        break;
      }
      case 'werewolf_witch_info': {
        store.addSystemMsg(data.hint);
        store.setWerewolfWaitHuman(true);
        break;
      }
      case 'auto_complete': {
        store.addSystemMsg(`自动对话结束，共 ${data.rounds || store.currentRound} 轮`);
        store.setRunning(false);
        break;
      }
      case 'stopped': {
        store.addSystemMsg('已停止');
        store.setRunning(false);
        break;
      }
      case 'error': {
        store.addSystemMsg(`错误：${data.error}`);
        store.setRunning(false);
        break;
      }
      case 'saved': {
        store.addSystemMsg('已保存');
        break;
      }
      case 'agent_added': {
        store.addAgent(data.name, data.char_status || 'active');
        store.addSystemMsg(`${data.name} 加入会话`);
        break;
      }
      case 'agent_removed': {
        const state = useAppStore.getState();
        useAppStore.setState({
          agents: state.agents.filter(n => n !== data.name),
        });
        store.addSystemMsg(`${data.name} 离开会话`);
        break;
      }
      case 'track_created': {
        store.addSystemMsg(`[轨道] ${data.label || data.id} 已创建`);
        break;
      }
      case 'track_closed': {
        store.addSystemMsg(`[轨道] ${data.label || data.id} 已关闭`);
        break;
      }
      case 'phase_changed': {
        store.addSystemMsg(`[阶段] → ${data.phase}`);
        break;
      }
    }
  });
  useSSE(sseHandlerRef.current);

  return (
    <>
      {view === 'home' && <HomePage />}
      {view === 'scene' && <ScenePage />}
      {view === 'config' && <SettingsPage />}
      {view === 'chat' && <ChatPage />}


    </>
  );
}
