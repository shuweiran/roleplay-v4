/**
 * PhaserSimulationView.tsx — 2D 模拟视图（Phaser 3.90 渲染层）
 *
 * 数据流（与 static/simulation.html 完全一致，Java 后端零改动）：
 *   GET  /api/simulation/state            初始/兜底快照
 *   SSE  /api/simulation/events           world_snapshot 增量
 *   POST /api/simulation/load-characters  加载角色进 2D 世界
 *   POST /api/simulation/start|stop|reset
 *   POST /api/simulation/target/{name}    点击设目标
 *   POST /api/simulation/scene/{name}     切换场景
 *   POST /api/simulation/send/{name}      以角色身份发言（右侧聊天面板复用）
 *
 * 生命周期（阶段 0 实证模式复用）：
 *   - Game 实例挂 React Ref（ref div 为 parent）
 *   - 卸载 / StrictMode double-mount → game.destroy(true)（removeCanvas=true）
 *   - Vite dev HMR → import.meta.hot.dispose 中 destroy
 *   - 组件只读 store/外部传入的 characters+scene，不写 store（数据流不变）
 *
 * ── C-1 批次（2026-08-02）2D UI 重构 ─────────────────────────────
 *  1. 布局重构：左侧地图空间充足 + 右侧聊天面板（对话历史列表 + 发言输入框）。
 *  2. 右侧面板可折叠：控制条「💬 聊天」按钮 + 面板头部 ✕ —— 收起时地图全宽，展开时显示聊天。
 *  3. P0-3 内嵌聊天（消息展示 + 输入）整合进右侧面板，不再保留旧底部双份。
 *  4. P3-10：演讲+广播 demo 从 ScenePage 场景设置迁入本视图（精简版，默认折叠）。
 *  5. 消息结构统一为 SimChatMsg（status: pending|playing|done），CSS 类 .sim-chat-msg.status-* 就位。
 *
 * ── C-2 批次（2026-08-02）输出机制重构：打字机流式播放 ──────────
 *  1. 打字机队列严格串行：pending → playing（逐字，3字/秒）→ done；上一段播完 + 3s 句间停顿 → 下一段。
 *  2. 参数集中配置 simChatConfig（打字速度/句间停顿/60s 暂停超时/句长上限）。
 *  3. 用户在场判定（单轨/多轨）：conversation-status 群组成员含玩家名 → 在场；
 *     在场 → 世界内只显示「当前播放者」气泡单例；不在场 → 多气泡并行 + 锚定避让（硬约束不重叠）。
 *  4. 暂停/恢复：输入框有字 → 冻结播放进度；发送后恢复；60s 超时无操作 → 跳过当前句。
 *  5. 限句长 + 纯语言文本：渲染硬截断（省略号）+ cleanWorldText 过滤非语言噪音（保留中文标点）。
 *  6. 一般模式（非 2D）不受影响（直接显示不打字机，顺序由后端调度保证）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Phaser from 'phaser';
import { SimulationScene, type SceneCallbacks } from './SimulationScene';
import { AVAILABLE_SCENES, type SimGroup } from './simulationData';
import { simChatConfig, cleanWorldText, truncateText, simChatConfigSummary } from './simChatConfig';
import { AnnouncementBanner } from '../components/AnnouncementBanner';
import { AnnouncementTicker } from '../components/AnnouncementTicker';
import { api } from '../api/client';

export interface PhaserSimulationViewProps {
  /** 进入 2D 世界的角色（name/persona/voice/background，与后端 load-characters 契约一致） */
  characters: Array<{ name: string; persona?: string; voice?: string; background?: string }>;
  /** 场景名（park/city/cafe/forest/classroom/beach；非法值后端回落 park） */
  scene?: string;
  /** 地图区域高度（px 或 CSS 长度，如 'min(640px, calc(100vh - 190px))'；默认 480） */
  height?: number | string;
  /** 加载角色后是否自动 start（默认 true，对齐原 simulation.html 自动开始行为） */
  autoStart?: boolean;
  /** P0-1/P0-3：玩家名（聊天发言以该角色身份发送；load-characters 显式标记玩家控制） */
  playerName?: string;
}

/** C-2 衔接：消息播放状态（打字机流式队列驱动） */
export type ChatMsgStatus = 'pending' | 'playing' | 'done';
/** 统一消息结构（C-2 直接消费 status 字段，结构保持不变） */
export interface SimChatMsg {
  id: string;
  who: string;
  text: string;
  /** player=玩家发言 / world=世界角色对话 / system=系统提示 */
  kind: 'player' | 'world' | 'system';
  /** pending=待播放（入队） / playing=正在打字机播放 / done=已播完 */
  status: ChatMsgStatus;
  ts: number;
}

/** recentConversations 拍平时跳过的元数据键 */
const SKIP_CONV_KEYS = new Set(['pair', 'group', 'mode', 'tick', 'elapsedMs', 'round']);

export function PhaserSimulationView({ characters, scene = 'park', height = 480, autoStart = true, playerName }: PhaserSimulationViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [status, setStatus] = useState('初始化中...');
  const [currentScene, setCurrentScene] = useState(scene);
  const [running, setRunning] = useState(false);
  // ── C-1：右侧聊天面板（对话历史 + 发言输入）──
  const [conversations, setConversations] = useState<any[]>([]);   // 后端 recentConversations（世界对话）
  const [localMsgs, setLocalMsgs] = useState<SimChatMsg[]>([]);    // 玩家发言 + 系统提示
  const [chatInput, setChatInput] = useState('');
  const [chatOpen, setChatOpen] = useState(true);                  // 右侧聊天面板默认展开（收起=地图全宽）
  const [demoOpen, setDemoOpen] = useState(false);                 // P3-10：演讲+广播 demo（默认折叠）
  const [demoMsg, setDemoMsg] = useState('');
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoResult, setDemoResult] = useState('');
  const [broadcastMode, setBroadcastMode] = useState('merged');    // merged=正式版 / auto=方案A / split=方案B
  // C-2：群组（conversation-status）——用户在场判定数据源
  const [groups, setGroups] = useState<SimGroup[]>([]);
  // ── P-0803-G：群组加入/离开交互 ──
  /** 玩家名镜像（供轮询/回调读取最新值，避免闭包过期） */
  const playerNameRef = useRef(playerName);
  playerNameRef.current = playerName;
  /** 世界角色名列表镜像（fetchState 每 3s 更新；判断玩家角色是否在场 → 是否显示加入入口） */
  const worldAgentsRef = useRef<string[]>([]);
  /** 加入/离开结果角标提示（ok=绿 / error=红，4.5s 自消；后端错误 message 可见） */
  const [joinMsg, setJoinMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const worldSigRef = useRef<Map<string, ChatMsgStatus>>(new Map()); // 世界消息签名 → 播放状态（打字机队列状态源）
  const localSeqRef = useRef(0);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const chatListRef = useRef<HTMLDivElement>(null);
  const [, bump] = useState(0);
  const startedRef = useRef(false);
  // P1-8：公告栏显示开关（默认开；localStorage 持久化，与 ChatPage「⚙️ 设置」面板共用同一键 roleplay_ann_show）
  const [, forceRender] = useState(0);
  const annShow = (() => { try { return localStorage.getItem('roleplay_ann_show') !== '0'; } catch { return true; } })();
  const toggleAnnShow = () => {
    const next = !annShow;
    try { localStorage.setItem('roleplay_ann_show', next ? '1' : '0'); } catch { /* ignore */ }
    forceRender(v => v + 1);
  };

  // ── C-2：打字机播放队列状态（严格串行） ──
  const queueRef = useRef<SimChatMsg[]>([]);                        // 待播放队列（pending）
  const playingRef = useRef<SimChatMsg | null>(null);               // 当前播放消息
  const revealRef = useRef<Map<string, number>>(new Map());         // 消息 id → 已揭示字数
  const typingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pauseStartRef = useRef<number | null>(null);                // 暂停起始时间戳（输入框有字）
  const pausedRef = useRef(false);                                  // 暂停镜像（异步回调读最新值）
  const playerPresentRef = useRef(false);                           // 用户在场镜像
  const lastSpeakerRef = useRef<string | null>(null);               // 最近播放者（气泡单例：在场时只显示它）
  const [bubbleTick, setBubbleTick] = useState(0);                  // 播放者变化 → 同步气泡过滤

  // 点击设目标 → 直接 POST（与 simulation.html 相同端点）
  const onSetTarget: SceneCallbacks['onSetTarget'] = (agentName, x, y) => {
    fetch(`/api/simulation/target/${encodeURIComponent(agentName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y }),
    }).catch(() => {});
  };

  // ── Phaser Game 生命周期（创建 / destroy / StrictMode double-mount 收敛） ──
  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host,
      width: 1000,
      height: 600,
      backgroundColor: '#0f172a',
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: 1000,
        height: 600,
      },
      physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } },
      scene: [new SimulationScene({ onSetTarget, onGroupAction: handleGroupAction })],
      banner: false,
    });
    gameRef.current = game;

    const scene = () => game.scene.getScene('SimulationScene') as SimulationScene;

    // ── 数据流：SSE world_snapshot 增量 ──
    const es = new EventSource('/api/simulation/events');
    esRef.current = es;
    es.onopen = () => setStatus('SSE 已连接');
    es.onerror = () => setStatus('SSE 断开（重连中）');
    es.addEventListener('world_snapshot', (e: MessageEvent) => {
      try {
        scene().applySnapshot(JSON.parse(e.data));
      } catch { /* 忽略坏帧 */ }
    });

    // ── 数据流：GET state 轮询兜底（对齐 simulation.html fetchState 双通道） ──
    const fetchState = async () => {
      try {
        const r = await fetch('/api/simulation/state');
        const d = await r.json();
        scene().applySnapshot(d);
        setRunning(Boolean(d.running));
        if (d.scene) setCurrentScene(d.scene);
        // P0-3：内嵌视图消息展示（recentConversations）
        if (Array.isArray(d.recentConversations)) {
          setConversations(d.recentConversations);
        }
        // P-0803-G：世界角色名列表（玩家角色在场判定 → 群组加入入口显隐）
        if (Array.isArray(d.agents)) {
          worldAgentsRef.current = (d.agents as Array<{ agentName?: string }>)
            .map(a => (a && a.agentName ? String(a.agentName) : ''))
            .filter(Boolean);
        }
      } catch { /* 后端未就绪时忽略 */ }
    };
    fetchState();
    pollRef.current = setInterval(fetchState, 3000);

    // ── 数据流：加载角色 → 自动开始 ──
    const loadCharacters = async () => {
      if (startedRef.current) return;
      startedRef.current = true;
      try {
        const clean = characters.filter(c => c && c.name && String(c.name).trim());
        if (clean.length === 0) {
          setStatus('没有可加载的角色（≥2 个）');
          return;
        }
        const r = await fetch('/api/simulation/load-characters', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            characters: clean.map(c => ({
              name: String(c.name).trim(),
              persona: (c.persona || c.name + '，一个角色').trim(),
              voice: c.voice || '',
              background: c.background || '',
            })),
            scene: currentScene,
            // P0-1：显式玩家名 → 后端只把同名 agent 标记为玩家控制（不再硬编码名字 "me"）
            player_name: playerName || 'me',
          }),
        });
        const d = await r.json();
        setStatus(d.message || '角色已加载');
        if (autoStart) {
          await fetch('/api/simulation/start', { method: 'POST' });
          setRunning(true);
        }
        await fetchState();
      } catch (e: any) {
        setStatus('加载失败: ' + (e?.message || '网络错误'));
      }
    };
    loadCharacters();

    // ── 群组框 + 用户在场数据源（conversation-status，每 4s 拉取；P-0803-G 顺带刷新加入/离开入口） ──
    fetchGroups();
    const groupPoll = setInterval(fetchGroups, 4000);

    return () => {
      // 卸载 / StrictMode 双挂载收敛：清理全部资源 + destroy(true)
      clearInterval(groupPoll);
      if (pollRef.current) clearInterval(pollRef.current);
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      timersRef.current.forEach(t => clearTimeout(t));
      timersRef.current.clear();
      clearPlaybackTimers();
      if (gameRef.current) {
        gameRef.current.destroy(true); // removeCanvas=true（阶段 0 实证模式）
        gameRef.current = null;
      }
      startedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characters, autoStart]);

  // ── Vite dev HMR 保护：模块热替换前销毁 Game 实例（阶段 0 实证模式） ──
  useEffect(() => {
    const dispose = () => {
      if (gameRef.current) {
        gameRef.current.destroy(true);
        gameRef.current = null;
      }
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      startedRef.current = false;
    };
    if (import.meta.hot) {
      import.meta.hot.dispose(dispose);
    }
    return () => { /* 组件卸载由主 effect cleanup 处理 */ };
  }, []);

  // ── C-1：世界对话（recentConversations）拍平为统一消息列表（附播放状态） ──
  // C-2：拍平时即清洗（过滤非语言噪音 + 硬截断句长上限），列表与打字机队列共用清洗后文本，
  //      保证揭示字数与显示文本一致（原始文本含 emoji/超长时逐字计数会错位）。
  const worldMsgs = useMemo(() => {
    const out: SimChatMsg[] = [];
    for (const c of conversations) {
      if (!c || typeof c !== 'object') continue;
      for (const [k, v] of Object.entries(c)) {
        if (SKIP_CONV_KEYS.has(k)) continue;
        if (typeof v === 'string' && v.trim()) {
          const sig = String(c.tick ?? '') + '|' + k + '|' + v; // 签名用原始文本（稳定去重）
          const cleaned = truncateText(cleanWorldText(v), simChatConfig.maxSentenceChars);
          if (!cleaned) continue; // 过滤后为空 → 不展示不排队
          const st = worldSigRef.current.get(sig) || 'pending';
          out.push({ id: 'w-' + sig, who: k, text: cleaned, kind: 'world', status: st, ts: Number(c.tick ?? 0) });
        }
      }
    }
    return out;
  }, [conversations, bump]);

  // ── C-2：打字机队列引擎 ──
  const clearPlaybackTimers = () => {
    if (typingTimerRef.current) { clearInterval(typingTimerRef.current); typingTimerRef.current = null; }
    if (nextTimerRef.current) { clearTimeout(nextTimerRef.current); nextTimerRef.current = null; }
  };

  /** 播完当前段：标 done，清除打字机进度（下一段由句间停顿定时器接续） */
  const finishPlaying = () => {
    const cur = playingRef.current;
    if (!cur) return;
    worldSigRef.current.set(cur.id, 'done');
    revealRef.current.delete(cur.id);
    playingRef.current = null;
    clearPlaybackTimers();
    bump(v => v + 1);
  };

  /** 开始逐字播放一段消息（打字机 3 字/秒） */
  const startTyping = (msg: SimChatMsg) => {
    playingRef.current = msg;
    lastSpeakerRef.current = msg.who;
    worldSigRef.current.set(msg.id, 'playing');
    revealRef.current.set(msg.id, 0);
    setBubbleTick(t => t + 1); // 播放者变化 → 同步世界气泡（单例）
    bump(v => v + 1);
    typingTimerRef.current = setInterval(() => {
      const cur = revealRef.current.get(msg.id) ?? 0;
      if (cur + 1 >= msg.text.length) {
        // 播完 → done + 句间停顿后播下一段（严格串行）
        finishPlaying();
        nextTimerRef.current = setTimeout(() => {
          nextTimerRef.current = null;
          startNext();
        }, simChatConfig.interSentencePauseMs);
      } else {
        revealRef.current.set(msg.id, cur + 1);
        bump(v => v + 1);
      }
    }, simChatConfig.typingTickMs);
  };

  /** 出队播下一段（队列严格串行：只有当前段播完/被跳过后才轮到下一段） */
  const startNext = () => {
    if (playingRef.current) return;
    if (pausedRef.current) return; // 输入框有字 → 保持暂停
    const next = queueRef.current.shift();
    if (!next) return;
    startTyping(next);
  };

  // 入队：世界对话已拍平清洗（见 worldMsgs memo），这里只负责去重入队 + 空文本跳过
  useEffect(() => {
    for (const m of worldMsgs) {
      if (m.status !== 'pending') continue;
      const sig = m.id.slice(2);
      if (worldSigRef.current.has(sig)) continue; // 已登记，避免重复入队
      worldSigRef.current.set(sig, 'pending');
      if (!m.text) { worldSigRef.current.set(sig, 'done'); continue; }
      queueRef.current.push(m);
    }
    if (!playingRef.current && !pausedRef.current) startNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldMsgs]);

  // C-2：暂停/恢复 —— 输入框有文字 → 冻结当前播放进度；发送后（清空）恢复
  const paused = chatInput.trim().length > 0;
  useEffect(() => {
    pausedRef.current = paused;
    if (paused) {
      if (pauseStartRef.current == null) pauseStartRef.current = Date.now();
      clearPlaybackTimers(); // 冻结：打字机逐字 + 下一段定时都停
    } else {
      pauseStartRef.current = null;
      if (playingRef.current) {
        // 从冻结位置继续逐字（revealRef 保留进度）
        const msg = playingRef.current;
        typingTimerRef.current = setInterval(() => {
          const cur = revealRef.current.get(msg.id) ?? 0;
          if (cur + 1 >= msg.text.length) {
            finishPlaying();
            nextTimerRef.current = setTimeout(() => {
              nextTimerRef.current = null;
              startNext();
            }, simChatConfig.interSentencePauseMs);
          } else {
            revealRef.current.set(msg.id, cur + 1);
            bump(v => v + 1);
          }
        }, simChatConfig.typingTickMs);
      } else {
        startNext();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  // C-2：60s 暂停超时看门狗 —— 输入框持续有字且无操作 → 跳过当前句（标 done，继续下一段）
  useEffect(() => {
    const wd = setInterval(() => {
      if (pauseStartRef.current != null && Date.now() - pauseStartRef.current >= simChatConfig.pauseTimeoutMs) {
        pauseStartRef.current = null; // 重置，避免同一暂停期连续跳
        if (playingRef.current) finishPlaying();
        // 输入框仍有字 → 保持暂停等恢复；无字 → 播下一段
        if (!pausedRef.current) startNext();
      }
    }, 1000);
    return () => clearInterval(wd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // C-2：用户在场判定 —— conversation-status 群组成员含玩家名 → 在场（单轨）
  const playerPresent = useMemo(() => {
    const pn = playerName ? String(playerName).trim() : '';
    if (!pn) return false;
    return groups.some(g => Array.isArray(g.participants) && g.participants.includes(pn));
  }, [groups, playerName]);

  // C-2：世界气泡单例 —— 在场 → 只显示当前/最近播放者气泡；不在场 → 多气泡（SimulationScene 内避让）
  useEffect(() => {
    playerPresentRef.current = playerPresent;
    const sc = gameRef.current?.scene.getScene('SimulationScene') as SimulationScene | null;
    sc?.setBubbleFilter(playerPresent ? lastSpeakerRef.current : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerPresent, bubbleTick]);

  // 合并：世界对话在前，玩家/系统消息在后
  const allMsgs = useMemo(() => [...worldMsgs, ...localMsgs], [worldMsgs, localMsgs]);

  // 新消息自动滚动到底部（C-2：仅在新消息到达或本就在底部时滚动，避免打字机逐字刷新时打断上翻阅读）
  const prevLenRef = useRef(0);
  useEffect(() => {
    const el = chatListRef.current;
    if (!el) return;
    const lenIncreased = allMsgs.length !== prevLenRef.current;
    prevLenRef.current = allMsgs.length;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (lenIncreased || nearBottom) el.scrollTop = el.scrollHeight;
  }, [allMsgs.length, chatOpen, bump]);

  const pushLocal = (m: { who: string; text: string; kind: 'player' | 'system' }) => {
    setLocalMsgs(prev => [...prev, { id: 'l-' + (localSeqRef.current++), who: m.who, text: m.text, kind: m.kind, status: 'done' as ChatMsgStatus, ts: Date.now() }]);
  };

  const control = async (path: string, label: string) => {
    try {
      await fetch('/api/simulation/' + path, { method: 'POST' });
      setStatus(label + ' 成功');
      const r = await fetch('/api/simulation/state');
      const d = await r.json();
      const sc = gameRef.current?.scene.getScene('SimulationScene') as SimulationScene | null;
      sc?.applySnapshot(d);
      setRunning(Boolean(d.running));
    } catch (e: any) {
      setStatus(label + ' 失败: ' + (e?.message || ''));
    }
  };

  const changeScene = async (name: string) => {
    setCurrentScene(name);
    try {
      await fetch('/api/simulation/scene/' + name, { method: 'POST' });
      setStatus('场景切换: ' + name);
      const r = await fetch('/api/simulation/state');
      const d = await r.json();
      const sc = gameRef.current?.scene.getScene('SimulationScene') as SimulationScene | null;
      sc?.applySnapshot(d);
    } catch (e: any) {
      setStatus('切换失败: ' + (e?.message || ''));
    }
  };

  // ── P-0803-G：群组状态轮询（conversation-status → 群组框 + 加入/离开入口；join/leave 后手动触发即时刷新） ──
  const fetchGroups = useCallback(async () => {
    try {
      const r = await fetch('/api/simulation/conversation-status');
      const d = await r.json();
      const list = (d.groups || []) as SimGroup[];
      setGroups(list);
      const sc = gameRef.current?.scene.getScene('SimulationScene') as SimulationScene | null;
      const pn = ((playerNameRef.current || '').trim()) || 'me';
      // 玩家角色在场（世界角色列表含玩家名）→ 场景叠加「加入对话」入口；不在场不显示
      sc?.applyGroups(list, { playerName: pn, playerInWorld: worldAgentsRef.current.includes(pn) });
    } catch { /* 忽略 */ }
  }, []);

  /**
   * P-0803-G：群组「加入/离开对话」按钮点击 → join/leave API → 成功/失败可见提示 → 手动刷新一次状态。
   * 后端错误（组满/重复加入/已在组/组不存在等）message 原样展示（聊天面板系统消息 + 地图角标）。
   */
  const handleGroupAction = useCallback(async (groupId: string, action: 'join' | 'leave') => {
    const pn = ((playerNameRef.current || '').trim()) || 'me';
    try {
      const r = action === 'join'
        ? await api.joinConversation(groupId, pn)
        : await api.leaveConversation(groupId, pn);
      if (r && r.status === 'ok') {
        const members = ((r.group?.participants) || []) as string[];
        pushLocal({ who: '系统', text: `${action === 'join' ? '✅ 已加入对话组' : '👋 已离开对话组'}｜成员：${members.join('、') || '无'}`, kind: 'system' });
        setJoinMsg({ kind: 'ok', text: action === 'join' ? '✅ 已加入对话组' : '👋 已离开对话组' });
      } else {
        const msg = (r && (r.message as string)) || '未知错误';
        pushLocal({ who: '系统', text: `${action === 'join' ? '❌ 加入对话失败' : '❌ 离开对话失败'}：${msg}`, kind: 'system' });
        setJoinMsg({ kind: 'error', text: `${action === 'join' ? '❌ 加入失败' : '❌ 离开失败'}：${msg}` });
      }
    } catch (e: any) {
      pushLocal({ who: '系统', text: `${action === 'join' ? '❌ 加入对话失败' : '❌ 离开对话失败'}：${e?.message || '网络错误'}`, kind: 'system' });
      setJoinMsg({ kind: 'error', text: `${action === 'join' ? '❌ 加入失败' : '❌ 离开失败'}：${e?.message || '网络错误'}` });
    }
    // 手动触发一次 conversation-status 刷新（既有 4s 轮询兜底，这里保证 UI 即时反馈）
    fetchGroups();
  }, [fetchGroups]);

  // P-0803-G：join/leave 角标提示自动消失（4.5s）
  useEffect(() => {
    if (!joinMsg) return;
    const t = setTimeout(() => setJoinMsg(null), 4500);
    return () => clearTimeout(t);
  }, [joinMsg]);

  // ── P0-3/C-1：右侧聊天面板发言——以玩家角色身份对 2D 世界说话（复用 legacy /api/simulation/send/{name}，后端零改动） ──
  const sendChat = async () => {
    const msg = chatInput.trim();
    if (!msg) return;
    setChatInput(''); // 发送 → 输入框清空 → 暂停解除（恢复播放）
    // 找玩家角色：显式 playerName → 'me'/'我'/'主人' → 第一个角色
    const names = characters.map(c => c && c.name).filter(Boolean) as string[];
    let meName = playerName && names.includes(playerName) ? playerName : '';
    if (!meName) meName = names.find(n => n === 'me' || n === '我' || n === '主人') || '';
    if (!meName && names.length > 0) meName = names[0];
    pushLocal({ who: '你', text: msg, kind: 'player' });
    if (!meName) {
      pushLocal({ who: '系统', text: '没有可发言的角色', kind: 'system' });
      return;
    }
    try {
      await fetch('/api/simulation/send/' + encodeURIComponent(meName), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
    } catch (e: any) {
      pushLocal({ who: '系统', text: '发送失败: ' + (e?.message || ''), kind: 'system' });
    }
  };

  // ── P3-10：演讲+广播 demo（从 ScenePage 场景设置迁入，精简版） ──
  useEffect(() => {
    api.broadcastModeGet().then(r => setBroadcastMode(r.mode || 'merged')).catch(() => {});
  }, []);

  const triggerAiSpeech = async () => {
    setDemoBusy(true);
    setDemoResult('');
    try {
      const r = await api.simulationSpeech(undefined, demoMsg.trim() || undefined);
      if (r.status === 'error') setDemoResult('❌ ' + (r.message || '失败'));
      else setDemoResult(`✅ ${r.speaker} → ${r.mode === 'speech' ? '🎙 演讲（区域，听众判定通过）' : '📢 全局广播（无听众）'}｜${(r.text || '').slice(0, 24)}…`);
    } catch (e: any) {
      setDemoResult('❌ ' + (e.message || '请求失败'));
    }
    setDemoBusy(false);
  };

  const sendPlayerBroadcast = async () => {
    const text = demoMsg.trim();
    if (!text) { setDemoResult('⚠️ 先输入广播内容'); return; }
    setDemoBusy(true);
    try {
      const r = await api.announcementSend(text, { level: 'PLAYER', channel: 'global', mode: 'announcement', speaker: playerName || '玩家' });
      setDemoResult(`✅ 公告已发出（${r.level}/${r.channel}）—— 所有在线玩家将看到横幅`);
    } catch (e: any) {
      setDemoResult('❌ ' + (e.message || '请求失败'));
    }
    setDemoBusy(false);
  };

  // 演讲广播模式切换：同一运行实例运行时切换（merged=正式版 / auto=方案A 回退 / split=方案B 回退）
  const switchBroadcastMode = async (m: string) => {
    if (m === broadcastMode) return;
    setDemoBusy(true);
    try {
      const r = await api.broadcastModeSet(m);
      if (r.status === 'ok') {
        setBroadcastMode(r.mode);
        const label = r.mode === 'merged' ? '正式版 merged' : r.mode === 'split' ? '方案B（内联区域广播）' : '方案A（回调判定）';
        setDemoResult(`🔄 已切换为${label}——下一轮演讲生效`);
      } else {
        setDemoResult('❌ ' + (r.message || '切换失败'));
      }
    } catch (e: any) {
      setDemoResult('❌ ' + (e.message || '请求失败'));
    }
    setDemoBusy(false);
  };

  const statusTag = (m: SimChatMsg) => {
    if (m.status === 'pending') return <span className="status-tag">⏳ 待播放</span>;
    if (m.status === 'playing') return <span className="status-tag">▶ 播放中</span>;
    return null;
  };

  return (
    <div className="phaser-sim-view" style={{ position: 'relative', border: '1px solid var(--border, #334155)', borderRadius: 10, overflow: 'hidden', background: '#0f172a' }}>
      {/* 控制条 */}
      <div style={{ display: 'flex', gap: 8, padding: '8px 12px', background: '#1e293b', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: '#38bdf8', fontWeight: 600 }}>2D 模拟（Phaser 渲染层）</span>
        <select
          className="input"
          style={{ width: 120, padding: '3px 6px', fontSize: 12 }}
          value={currentScene}
          onChange={e => changeScene(e.target.value)}
        >
          {AVAILABLE_SCENES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="btn btn-small" disabled={running} onClick={() => control('start', '开始')}>▶ 开始</button>
        <button className="btn btn-small" disabled={!running} onClick={() => control('stop', '暂停')}>⏸ 暂停</button>
        <button className="btn btn-small btn-danger" onClick={() => control('reset', '重置')}>↺ 重置</button>
        {/* P1-8：公告栏显示开关（横幅+公告栏仅在 2D 视图内出现，可一键隐藏/显示） */}
        <button
          className={`btn btn-small ${annShow ? '' : 'btn-danger'}`}
          onClick={toggleAnnShow}
          title="公告栏显示开关（AI 演讲/广播横幅与公告栏）"
        >
          📢 {annShow ? '开' : '关'}
        </button>
        {/* C-1：右侧聊天面板折叠开关（可见常驻：收起=地图全宽，展开=显示聊天） */}
        <button
          className={`btn btn-small ${chatOpen ? 'btn-primary' : ''}`}
          onClick={() => setChatOpen(v => !v)}
          title={chatOpen ? '收起右侧聊天面板（地图全宽）' : '展开右侧聊天面板'}
        >
          💬 聊天 {chatOpen ? '▸' : '◂'}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-2, #94a3b8)' }}>{status}</span>
      </div>

      {/* P3-10：演讲+广播 demo（精简版，默认折叠） */}
      <div style={{ borderTop: '1px solid #334155', background: '#0f172a' }}>
        <div
          style={{ padding: '6px 12px', fontSize: 12, color: '#94a3b8', cursor: 'pointer', userSelect: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
          onClick={() => setDemoOpen(!demoOpen)}
        >
          <span>🎙 演讲 + 广播（demo：AI 演讲 / 玩家广播 / 模式切换）</span>
          <span>{demoOpen ? '▾ 收起' : '▸ 展开'}</span>
        </div>
        {demoOpen && (
          <div style={{ padding: '0 12px 10px' }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                className="input"
                style={{ flex: 1, minWidth: 200, fontSize: 12, padding: '5px 8px' }}
                placeholder="发言/广播内容（留空用默认演示文案）"
                value={demoMsg}
                onChange={e => setDemoMsg(e.target.value)}
              />
              <button className="btn btn-small" disabled={demoBusy} onClick={triggerAiSpeech} title="AI 自动选择演讲（有听众→区域）或广播（无听众→全局）">
                🎙 AI 自动演讲
              </button>
              <button className="btn btn-small btn-primary" disabled={demoBusy} onClick={sendPlayerBroadcast} title="玩家发全员公告（横幅）">
                📣 玩家发广播
              </button>
              <select
                className="input"
                style={{ width: 158, padding: '3px 6px', fontSize: 12 }}
                value={broadcastMode}
                onChange={e => switchBroadcastMode(e.target.value)}
                title="演讲广播模式（merged=正式版 HearingSystem 声学判定 / auto=方案A 回调 / split=方案B 内联区域）"
              >
                <option value="merged">⭐ 正式版 merged</option>
                <option value="auto">方案A（回调判定）</option>
                <option value="split">方案B（内联区域）</option>
              </select>
            </div>
            {demoResult && <div style={{ marginTop: 6, fontSize: 12, color: '#4ade80' }}>{demoResult}</div>}
          </div>
        )}
      </div>

      {/* C-1：主体 —— 左地图（空间充足）+ 右聊天面板（可折叠） */}
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        {/* 左：地图 + 公告覆盖层 */}
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <div ref={hostRef} style={{ width: '100%', height }} />
          {/* P1-8：公告横幅 + 公告栏 —— 仅在 2D 游戏视图内挂载（不再 App.tsx 全局常驻右上角）。
              绝对定位覆盖地图上方（.ann-*.inline），由「📢」开关控制显示。 */}
          {annShow && (
            <>
              <AnnouncementBanner inline />
              <AnnouncementTicker inline />
            </>
          )}
          {/* P-0803-G：加入/离开对话结果角标（后端错误 message 可见提示，4.5s 自消） */}
          {joinMsg && (
            <div
              style={{
                position: 'absolute', left: 10, bottom: 10, zIndex: 20,
                padding: '6px 12px', borderRadius: 6, fontSize: 12, maxWidth: '70%',
                background: joinMsg.kind === 'ok' ? 'rgba(16,185,129,0.92)' : 'rgba(239,68,68,0.92)',
                color: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
              }}
            >
              {joinMsg.text}
            </div>
          )}
        </div>
        {/* 右：聊天面板（对话历史 + 发言输入；收起时地图全宽） */}
        {chatOpen && (
          <div className="sim-chat-panel">
            <div
              style={{ padding: '6px 12px', fontSize: 12, color: '#94a3b8', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #334155', flexShrink: 0 }}
            >
              <span title={simChatConfigSummary()}>💬 对话与发言 {allMsgs.length > 0 ? `（${allMsgs.length} 条）` : ''}</span>
              <button className="btn btn-small" onClick={() => setChatOpen(false)} title="收起聊天面板（地图全宽）">✕</button>
            </div>
            <div className="sim-chat-list" ref={chatListRef}>
              {allMsgs.length === 0 && (
                <div style={{ color: '#64748b', padding: '4px 0' }}>暂无对话——2D 世界角色会自动相遇交谈</div>
              )}
              {allMsgs.map(m => (
                <div key={m.id} className={`sim-chat-msg kind-${m.kind} status-${m.status}`}>
                  <strong className="who">{m.who}：</strong>
                  {/* C-2：播放中的消息按打字机进度逐字显示（revealRef 驱动，3 字/秒） */}
                  {m.status === 'playing'
                    ? <>{m.text.slice(0, revealRef.current.get(m.id) ?? 0)}<span className="typewriter-caret">▌</span></>
                    : m.text}
                  {statusTag(m)}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6, padding: '8px 10px', borderTop: '1px solid #334155', background: '#1e293b', flexShrink: 0 }}>
              <input
                className="input"
                style={{ flex: 1, fontSize: 12, padding: '5px 8px' }}
                placeholder={`以 ${playerName || characters[0]?.name || '玩家'} 的身份对 2D 世界说话（输入时暂停播放）...`}
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') sendChat(); }}
              />
              <button className="btn btn-small btn-primary" onClick={sendChat}>发送</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
