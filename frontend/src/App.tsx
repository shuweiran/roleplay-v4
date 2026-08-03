import { useEffect, useRef } from 'react';
import { useAppStore } from './store/appStore';
import { useSSE } from './api/useSSE';
import { ScenePage } from './components/ScenePage/ScenePage';
import { ChatPage } from './components/ChatPage/ChatPage';
import type { WerewolfPhase } from './types';
import { LoginPage } from './components/LoginPage/LoginPage';
import { HomePage } from './components/HomePage/HomePage';
import { SettingsPage } from './components/SettingsPage/SettingsPage';
import { ttsPlayer } from './services/ttsPlayer';

/** Skip TTS playback for current utterance when per-character voice is off */
let _skipTts = false;

/** P-0802-F：后端阶段名 → 前端阶段键（discussion→day_discussion / voting→day_vote） */
function normalizeWerewolfPhase(p: string): string {
  if (p === 'discussion') return 'day_discussion';
  if (p === 'voting') return 'day_vote';
  return p;
}

export default function App() {
  const s = useAppStore();
  const isLoggedIn = useAppStore(s => s.isLoggedIn);
  const checkLogin = useAppStore(s => s.checkLogin);
  const view = useAppStore(s => s.view);
  // P-0802-I：SSE 连接按狼人杀对局会话定向（多客户端/多对局互不串扰）
  const werewolfSessionId = useAppStore(s => s.werewolfSessionId);
  // P-0802-J：剧本杀对局会话（script_* 定向事件按此接收）
  const scriptSessionId = useAppStore(s => s.scriptSessionId);
  const mode = useAppStore(s => s.mode);

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
        // P-0802-M：新轮开始前结算上轮遗留的流式草稿（防中断残留半截消息）
        store.settleAllStreaming();
        const rs = useAppStore.getState();
        const smallMode = rs.mode === 'free' || rs.mode === 'director';
        if (!(smallMode && rs.agents.length < 3)) {
          store.addSystemMsg(`第 ${data.round} 轮开始`);
        }
        break;
      }
      case 'arbiter_task': {
        // Hide task assignments in werewolf mode (reveals player identities)
        // Also suppress task distribution for <3 agents in free/director mode
        const at = useAppStore.getState();
        const smallMode = at.mode === 'free' || at.mode === 'director';
        if (!(smallMode && at.agents.length < 3)) {
          if (at.mode !== 'werewolf' && data.tasks?.length) store.addTaskBlock(data.tasks);
        }
        break;
      }
      case 'agent_output': {
        store.addAgentMsg(data.agent_name, data.content, data.track_id, data.track_label, data.track_mode, data.visible_to);
        store.setCharStatus(data.agent_name, 'active');
        break;
      }
      // P-0802-M：LLM 流式增量 —— 逐片累积到同名草稿消息（完整内容由 agent_output 结算）
      case 'agent_token': {
        if (data.agent_name && data.delta) {
          store.appendAgentToken(data.agent_name, data.delta, data.track_id, data.track_label, data.track_mode);
        }
        break;
      }
      case 'agent_silent': {
        store.addSystemMsg(`${data.agent_name} 本轮旁听`);
        store.setCharStatus(data.agent_name, 'silent');
        break;
      }
      case 'arbiter_integrate': {
        if (data.narration) {
          const ai = useAppStore.getState();
          const sm = ai.mode === 'free' || ai.mode === 'director';
          if (!(sm && ai.agents.length < 3)) {
            store.addIntegration(data.narration);
          }
        }
        break;
      }
      case 'round_complete': {
        store.setCurrentRound(data.round);
        store.setRunning(false);
        // P-0802-M：轮次完成即结算全部流式草稿（agent_output 已到；兜底清理）
        store.settleAllStreaming();
        const rc = useAppStore.getState();
        const smallMode2 = rc.mode === 'free' || rc.mode === 'director';
        if (!(smallMode2 && rc.agents.length < 3)) {
          store.addSystemMsg(`第 ${data.round} 轮完成`);
        }
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
          // Skip — loadHistory handles display to avoid duplicates
          break;
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
        const phase = normalizeWerewolfPhase(data.phase) as WerewolfPhase;
        store.setWerewolfPhase(phase, data.round);
        if (data.session_id) store.setWerewolfSessionId(data.session_id);
        // P-0802-I (G1-2)：新夜清空女巫获知信息（等下一次获知事件）
        if (phase === 'night') store.setWerewolfWitchVictim('');
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
        if (data.name) {
          const roleMap: Record<string, string> = {
            wolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人',
            villager: '平民', guard: '守卫', idiot: '白痴', elder: '长老', knight: '骑士',
          };
          // P-0802-F：全局广播不含死者身份（角色保密），role 为空时仅提示出局
          if (data.role) {
            store.setWerewolfPlayerEliminated(data.name, roleMap[data.role] || data.role);
            store.addSystemMsg(`${data.name} 出局 (${roleMap[data.role] || data.role})`);
          } else {
            store.addSystemMsg(`${data.name} 出局`);
          }
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
        // P-0802-I (G1-2)：女巫获知被刀者 → 前端面板先展示被刀者，再让女巫决定救/不救/毒
        if (data.victim) store.setWerewolfWitchVictim(String(data.victim));
        break;
      }
      // P-0802-F：夜间结算 / 投票进度 / 讨论发言 / 状态推送
      case 'werewolf_night_result': {
        store.setWerewolfWaitHuman(false);
        if (data.session_id) store.setWerewolfSessionId(data.session_id);
        const died = Array.isArray(data.died) ? data.died : [];
        store.addSystemMsg(died.length > 0
          ? `🌙 昨夜死亡：${died.join('、')}`
          : '🌙 昨夜平安夜，无人死亡');
        break;
      }
      case 'werewolf_vote_update': {
        store.setWerewolfWaitHuman(false);
        if (data.session_id) store.setWerewolfSessionId(data.session_id);
        if (typeof data.votes_count === 'number') store.setWerewolfVoteCount(data.votes_count);
        if (data.approval) store.setWerewolfApproval(data.approval);
        if (data.exiled) store.addSystemMsg(`🗳️ ${data.exiled} 被放逐（${data.reason || ''}）`);
        if (data.winner) store.setWerewolfWinner(data.winner);
        if (data.phase) {
          const p2 = normalizeWerewolfPhase(data.phase) as WerewolfPhase;
          store.setWerewolfPhase(p2, data.round || store.werewolfRound);
        }
        break;
      }
      case 'werewolf_speech': {
        if (data.speaker && data.message) {
          store.addAgentMsg(data.speaker, data.message, 'day_discussion', '', 'merged');
          store.addWerewolfDiscussionTurn({ speaker: data.speaker, message: data.message });
        }
        break;
      }
      case 'werewolf_status': {
        if (data.session_id) store.setWerewolfSessionId(data.session_id);
        if (Array.isArray(data.players)) store.setWerewolfPlayers(data.players);
        break;
      }
      // 剧本杀 SSE（GAP-8）：阶段流转 / 状态推送 / 揭晓结果
      case 'script_phase': {
        console.log('[SSE] script_phase:', data);
        store.setScriptPhase(data.phase);
        const labels: Record<string, string> = {
          setup: '准备阶段', investigation: '搜证阶段', discussion: '讨论阶段',
          vote: '投票阶段', reveal: '揭晓阶段', ended: '对局已结束',
        };
        const lbl = labels[data.phase] || data.phase || '';
        store.addSystemMsg(`🎭 剧本杀：${lbl}${data.phase === 'ended' ? '（终局）' : ''}`);
        break;
      }
      case 'script_status': {
        console.log('[SSE] script_status:', data);
        store.setScriptState(data);
        if (data.phase) store.setScriptPhase(data.phase);
        break;
      }
      case 'script_reveal': {
        console.log('[SSE] script_reveal:', data);
        store.setScriptReveal(data);
        const verdict = data.correct ? '✅ 成功找到真凶' : '❌ 冤枉了好人';
        store.addSystemMsg(`🎬 揭晓：得票最多 ${data.most_voted || '无'}，真凶 ${data.murderer || '未识别'}（${verdict}）`);
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
      case 'announcement': {
        // 演讲+广播合并地基：SSE announcement → 公告栏 + 中央横幅（打字机）
        store.addAnnouncement(data);
        break;
      }
      // TTS 流式语音
      case 'tts_start': {
        const agentName = data.agent_name || '';
        const at = useAppStore.getState();
        if (agentName && at.voiceMap[agentName] === false) {
          // Voice is OFF for this character — skip
          _skipTts = true;
          break;
        }
        _skipTts = false;
        useAppStore.setState({ ttsStatus: '🔊 语音播报中...' });
        break;
      }
      case 'tts_chunk': {
        if (_skipTts) break;
        ttsPlayer.addChunk(data.data);
        break;
      }
      case 'tts_end': {
        if (!_skipTts) useAppStore.setState({ ttsStatus: '' });
        _skipTts = false;
        break;
      }
      case 'tts_error': {
        useAppStore.setState({ ttsStatus: '⚠️ 语音播报失败' });
        console.warn('TTS error:', data.error);
        break;
      }
    }
  });
  // P-0802-J：按当前模式选会话定向 —— 剧本杀用 script 会话、狼人杀用 werewolf 会话、
  // 其他模式不携带会话（全局广播全覆盖；无匹配会话时定向事件静默丢弃，前端轮询兜底）
  const sseSessionId = mode === 'script' ? scriptSessionId : (mode === 'werewolf' ? werewolfSessionId : '');
  useSSE(sseHandlerRef.current, sseSessionId);

  return (
    <>
      {view === 'home' && <HomePage />}
      {view === 'scene' && <ScenePage />}
      {view === 'config' && <SettingsPage />}
      {view === 'chat' && <ChatPage />}


    </>
  );
}
