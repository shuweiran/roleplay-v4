import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { api } from '../../api/client';
import { PhaserSimulationView } from '../../phaser/PhaserSimulationView';
import { PhaserScriptMapView } from '../../phaser/PhaserScriptMapView';
import { AVAILABLE_SCENES } from '../../phaser/simulationData';

type Scene = any;
type Character = any;

const WEREWOLF_DEFAULTS = ['苏哲', '林诗', '老王', '小美', '阿强'];

export function ScenePage() {
  const store = useAppStore();
  const {
    characters, scenes, mode,
    currentPlayer, roomCode, onlinePlayers,
    goToView, enterScene,
    setMode, loadState, loadHistory,
    // P-0802-P4：玩家本人角色（绑定 player_id）改名同步用
    playerId, boundCharacterName, setBoundCharacterName, setCurrentPlayer,
  } = store;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeScene, setActiveScene] = useState<Scene | null>(null);
  const [status, setStatus] = useState('');
  const [rulesTab, setRulesTab] = useState<'ww' | 'script'>('ww');
  const [generating, setGenerating] = useState(false);
  const [loading, setLoading] = useState(false);

  const [modalType, setModalType] = useState<'char' | 'scene' | null>(null);
  const [editTarget, setEditTarget] = useState<any>(null);
  const [formName, setFormName] = useState('');
  const [formVoice, setFormVoice] = useState('');
  const [formPersona, setFormPersona] = useState('');
  const [formBg, setFormBg] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formKeyword, setFormKeyword] = useState('');
  const [scriptPrompt, setScriptPrompt] = useState('');
  // P-0803-H2：恢复对局入口（对局不在场景列表，刷新后需手动重连；session_id + player_key）
  const [resumeSid, setResumeSid] = useState('');
  const [resumeKey, setResumeKey] = useState('');
  const [simChars, setSimChars] = useState<Array<{ name: string; persona: string; voice: string; background: string }>>([]);
  const [simScene, setSimScene] = useState('park');
  const [scriptGame, setScriptGame] = useState<any>(null);
  const [scriptMyRole, setScriptMyRole] = useState('');
  const [scriptMySecret, setScriptMySecret] = useState('');
  // ── Phaser 阶段 2：剧本杀地图（LLM 生成 → 契约 v1 → Phaser 渲染 + 热点搜证） ──
  const [scriptMap, setScriptMap] = useState<any>(null);
  const [scriptMapMeta, setScriptMapMeta] = useState<any>(null);
  // P-0803-E 方案 B: 搜证足迹（地图绿点恢复；随 init/genScriptMap 响应更新）
  const [scriptMapSearched, setScriptMapSearched] = useState<string[]>([]);
  const [mapBusy, setMapBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [roomBusy, setRoomBusy] = useState(false);
  const [roomError, setRoomError] = useState('');
  const [roleConfig, setRoleConfig] = useState<Record<string, number>>({
    wolf: 1, seer: 1, witch: 1, hunter: 0, villager: 2,
  });
  // ── Phaser 阶段 1：内嵌 2D 模拟视图（数据流不变，仅换渲染层） ──
  const [showPhaserSim, setShowPhaserSim] = useState(false);
  // ── C-1（P3-11）：场景设置分类与排序（角色/场景列表，纯前端本地分组，不改后端数据结构） ──
  const [charSort, setCharSort] = useState<'default' | 'az' | 'za'>('default');
  const [charFilter, setCharFilter] = useState<'all' | 'selected' | 'unselected'>('all');
  const [sceneSort, setSceneSort] = useState<'default' | 'az' | 'za'>('default');
  // ── P-0803-H：剧本选择与角色卡功能改造 ──
  /** 剧本选择分类页签（一般模式 / 狼人杀模式） */
  const [scriptCategory, setScriptCategory] = useState<'general' | 'werewolf'>('general');
  /** 点开的剧本卡（点开后显示角色卡栏 + 地图预览） */
  const [openScript, setOpenScript] = useState<Scene | null>(null);
  /** 角色卡分组页签（'all'=全部 / 'free'=自由角色卡 / scene_id=所属剧本） */
  const [charTab, setCharTab] = useState<string>('all');
  /** 一般模式「是否 2D」选择（需求 8：一般模式给用户选择） */
  const [enable2D, setEnable2D] = useState(false);
  /** 狼人杀模式「默认 2D」（需求 8：默认开启） */
  const [wwEnable2D, setWwEnable2D] = useState(true);
  // 剧本编辑弹窗新字段（P-0803-H）
  const [formCategory, setFormCategory] = useState<'general' | 'werewolf'>('general');
  const [formDefaultRoles, setFormDefaultRoles] = useState<Set<string>>(new Set());
  const [formDefaultMap, setFormDefaultMap] = useState<any>(null);
  const [mapGenBusy, setMapGenBusy] = useState(false);
  // ── Phaser 阶段 1：在内嵌 Phaser 视图中打开 2D 模拟（不进聊天页、不弹新窗口） ──
  // 数据流与 simulation.html 完全一致（/api/simulation/* REST+SSE），Java 后端零改动；
  // C-1：原「进入 2D 模拟」checkbox 已合并——本按钮为唯一 2D 入口（内嵌左地图+右聊天视图）。
  const openPhaserSim = () => {
    // P-0803-H：优先用点开剧本卡的默认角色组（未点开剧本时回退当前勾选集合，需求 3/5）
    const basePlayers = (openScript?.default_roles || []).filter(Boolean) as string[];
    const pool = basePlayers.length > 0 ? basePlayers : selectedNames;
    if (pool.length < 2) { setStatus('请至少选择 2 个角色'); return; }
    if (!activeScene) { setStatus('请先选择一个剧本'); return; }
    const scenePlayers = Array.from(new Set([...pool, ...roomPlayers]));
    const charDetails = scenePlayers.map(name => {
      const ch = characters.find(c => c.name === name);
      return ch
        ? { name: ch.name, persona: ch.persona || '', voice: ch.voice || '', background: ch.background || '' }
        : { name, persona: `${name}，一个角色`, voice: '', background: '' };
    });
    setSimChars(charDetails);
    // 后端 setScene 只认 6 个预置场景名，非法值回落 park（与原 simulation.html KNOWN_SCENES 归一一致）
    const sceneName = (activeScene.description || activeScene.name || 'park').toLowerCase();
    setSimScene(AVAILABLE_SCENES.includes(sceneName) ? sceneName : 'park');
    setShowPhaserSim(true);
    setStatus('已在内嵌 Phaser 视图中打开 2D 模拟（数据流不变，仅渲染层切换为 Phaser 3.90）');
  };

  // 演讲+广播合并地基 demo 面板
  // ── P3-10（C-1 批次）：demo 面板已迁入 PhaserSimulationView 2D 游戏视图（精简版），
  // 场景设置区不再显示 demo 内容；此处不再声明 demo 状态/函数 ──

  const selectedNames = Array.from(selected);
  const roomPlayers = Array.from(new Set(onlinePlayers.filter(Boolean)));
  const isRulesMode = mode === 'rules';

  // P-0803-H：角色列表筛选/排序已并入 displayChars（tabChars 之上套用 charFilter/charSort）

  // ── P-0803-H：剧本卡列表 —— 按分类（一般模式/狼人杀模式）过滤 + 名称排序（需求 2/4） ──

  // ── P-0803-H：剧本选择与角色卡分组（纯前端派生，需求 4/6/7） ──
  /** 用户自己的角色卡（绑定 player_id 的角色；无绑定时取 currentPlayer 同名字符；两者皆无则无置顶） */
  const myCharName = useMemo(() => {
    const bound = characters.find((c: any) => c.player_id === playerId);
    if (bound) return String(bound.name || '');
    if (characters.some((c: any) => c.name === currentPlayer)) return currentPlayer;
    return '';
  }, [characters, playerId, currentPlayer]);
  /** 有默认角色组的剧本 → 角色卡按场景分类的页签（需求 6） */
  const scriptGroups = useMemo(
    () => scenes.filter((s: any) => Array.isArray(s.default_roles) && s.default_roles.length > 0),
    [scenes]
  );
  /** 自由角色卡 = 不在任何剧本 default_roles 中的角色（需求 6 自由页） */
  const freeChars = useMemo(
    () => characters.filter((c: any) => !scriptGroups.some((s: any) => (s.default_roles || []).includes(c.name))),
    [characters, scriptGroups]
  );
  /** 每栏列表排序：用户自己的角色卡置顶，其余按名称排序（需求 7） */
  const withMeFirst = (list: Character[]) => {
    const rest = [...list].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
    const me = rest.filter(c => c.name === myCharName);
    return [...me, ...rest.filter(c => c.name !== myCharName)];
  };
  /** 当前角色页签显示的角色列表（全部 / 所属剧本组 / 自由角色卡） */
  const tabChars = useMemo(() => {
    if (charTab === 'all') return withMeFirst([...characters]);
    if (charTab === 'free') return withMeFirst([...freeChars]);
    const sc = scenes.find((s: any) => s.scene_id === charTab);
    if (sc) {
      const names = new Set((sc.default_roles || []).filter(Boolean));
      return withMeFirst(characters.filter((c: any) => names.has(c.name)));
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charTab, characters, scenes, freeChars, myCharName]);
  /** 剧本选择：按分类过滤（一般模式 / 狼人杀模式，需求 4）+ 名称排序 */
  const scriptCards = useMemo(() => {
    let list = scenes.filter((s: any) => (s.category || 'general') === scriptCategory);
    if (sceneSort === 'az') list = [...list].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh'));
    else if (sceneSort === 'za') list = [...list].sort((a, b) => String(b.name || '').localeCompare(String(a.name || ''), 'zh'));
    return list;
  }, [scenes, scriptCategory, sceneSort]);
  /** 当前页签角色列表套用既有筛选/排序（已选/未选 + 名称排序） */
  const displayChars = useMemo(() => {
    let list = tabChars;
    if (charFilter === 'selected') list = list.filter(c => selected.has(c.name));
    else if (charFilter === 'unselected') list = list.filter(c => !selected.has(c.name));
    if (charSort === 'az') list = [...list].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
    else if (charSort === 'za') list = [...list].sort((a, b) => String(b.name).localeCompare(String(a.name), 'zh'));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabChars, charFilter, charSort, selected]);

  // Auto-select default werewolf characters when entering rules+ww mode
  useEffect(() => {
    if (!isRulesMode || rulesTab !== 'ww') return;
    if (characters.length === 0) return;
    const available = new Set(characters.map(c => c.name));
    setSelected(prev => {
      const n = new Set(prev);
      WEREWOLF_DEFAULTS.forEach(d => {
        // P-0803-H（需求 7）：用户自己的角色卡不默认勾选
        if (d !== myCharName && available.has(d)) n.add(d);
      });
      return n;
    });
  }, [isRulesMode, rulesTab, characters.length, myCharName]);

  const toggleCharacter = (name: string) => {
    setSelected(prev => {
      const n = new Set(prev);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  };

  /** P-0803-H：点开剧本卡 → 自动带上默认角色组（排除用户自己的角色卡，需求 3+7）+ 切到该剧本的角色页签 */
  const selectScript = (scene: Scene) => {
    setActiveScene(scene);
    setOpenScript(scene);
    setSelected(prev => {
      const n = new Set(prev);
      (scene.default_roles || []).filter(Boolean).forEach((nm: string) => {
        if (nm !== myCharName) n.add(nm);
      });
      return n;
    });
    setCharTab(scene.scene_id);
    setStatus(`已选择剧本《${scene.name}》｜默认角色 ${(scene.default_roles || []).length} 个已自动带上（你的角色卡不自动勾选，可手动勾选）`);
  };

  const openNewChar = () => { setModalType('char'); setEditTarget(null); setFormName(''); setFormVoice(''); setFormPersona(''); setFormBg(''); };
  const openEditChar = (ch: Character) => { setModalType('char'); setEditTarget(ch); setFormName(ch.name); setFormVoice(ch.voice); setFormPersona(ch.persona); setFormBg(ch.background); };
  const openNewScene = () => {
    setModalType('scene'); setEditTarget(null); setFormName(''); setFormDesc('');
    setFormCategory(scriptCategory); setFormDefaultRoles(new Set()); setFormDefaultMap(null);
  };
  const openEditScene = (sc: Scene) => {
    setModalType('scene'); setEditTarget(sc); setFormName(sc.name); setFormDesc(sc.description);
    setFormCategory((sc.category || 'general') as any);
    setFormDefaultRoles(new Set((sc.default_roles || []).filter(Boolean)));
    setFormDefaultMap(sc.default_map || null);
  };
  const closeModal = () => setModalType(null);

  const saveChar = async () => {
    if (!formName) return;
    setLoading(true);
    try {
      if (editTarget) {
        const isBound = editTarget.player_id === playerId || editTarget.name === boundCharacterName;
        if (isBound && formName !== editTarget.name) {
          // P-0802-P4（改造方案 §4.1）：玩家本人角色（已绑定 player_id）改名 → 改调局中改名端点
          // （角色库改名 + Router/2D/狼人杀/剧本杀四处运行态同步 + 撞名校验② + 失败回滚）
          await api.playerRename(editTarget.name, formName);
          // 成功后同步本地状态：绑定名换新名；若当前玩家名=旧角色名 → 同步为玩家名
          setBoundCharacterName(formName);
          if (currentPlayer === editTarget.name) setCurrentPlayer(formName);
        } else {
          // 非绑定角色改名 / 绑定角色编辑资料（不改名）→ 仍走原 PUT（client.ts 按绑定状态决定是否携带 player_id）
          await api.updateCharacter(editTarget.name, { name: formName, persona: formPersona, voice: formVoice, background: formBg });
        }
      } else {
        // P-0802-P4：新建角色 —— 当前无绑定角色时自动绑定为「玩家本人角色」，之后创建的不携带 player_id（见 client.ts）
        await api.createCharacter({ name: formName, persona: formPersona, voice: formVoice, background: formBg });
      }
      closeModal();
      await loadState();
    } catch (e: any) { setStatus(e.message); }
    setLoading(false);
  };

  const saveScene = async () => {
    if (!formName || !formDesc) return;
    setLoading(true);
    try {
      // P-0803-H：剧本绑定三字段（category 分类 / default_roles 默认角色组 / default_map 默认地图）
      const data = {
        name: formName,
        description: formDesc,
        category: formCategory,
        default_roles: Array.from(formDefaultRoles),
        // 清除地图用空串（后端语义：null=保留旧值 / 空串=清除 / JSON=写入）
        default_map: formDefaultMap === null || formDefaultMap === undefined ? null : (typeof formDefaultMap === 'string' && formDefaultMap === '' ? '' : formDefaultMap),
      };
      if (editTarget) {
        await api.updateScene(editTarget.scene_id, data);
      } else {
        await api.createScene({ initial_agent_names: [], ...data });
      }
      closeModal();
      await loadState();
      // P-0803-H：保存后同步点开的剧本卡（默认角色/地图/分类变更立即反映到详情面板）
      if (editTarget && openScript?.scene_id === editTarget.scene_id) {
        const updated = useAppStore.getState().scenes.find((s: any) => s.scene_id === editTarget.scene_id);
        if (updated) setOpenScript(updated);
      }
    } catch (e: any) { setStatus(e.message); }
    setLoading(false);
  };

  const deleteScene = async (sc: Scene) => {
    try {
      await api.deleteScene(sc.scene_id);
      // P-0803-H：删除的是点开的剧本卡/当前角色页签 → 关闭详情、回退全部页签
      if (openScript?.scene_id === sc.scene_id) setOpenScript(null);
      if (charTab === sc.scene_id) setCharTab('all');
      await loadState();
    } catch (e: any) { setStatus(e.message); }
  };

  // P-0803-H：角色卡删除（需求 1）—— 前端删除按钮 + 确认（DELETE /api/characters/{name} 后端已就绪）
  const deleteChar = async (ch: Character) => {
    if (!window.confirm(`删除角色「${ch.name}」？删除后不可恢复。`)) return;
    try {
      await api.deleteCharacter(ch.name);
      setSelected(prev => { const n = new Set(prev); n.delete(ch.name); return n; });
      await loadState();
      setStatus(`已删除角色「${ch.name}」`);
    } catch (e: any) { setStatus(e.message); }
  };

  /** P-0803-H：剧本编辑弹窗「生成默认地图」（BSP 确定性生成，契约 v1） */
  const genDefaultMap = async () => {
    setMapGenBusy(true);
    try {
      const r = await api.sceneMap();
      if (r?.map) {
        setFormDefaultMap(r.map);
        setStatus('默认地图已生成（BSP，契约 v1）——保存剧本后生效');
      } else {
        setStatus('默认地图生成失败：响应缺少 map 字段');
      }
    } catch (e: any) { setStatus('默认地图生成失败：' + (e.message || '网络错误')); }
    setMapGenBusy(false);
  };

  const generateChar = async () => {
    if (!formKeyword) return;
    setGenerating(true);
    try { await api.generateCharacter(formKeyword); await loadState(); closeModal(); } catch (e: any) { setStatus(e.message); }
    setGenerating(false);
  };

  const generateScene = async () => {
    if (!formKeyword) return;
    setGenerating(true);
    try { await api.generateScene(formKeyword); await loadState(); closeModal(); } catch (e: any) { setStatus(e.message); }
    setGenerating(false);
  };

  // Free mode: enter scene with characters
  const start = async () => {
    if (!activeScene) { setStatus('请先选择一个场景'); return; }
    if (selectedNames.length === 0) { setStatus('请先选择角色'); return; }
    setStatus('正在进入场景...');
    try {
      const humanPlayers = roomPlayers;
      const scenePlayers = Array.from(new Set([...selectedNames, ...humanPlayers]));
      // P0-1：玩家名与角色库同名时以角色为准——只有玩家名不是任何角色时才视为「我自己」（进导演模式）
      const playerIsRole = characters.some(c => c.name === currentPlayer);
      const hasMe = selectedNames.includes(currentPlayer) && !playerIsRole;
      if (hasMe && mode !== 'werewolf') {
        // Set director mode first BEFORE entering scene
        await setMode('director', '', currentPlayer);
      }
      await enterScene(activeScene.scene_id, scenePlayers, currentPlayer);
      // P0-3 已去除 window.open 双开；C-1：use2D 勾选入口已合并为单一「🎮 2D 模拟」按钮（openPhaserSim），
      // 不再写 roleplay_2d_inline localStorage（ChatPage 面板不再自动展开）
      if (mode === 'werewolf') {
        setStatus('正在初始化狼人杀...');
        await setMode('werewolf', '', currentPlayer);
        // P-0802-C：全量场景玩家（选中角色+房间真人）进 GameState —— 修复 AI 角色从未进局
        const initData = await api.werewolfInit(currentPlayer, scenePlayers);
        // P-0802-F：init 返回 session_id（G0-1），存入 store 供面板 API 调用
        if (initData?.session_id) store.setWerewolfSessionId(initData.session_id);
        // P-0802-J：init 返回本人 role_key（重连/防冒充凭证），存入 store 供恢复对局使用
        if (initData?.role_key) store.setWerewolfRoleKey(initData.role_key);
        const roleData = await api.werewolfStatus(currentPlayer);
        const cnMap: Record<string, string> = {
          werewolf: '狼人', wolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人', villager: '村民',
        };
        const aliveCount = Array.isArray(roleData.alive) ? roleData.alive.length : 0;
        const totalCount = Array.isArray(initData.alive) ? initData.alive.length : scenePlayers.length;
        setStatus('你的身份：' + (cnMap[roleData.your_role] || roleData.your_role || '未知') + ' | 存活 ' + aliveCount + ' 人 | 共 ' + totalCount + ' 人');
      }
    } catch (e: any) { setStatus(e.message || '进入失败'); }
  };

  // Rules mode: werewolf start
  const startWWGame = async () => {
    const names = Array.from(selected);
    if (names.length < 5) { setStatus('至少需要5个角色，当前已选' + names.length + '个'); return; }
    setStatus('正在进入狼人杀...');
    try {
      await enterScene('werewolf_default', names, currentPlayer);
      // P-0803-H（需求 3/4）：狼人杀对局场景标记为狼人杀分类 + 绑定默认角色组 → 在「剧本选择 · 狼人杀模式」页签可见复用
      try {
        await api.updateScene('werewolf_default', { category: 'werewolf', default_roles: names });
        await store.loadState();
      } catch { /* 忽略：场景未落库等非关键路径 */ }
      await setMode('werewolf', '', currentPlayer);
      // P-0802-C：职业配置计数 → player→role map（按选中顺序展开；剩余玩家由后端补齐村民）。
      // P-0802-F：后端已支持宽容解析（大小写不敏感 + 中英文别名 wolf/狼人→WEREWOLF 等），
      //           原实现拼 query（wolf=2&seer=1...）被后端静默丢弃 → 改 body roles。
      const roleMap: Record<string, string> = {};
      let roleIdx = 0;
      const ROLE_ORDER: [string, string][] = [
        ['wolf', 'wolf'], ['seer', 'seer'], ['witch', 'witch'], ['hunter', 'hunter'], ['villager', 'villager'],
      ];
      for (const [key, role] of ROLE_ORDER) {
        const cnt = roleConfig[key] || 0;
        for (let i = 0; i < cnt && roleIdx < names.length; i++) roleMap[names[roleIdx++]] = role;
      }
      // 全量角色（真人+AI）进 GameState —— 修复「AI 从未进局、单机 1 人村民死局」根因（调研报告 §二①-④）；
      // api.werewolfInit 内部 request 已检查 res.ok，失败会抛错进入 catch 提示，不再静默吞掉。
      const initData = await api.werewolfInit(currentPlayer, names, roleMap);
      // P-0802-F：init 返回 session_id（G0-1），存入 store 供面板 API 调用
      if (initData?.session_id) store.setWerewolfSessionId(initData.session_id);
      // P-0802-J：init 返回本人 role_key（重连/防冒充凭证），存入 store 供恢复对局使用
      if (initData?.role_key) store.setWerewolfRoleKey(initData.role_key);
      await loadHistory();
      const roleData = await api.werewolfStatus(currentPlayer);
      const roleMapCn: Record<string, string> = { werewolf:'狼人', wolf:'狼人', seer:'预言家', witch:'女巫', hunter:'猎人', villager:'村民' };
      const phaseMap: Record<string, string> = { night:'夜晚', day_discuss:'讨论', day_vote:'投票', ended:'已结束' };
      const aliveCount = Array.isArray(roleData.alive) ? roleData.alive.length : 0;
      setStatus('你的身份：' + (roleMapCn[roleData.your_role] || roleData.your_role || '未知') +
        ' | 存活 ' + aliveCount + '/' + names.length + ' | 阶段：' + (phaseMap[roleData.phase] || roleData.phase));
      // P-0803-H（需求 8）：狼人杀模式默认 2D —— 开局后自动打开内嵌 2D 视图（玩家角色进 2D 世界）
      if (wwEnable2D) {
        const charDetails = names.map(name => {
          const ch = characters.find(c => c.name === name);
          return ch
            ? { name: ch.name, persona: ch.persona || '', voice: ch.voice || '', background: ch.background || '' }
            : { name, persona: `${name}，一个角色`, voice: '', background: '' };
        });
        setSimChars(charDetails);
        setSimScene('park');
        setShowPhaserSim(true);
        setStatus('已进入狼人杀（默认 2D）｜你的身份：' + (roleMapCn[roleData.your_role] || roleData.your_role || '未知') +
          ' ｜右侧「进入聊天页」可打开游戏面板');
      }
    } catch (e: any) { setStatus(e.message || '进入失败'); }
  };

  const createRoom = async () => {
    setRoomBusy(true);
    setRoomError('');
    try {
      await store.createRoom(currentPlayer);
    } catch (e: any) {
      setRoomError(e.message || '创建房间失败');
    } finally {
      setRoomBusy(false);
    }
  };

  const joinRoom = async () => {
    if (!joinCode.trim()) return;
    setRoomBusy(true);
    setRoomError('');
    try {
      await store.joinRoom(joinCode, currentPlayer);
    } catch (e: any) {
      setRoomError(e.message || '加入房间失败');
    } finally {
      setRoomBusy(false);
    }
  };

  const leaveRoom = async () => {
    setRoomBusy(true);
    setRoomError('');
    try {
      await store.leaveRoom();
    } catch (e: any) {
      setRoomError(e.message || '离开房间失败');
    } finally {
      setRoomBusy(false);
    }
  };

  // 剧本杀：AI 生成剧本（调后端 /api/script/init，后端分配角色 + 发放 secrets）
  const genScript = async () => {
    if (!scriptPrompt.trim()) { setStatus('请先输入剧本提示词'); return; }
    let players = selectedNames.filter(Boolean);
    if (!players.includes(currentPlayer)) players = [currentPlayer, ...players];
    if (players.length < 2) { setStatus('至少需要选择 2 个角色作为玩家'); return; }
    setGenerating(true);
    setStatus('AI 正在创作剧本，请稍候（约 30-60 秒）...');
    try {
      const game = await api.scriptInit(scriptPrompt.trim(), players);
      // P-0802-J：剧本杀 session_id 存入 store —— SSE 会话定向连接（script_* 事件按此接收）
      if (game?.session_id) store.setScriptSessionId(game.session_id);
      setScriptGame(game);
      // P-0803-D 方案 A 前端消费：init 响应已含自动生成的地图（后端自动串联）→ 直接渲染，无需手动点「生成地图」
      if (game?.map) {
        setScriptMap(game.map);
        setScriptMapSearched(Array.isArray(game.searched_locations) ? game.searched_locations : []);
      }
      // init 返回的是第一位玩家（即 currentPlayer）的视角，含 your_role / your_secret
      setScriptMyRole(game.your_role || '');
      setScriptMySecret(game.your_secret || '');
      setStatus(`剧本《${game.name}》已生成，正在自动进入对局...`);
      // P0-5：两步式改一步式——生成成功后自动进入开局流程，消除「不知要再点开始游戏」的困惑
      await startScript(game);
    } catch (e: any) {
      setStatus(e.message || '剧本生成失败');
    }
    setGenerating(false);
  };

  // 剧本杀：恢复已有对局（resume → 复用 startScript 进入流程；自动补建场景）
  const doResumeScript = async () => {
    if (!resumeSid.trim()) { setStatus('请输入对局 ID（session_id）'); return; }
    setLoading(true);
    try {
      const game = await api.scriptResume({
        game_id: resumeSid.trim(),
        ...(resumeKey.trim() ? { player_key: resumeKey.trim() } : {}),
      });
      if (game?.error) { setStatus(game.error); setLoading(false); return; }
      if (game?.session_id) store.setScriptSessionId(game.session_id);
      setScriptGame(game);
      if (game?.map) {
        setScriptMap(game.map);
        setScriptMapSearched(Array.isArray(game.searched_locations) ? game.searched_locations : []);
      }
      setScriptMyRole(game.your_role || '');
      setScriptMySecret(game.your_secret || '');
      setStatus(`正在进入已恢复的对局《${game.name || ''}》...`);
      await startScript(game);
      setStatus(`已恢复对局《${game.name || ''}》｜你的角色：${game.your_role || '未知'}｜阶段：${game.phase || ''}`);
    } catch (e: any) {
      setStatus(e.message || '恢复对局失败');
    }
    setLoading(false);
  };

  // 剧本杀：进入对局（建场景 → 启动会话 → 切 script 模式 → 刷新历史）
  const startScript = async (gameOverride?: any) => {
    const game = gameOverride || scriptGame;
    if (!game) { setStatus('请先点击「AI 生成剧本」'); return; }
    const players: string[] = (game.players && game.players.length)
      ? game.players
      : Array.from(new Set([currentPlayer, ...selectedNames])).filter(Boolean);
    if (players.length === 0) { setStatus('玩家列表为空'); return; }
    setLoading(true);
    setStatus('正在进入剧本杀对局...');
    try {
      const sceneId = 'script_' + String(game.name || 'murder').slice(0, 20);
      const exists = scenes.some((s: any) => s.scene_id === sceneId);
      if (!exists) {
        await api.createScene({
          scene_id: sceneId,
          name: game.name || '剧本杀',
          description: game.background || game.name || '',
          initial_agent_names: players,
        });
        await store.loadState();
      }
      await store.enterScene(sceneId, players, currentPlayer);
      await store.setMode('script', '', currentPlayer);
      await store.loadHistory();
      const st = await api.scriptStatus(currentPlayer);
      setScriptMyRole(st.your_role || '');
      setScriptMySecret(st.your_secret || '');
      setStatus(`已进入《${game.name}》｜你的角色：${st.your_role || '未知'}｜阶段：搜证（在聊天页左侧面板选地点查线索）`);
    } catch (e: any) {
      setStatus(e.message || '进入剧本杀失败');
    }
    setLoading(false);
  };

  // 剧本杀：阶段 2 —— 生成/获取对局地图（LLM 统一路径 → 契约 v1 校验 → BSP 降级兜底；已生成过返回缓存）
  const genScriptMap = async (regenerate = false) => {
    if (!scriptGame) { setStatus('请先点击「AI 生成剧本」创建对局'); return; }
    const sessionId = scriptGame.session_id || scriptGame.game_id || '';
    if (!sessionId) { setStatus('对局 session_id 缺失（请先 AI 生成剧本）'); return; }
    setMapBusy(true);
    setStatus(regenerate ? '正在重新生成地图（LLM → 校验 → BSP 兜底）...' : '正在生成地图（LLM → 校验 → BSP 兜底）...');
    try {
      const r = await api.scriptMap({ session_id: sessionId, theme: scriptGame.name || '' });
      if (r.error) { setStatus('生成地图失败：' + r.error); return; }
      const map = r.map;
      if (!map) { setStatus('生成地图失败：响应缺少 map 字段'); return; }
      setScriptMap(map);
      // P-0803-E 方案 B: 足迹随地图响应下发（重连/重生成后绿点恢复）
      setScriptMapSearched(Array.isArray(r.searched_locations) ? r.searched_locations : []);
      setScriptMapMeta({ generator: r.generator, validation: r.validation, fallback: r.fallback || [], cached: !!r.cached });
      const kind = (map.generator && map.generator.kind) || (r.generator && r.generator.kind) || 'unknown';
      setStatus(
        `地图《${map.name || '未命名'}》已就绪：${map.width}×${map.height} 格、${(map.zones || []).length} 个搜证热点、` +
        `${(map.spawn_points || []).length} 个出生点；生成器：${kind === 'bsp' ? 'BSP（降级兜底）' : 'LLM'}${r.cached ? '（缓存命中）' : ''}` +
        ((r.fallback || []).length ? `；兜底：${r.fallback.join('、')}` : '')
      );
    } catch (e: any) {
      setStatus('生成地图失败：' + (e.message || '网络错误'));
    } finally {
      setMapBusy(false);
    }
  };

  const shortText = (t: string, n: number) => (t || '').length > n ? (t || '').slice(0, n) + '...' : (t || '');

  const createDefaults = async () => {
    setLoading(true);
    const available = new Set(characters.map(c => c.name));
    const toCreate = WEREWOLF_DEFAULTS.filter(d => !available.has(d));
    for (const name of toCreate) {
      try { await api.createCharacter({ name, persona: name + '，普通角色', voice: '正常说话', background: '未知' }); } catch {}
    }
    await loadState();
    setLoading(false);
  };

  const missingDefaults = WEREWOLF_DEFAULTS.filter(d => !new Set(characters.map(c => c.name)).has(d));

  return (
    <div className="setup-page">
      <div className="panel" style={{ maxWidth: 'none', margin: '0 auto', border: 0, borderRadius: 12, padding: 32, gridColumn: '1 / -1', width: '100%' }}>
        {showPhaserSim ? (
          /* ── P-0802-G：2D 模式 —— 隐藏场景设置区（角色/场景列表等全部折叠），2D 视图占主体区域；退出恢复原布局 ── */
          <div>
            <div className="section-row" style={{ marginBottom: 16 }}>
              <h2 style={{ margin: 0 }}>2D 模拟</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                <span className="status-pill">角色 {simChars.length}</span>
                {/* P-0803-H（需求 8）：狼人杀模式默认 2D —— 2D 视图内直达聊天页游戏面板 */}
                {mode === 'werewolf' && (
                  <button className="btn btn-small btn-primary" onClick={() => store.goToView('chat')}>🎮 游戏面板（聊天页）</button>
                )}
                <button className="btn btn-small btn-danger" onClick={() => setShowPhaserSim(false)}>✕ 退出 2D（返回场景设置）</button>
              </div>
            </div>
            {/* P-0802-L：2D 高度视口自适应（原固定 640 在较矮视口底部溢出 ~46px 产生滚动）——
                非 host 开销约 198px（面板 padding 64 + 标题行 51 + Phaser 工具条/折叠条 83），
                calc(100vh - 210px) 留 12px 余量，max(480px,…) 保底地图最小可用高度 */}
            <PhaserSimulationView key={simScene} characters={simChars} scene={simScene} playerName={currentPlayer} height={'max(480px, calc(100vh - 210px))'} />
          </div>
        ) : (
          <>
        <div className="section-row" style={{ marginBottom: 24 }}>
          <h2 style={{ margin: 0 }}>{isRulesMode ? '规则模式' : '剧本选择'}</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <span className="status-pill">角色 {characters.length}</span>
            {!isRulesMode && <span className="status-pill">剧本 {scenes.length}</span>}
            <button className="btn" onClick={() => goToView('config')}>素材库</button>
          </div>
        </div>

        {/* ===== Character Selection (shared) ===== */}
        <section className="panel" style={{ border: 0, borderRadius: 8 }}>
          <div className="panel-body">
            <div className="section" style={{ marginBottom: 12 }}>
              <div className="section-row" style={{ marginBottom: 12 }}>
                <div className="label" style={{ fontSize: 15, fontWeight: 600 }}>角色库</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-small" onClick={() => setSelected(new Set(characters.map(c => c.name)))}>全选</button>
                  <button className="btn btn-small" onClick={() => setSelected(new Set())}>清空</button>
                  <button className="btn btn-small btn-primary" onClick={openNewChar}>+ 新建</button>
                </div>
              </div>
              {/* P-0803-H（需求 6）：角色卡按所属场景（剧本 default_roles）分类展示 + 自由角色卡页 */}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                <button className={`chip ${charTab === 'all' ? 'active' : ''}`} onClick={() => setCharTab('all')}>全部</button>
                {scriptGroups.map((s: any) => (
                  <button key={s.scene_id} className={`chip ${charTab === s.scene_id ? 'active' : ''}`}
                    onClick={() => { setCharTab(s.scene_id); setActiveScene(s); setOpenScript(s); }}>
                    {s.name || s.scene_id}
                  </button>
                ))}
                <button className={`chip ${charTab === 'free' ? 'active' : ''}`} onClick={() => setCharTab('free')}>自由角色卡</button>
                <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 4 }}>
                  {myCharName ? `我的角色「${myCharName}」每栏置顶 · 不默认勾选` : '（未绑定玩家角色）'}
                </span>
              </div>
              {/* C-1（P3-11）：角色筛选 + 排序（已选/未选 + 名称 A-Z/Z-A） */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                <select className="input" style={{ width: 110, padding: '3px 6px', fontSize: 12 }} value={charFilter} onChange={e => setCharFilter(e.target.value as any)} title="角色分类：按选中状态筛选">
                  <option value="all">分类：全部</option>
                  <option value="selected">分类：已选</option>
                  <option value="unselected">分类：未选</option>
                </select>
                <select className="input" style={{ width: 110, padding: '3px 6px', fontSize: 12 }} value={charSort} onChange={e => setCharSort(e.target.value as any)} title="角色排序">
                  <option value="default">排序：默认</option>
                  <option value="az">排序：名称 A-Z</option>
                  <option value="za">排序：名称 Z-A</option>
                </select>
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>共 {displayChars.length} / {characters.length} 个</span>
              </div>
              <div className="grid-list char-grid">
                {/* Me 角色卡 — 玩家身份输入入口（P-0803-H 需求 7：不默认勾选） */}
                {(() => {
                  const meSel = selected.has(currentPlayer);
                  // P0-1：玩家名与角色库同名 → 以角色为准（提示，不再被识别成玩家自己/导演）
                  const meNameCollides = characters.some(c => c.name === currentPlayer);
                  return (
                    <button type="button" className={`char-card me-char-card ${meSel ? 'selected' : ''}`}
                      onClick={() => toggleCharacter(currentPlayer)}
                    >
                      <div className="me-char-content">
                        <div className="char-avatar me-avatar">你</div>
                        <div className="char-info" style={{ flex: 1 }}>
                          <div className="char-name" style={{ marginBottom: 4 }}>
                            {currentPlayer || '你的角色'}
                          </div>
                          <input
                            className="me-char-input"
                            value={currentPlayer}
                            onChange={e => {
                              const oldName = currentPlayer;
                              store.setCurrentPlayer(e.target.value);
                              const newName = e.target.value;
                              // Sync selected set: remove old, add new
                              setSelected(prev => {
                                const n = new Set(prev);
                                if (oldName && n.has(oldName)) {
                                  n.delete(oldName);
                                  if (newName.trim()) n.add(newName.trim());
                                }
                                return n;
                              });
                            }}
                            placeholder="输入角色名"
                            onFocus={() => { /* don't interfere */ }}
                          />
                          {meNameCollides && (
                            <div style={{ fontSize: 10, color: '#d6a33d', marginTop: 2 }}>
                              ⚠️ 与角色「{currentPlayer}」同名，将以角色身份参与
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })()}
                {/* P-0803-H（需求 1/7）：每栏用户角色置顶（withMeFirst 已排序）+ 编辑/删除按钮 */}
                {displayChars.map(ch => {
                  const sel = selected.has(ch.name);
                  const isDefault = WEREWOLF_DEFAULTS.includes(ch.name);
                  const isMine = ch.name === myCharName;
                  return (
                    <div key={ch.name} className={`char-card-wrap ${isMine ? 'mine' : ''}`}>
                      <button type="button"
                        className={`char-card ${sel ? 'selected' : ''} ${isMine ? 'mine-card' : ''}`}
                        onClick={() => toggleCharacter(ch.name)}
                        onContextMenu={e => { e.preventDefault(); openEditChar(ch); }}
                      >
                        <div className="char-avatar">{ch.name[0]}</div>
                        <div className="char-info">
                          <div className="char-name">
                            {ch.name}
                            {isMine && <span style={{ fontSize: 10, color: '#7c4dff', marginLeft: 4 }}>我的</span>}
                            {isDefault && isRulesMode && rulesTab === 'ww' && <span style={{ fontSize: 10, color: 'var(--text-2)', marginLeft: 4 }}>默认</span>}
                          </div>
                          <div className="char-tag">{sel ? '已选' : (isMine ? '未勾选（置顶）' : '点击选择')}</div>
                        </div>
                      </button>
                      <span className="char-card-actions">
                        <button className="btn btn-smallall" title={`编辑 ${ch.name}`} onClick={e => { e.stopPropagation(); openEditChar(ch); }}>✎</button>
                        <button className="btn btn-smallall btn-danger" title={`删除 ${ch.name}`} onClick={e => { e.stopPropagation(); deleteChar(ch); }}>✕</button>
                      </span>
                    </div>
                  );
                })}
                {characters.length === 0 && (
                  <div className="muted" style={{ padding: 16, fontSize: 13, textAlign: 'center' }}>还没有角色，点击"+ 新建"创建</div>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* ===== 一般模式：剧本选择（P-0803-H 需求 2/4/5：场景选择→剧本选择 + 分类 + 点开详情） ===== */}
        {!isRulesMode && (
          <>
            <section className="panel" style={{ border: 0, borderRadius: 8, marginTop: 24 }}>
              <div className="panel-body">
                <div className="section" style={{ marginBottom: 12 }}>
                  <div className="section-row" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                    <div className="label" style={{ fontSize: 15, fontWeight: 600 }}>剧本选择</div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      {/* 需求 4：场景分类 —— 一般模式 / 狼人杀模式 */}
                      <button className={`chip ${scriptCategory === 'general' ? 'active' : ''}`} onClick={() => setScriptCategory('general')}>一般模式</button>
                      <button className={`chip ${scriptCategory === 'werewolf' ? 'active' : ''}`} onClick={() => setScriptCategory('werewolf')}>狼人杀模式</button>
                      <select className="input" style={{ width: 110, padding: '3px 6px', fontSize: 12 }} value={sceneSort} onChange={e => setSceneSort(e.target.value as any)} title="剧本排序">
                        <option value="default">排序：默认</option>
                        <option value="az">排序：名称 A-Z</option>
                        <option value="za">排序：名称 Z-A</option>
                      </select>
                      <button className="btn btn-small btn-primary" onClick={openNewScene}>+ 新建剧本</button>
                    </div>
                  </div>
                  <div className="grid-list">
                    {scriptCards.map((scene: Scene) => {
                      const open = openScript?.scene_id === scene.scene_id;
                      const defRoles = (scene.default_roles || []).filter(Boolean) as string[];
                      return (
                        <div key={scene.scene_id} className={`script-card-wrap ${open ? 'open' : ''}`}>
                          <button
                            className={`item-card script-card ${open ? 'selected' : ''}`}
                            onClick={() => selectScript(scene)}
                            onContextMenu={e => { e.preventDefault(); openEditScene(scene); }}
                          >
                            <div className="item-card-title">
                              <span>{scene.name}</span>
                              <span className="item-actions" onClick={e => e.stopPropagation()}>
                                <button className="btn btn-small" onClick={() => openEditScene(scene)}>编辑</button>
                                <button className="btn btn-small btn-danger" onClick={() => deleteScene(scene)}>删除</button>
                              </span>
                            </div>
                            <div className="item-card-desc">{shortText(scene.description, 120)}</div>
                            <div className="script-card-meta">
                              <span className={`chip ${scene.category === 'werewolf' ? 'chip-ww' : 'chip-general'}`}>
                                {scene.category === 'werewolf' ? '🐺 狼人杀模式' : '🎭 一般模式'}
                              </span>
                              <span className="chip">默认角色 {defRoles.length}</span>
                              <span className="chip">{scene.default_map ? '🗺️ 已绑地图' : '🚫 无地图'}</span>
                            </div>
                          </button>
                        </div>
                      );
                    })}
                    {scriptCards.length === 0 && (
                      <div className="muted" style={{ padding: 16, fontSize: 13, textAlign: 'center' }}>
                        {scriptCategory === 'general'
                          ? '还没有一般模式剧本，点击"+ 新建剧本"创建'
                          : '还没有狼人杀模式剧本（开始一局狼人杀后自动生成）'}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>

            {/* ── P-0803-H（需求 5）：点开剧本卡 → 角色卡栏 + 地图预览 + 进入操作 ── */}
            {openScript && (
              <section className="panel" style={{ border: '1px solid var(--accent, #49c16d)', borderRadius: 8, marginTop: 24 }}>
                <div className="panel-body">
                  <div className="section-row" style={{ marginBottom: 12 }}>
                    <div className="label" style={{ fontSize: 15, fontWeight: 600 }}>
                      📜 {openScript.name}（{openScript.category === 'werewolf' ? '🐺 狼人杀模式' : '🎭 一般模式'}）
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-small" onClick={() => openEditScene(openScript)}>编辑剧本</button>
                      <button className="btn btn-small" onClick={() => setOpenScript(null)}>✕ 收起</button>
                    </div>
                  </div>

                  {/* 角色卡栏（该剧本默认角色组；我的角色置顶不默认勾选，需求 5/7） */}
                  <div className="label" style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                    角色卡栏（默认角色 {((openScript.default_roles || []).filter(Boolean) as string[]).length} 个）
                  </div>
                  <div className="grid-list char-grid" style={{ marginBottom: 16 }}>
                    {withMeFirst(
                      (openScript.default_roles || []).filter(Boolean).map((nm: string) =>
                        characters.find(c => c.name === nm)
                      ).filter(Boolean)
                    ).map((ch: Character) => {
                      const sel = selected.has(ch.name);
                      const isMine = ch.name === myCharName;
                      return (
                        <div key={ch.name} className={`char-card-wrap ${isMine ? 'mine' : ''}`}>
                          <button type="button"
                            className={`char-card ${sel ? 'selected' : ''} ${isMine ? 'mine-card' : ''}`}
                            onClick={() => toggleCharacter(ch.name)}
                            onContextMenu={e => { e.preventDefault(); openEditChar(ch); }}
                          >
                            <div className="char-avatar">{ch.name[0]}</div>
                            <div className="char-info">
                              <div className="char-name">
                                {ch.name}
                                {isMine && <span style={{ fontSize: 10, color: '#7c4dff', marginLeft: 4 }}>我的</span>}
                              </div>
                              <div className="char-tag">{sel ? '已选' : (isMine ? '未勾选（置顶）' : '点击选择')}</div>
                            </div>
                          </button>
                          <span className="char-card-actions">
                            <button className="btn btn-smallall" title={`编辑 ${ch.name}`} onClick={e => { e.stopPropagation(); openEditChar(ch); }}>✎</button>
                            <button className="btn btn-smallall btn-danger" title={`删除 ${ch.name}`} onClick={e => { e.stopPropagation(); deleteChar(ch); }}>✕</button>
                          </span>
                        </div>
                      );
                    })}
                    {!((openScript.default_roles || []).filter(Boolean) as string[]).length && (
                      <div className="muted" style={{ padding: 12, fontSize: 12, textAlign: 'center' }}>
                        该剧本尚未绑定默认角色组 —— 点「编辑剧本」从角色库勾选默认角色
                      </div>
                    )}
                  </div>

                  {/* 地图预览（默认地图 → Phaser 渲染；无 → 占位 + 编辑弹窗内可生成，需求 3/5） */}
                  <div className="label" style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>地图预览</div>
                  {openScript.default_map ? (
                    <PhaserScriptMapView map={openScript.default_map} playerName={currentPlayer} height={320} />
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--text-3)', padding: 10, border: '1px dashed var(--border, #334155)', borderRadius: 8, marginBottom: 8 }}>
                      尚未绑定默认地图 —— 点「编辑剧本」→「🗺️ 生成默认地图」（BSP 确定性生成），保存后此处显示预览。
                    </div>
                  )}

                  {/* 进入操作（需求 8：一般模式给「是否 2D」选择；狼人杀模式默认 2D） */}
                  <div style={{ display: 'flex', gap: 12, marginTop: 16, justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}>
                    {openScript.category === 'werewolf' ? (
                      <>
                        <button className="btn btn-primary" disabled={selectedNames.length < 5} onClick={startWWGame}>
                          开始狼人杀（{selectedNames.length} 个角色）
                        </button>
                        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
                          <input type="checkbox" checked={wwEnable2D} onChange={e => setWwEnable2D(e.target.checked)} />
                          🎮 默认 2D（开启后开局自动进入 2D 视图）
                        </label>
                        {store.werewolfSessionId && (
                          <button className="btn" onClick={() => store.goToView('chat')}>🎮 继续对局（进入聊天页）</button>
                        )}
                      </>
                    ) : (
                      <>
                        <button className="btn btn-primary" disabled={selectedNames.length === 0} onClick={() => (enable2D ? openPhaserSim() : start())}>
                          {enable2D ? '进入剧本（2D 模拟）' : `进入剧本（${selectedNames.length} 个角色）`}
                        </button>
                        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
                          <input type="checkbox" checked={enable2D} onChange={e => setEnable2D(e.target.checked)} />
                          是否 2D 模拟（勾选后不进聊天页，直接打开 2D 视图）
                        </label>
                      </>
                    )}
                  </div>
                  {openScript.category === 'werewolf' && selectedNames.length < 5 && (
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8, textAlign: 'center' }}>
                      狼人杀至少 5 人：你的角色卡已置顶未自动勾选，不足 5 人时请手动勾选。
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* ── P-0802-G：原内嵌 2D 视图块已上移为 2D 模式主体（showPhaserSim 时场景设置区整体折叠） ── */}
          </>
        )}

        {/* ===== Rules Mode: Werewolf / Script ===== */}
        {isRulesMode && (
          <section className="panel" style={{ border: 0, borderRadius: 8, marginTop: 24 }}>
            <div className="panel-body">
              <div className="section-row" style={{ marginBottom: 16 }}>
                <div className="label" style={{ fontSize: 15, fontWeight: 600 }}>游戏类型</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className={`chip ${rulesTab === 'ww' ? 'active' : ''}`} onClick={() => setRulesTab('ww')}>狼人杀</button>
                  <button className={`chip ${rulesTab === 'script' ? 'active' : ''}`} onClick={() => setRulesTab('script')}>剧本杀</button>
                </div>
              </div>

              {rulesTab === 'ww' && (
                <div>
                  {/* 联机区域 */}
                  <div className="ww-room-section">
                    <div className="ww-room-header">
                      <span className="ww-room-title">🌐 联机模式</span>
                      {roomCode && <span className="status-pill good">房间 {roomCode}</span>}
                    </div>
                    <div className="ww-room-row">
                      <div className="ww-room-players">
                        <span className="ww-room-label">在线玩家</span>
                        <div className="ww-room-chip-list">
                          {onlinePlayers.length > 0 ? onlinePlayers.map(name => (
                            <span key={name} className={`chip ${name === currentPlayer ? 'selected' : ''}`}>
                              {name}{name === currentPlayer ? ' · 我' : ''}
                            </span>
                          )) : <span className="ww-room-empty">（仅自己）</span>}
                        </div>
                      </div>
                      <div className="ww-room-actions">
                        <input value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} placeholder="房间码" className="ww-room-input" />
                        <button className="btn btn-sm" disabled={roomBusy || !joinCode.trim()} onClick={joinRoom}>加入</button>
                        <button className="btn btn-sm btn-primary" disabled={roomBusy} onClick={createRoom}>创建房间</button>
                        {roomCode && <button className="btn btn-sm btn-danger" disabled={roomBusy} onClick={leaveRoom}>离开</button>}
                      </div>
                    </div>
                    {roomError && <div className="status-pill warn" style={{marginTop:8}}>{roomError}</div>}
                  </div>

                  <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 8 }}>
                    选择5个以上角色即可开始。默认角色（苏哲、林诗、老王、小美、阿强）自动选中。
                    {missingDefaults.length > 0 && (
                      <>
                        {'  '}缺少 {missingDefaults.length} 个默认角色。
                        <button className="btn btn-small" style={{marginLeft:8}} disabled={loading} onClick={createDefaults}>
                          {loading ? '创建中...' : '一键创建默认角色'}
                        </button>
                      </>
                    )}
                  </p>
                  {roomPlayers.length > 0 && (
                    <p style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8 }}>
                      房间：{roomCode} | 真人玩家：{roomPlayers.join('、')}
                    </p>
                  )}
                  <button className="btn btn-primary" disabled={selectedNames.length < 5} onClick={startWWGame}>
                    开始狼人杀（{selectedNames.length} 个角色）
                  </button>
                  {/* P-0803-H（需求 8）：狼人杀模式默认 2D —— checkbox 默认勾选，开局自动进入 2D 视图 */}
                  <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer', marginLeft: 8 }}>
                    <input type="checkbox" checked={wwEnable2D} onChange={e => setWwEnable2D(e.target.checked)} />
                    🎮 默认 2D
                  </label>
                  {store.werewolfSessionId && (
                    <button className="btn" style={{ marginLeft: 8 }} onClick={() => store.goToView('chat')}>🎮 继续对局（进入聊天页）</button>
                  )}
                  <button className="btn btn-small" style={{marginLeft:8}} onClick={() => setShowAdvanced(!showAdvanced)}>
                    {showAdvanced ? '收起' : '高级选项'}
                  </button>
                  {showAdvanced && (
                    <div className="card" style={{marginTop:12, padding:12, background:'var(--bg-2)'}}>
                      <div style={{fontSize:13, fontWeight:600, marginBottom:8}}>职业配置</div>
                      <div className="kv" style={{gridTemplateColumns:'auto 1fr', gap:6}}>
                        {[
                          {key:'wolf', label:'狼人', min:0, max:5},
                          {key:'seer', label:'预言家', min:0, max:1},
                          {key:'witch', label:'女巫', min:0, max:1},
                          {key:'hunter', label:'猎人', min:0, max:1},
                          {key:'villager', label:'村民', min:0, max:10},
                        ].map(r => (
                          <div key={r.key} className="section-row" style={{justifyContent:'space-between', width:'100%'}}>
                            <span style={{fontSize:13}}>{r.label}</span>
                            <div style={{display:'flex', gap:4, alignItems:'center'}}>
                              <button className="btn btn-small" disabled={(roleConfig[r.key]||0) <= r.min}
                                onClick={() => setRoleConfig(rc => ({...rc, [r.key]: (rc[r.key]||0)-1}))}>-</button>
                              <span style={{width:28, textAlign:'center', fontSize:13}}>{roleConfig[r.key]||0}</span>
                              <button className="btn btn-small" disabled={(roleConfig[r.key]||0) >= r.max}
                                onClick={() => setRoleConfig(rc => ({...rc, [r.key]: (rc[r.key]||0)+1}))}>+</button>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div style={{fontSize:12, color:'var(--text-2)', marginTop:8}}>
                        职业总数：{Object.values(roleConfig).reduce((a,b)=>a+b,0)} / 选中角色：{selectedNames.length}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {rulesTab === 'script' && (
                <div>
                  <textarea
                    value={scriptPrompt}
                    onChange={e => setScriptPrompt(e.target.value)}
                    placeholder="描述你想玩的剧本，例如：民国悬疑、一栋别墅里发生命案，5个角色各有秘密..."
                    rows={3}
                    style={{ width: '100%', marginBottom: 8 }}
                  />
                  <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                    <button className="btn btn-primary" disabled={!scriptPrompt || generating} onClick={genScript}>
                      {generating ? '生成中...' : 'AI 生成剧本'}
                    </button>
                  </div>
                  {/* P-0803-H2：恢复对局（重连）—— 对局不在场景列表，刷新/重启后从这里找回 */}
                  <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input
                      value={resumeSid}
                      onChange={e => setResumeSid(e.target.value)}
                      placeholder="对局 ID（session_id）"
                      style={{ flex: 1, minWidth: 160 }}
                    />
                    <input
                      value={resumeKey}
                      onChange={e => setResumeKey(e.target.value)}
                      placeholder="player_key（可选，默认以 me 身份）"
                      style={{ flex: 1, minWidth: 160 }}
                    />
                    <button className="btn" disabled={loading || !resumeSid.trim()} onClick={doResumeScript}>
                      {loading ? '恢复中...' : '↻ 恢复对局（重连）'}
                    </button>
                  </div>
                  {scriptGame && (
                    <div className="card" style={{ marginTop: 12, padding: 12, background: 'var(--bg-2)' }}>
                      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>📜 《{scriptGame.name}》</div>
                      <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 8 }}>{scriptGame.background}</div>
                      <div style={{ fontSize: 12, marginBottom: 4 }}><strong>角色</strong>：{(scriptGame.roles || []).join('、')}</div>
                      <div style={{ fontSize: 12, marginBottom: 4 }}><strong>地点</strong>：{(scriptGame.locations || []).join('、')}</div>
                      <div style={{ fontSize: 12, marginBottom: 4 }}><strong>线索</strong>：{(scriptGame.clues || []).length} 条（搜证阶段按地点获取）</div>
                      <div style={{ fontSize: 12, marginBottom: 8 }}>
                        <strong>你的身份</strong>：{scriptMyRole || '（分配中）'}
                        {scriptMySecret && (
                          <div style={{ marginTop: 4, color: '#d6a33d' }}>🔒 你的秘密：{scriptMySecret}</div>
                        )}
                      </div>
                      <button className="btn btn-primary" disabled={loading} onClick={startScript}>
                        {loading ? '进入中...' : '开始游戏（进入对局）'}
                      </button>
                    </div>
                  )}
                  {/* ════ 阶段 2：对局地图（LLM 生成 → 契约 v1 → Phaser 渲染 + 热点搜证）════ */}
                  {scriptGame && (
                    <div className="card" style={{ marginTop: 12, padding: 12, background: 'var(--bg-2)' }}>
                      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>🗺️ 对局地图（阶段 2：LLM 生成 → Phaser 渲染 + 热点搜证）</div>
                      <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 8 }}>
                        地图与对局绑定（zones[].clue_location ↔ clues[].location 搜证热点）；已生成过时默认返回缓存，点「🔄 重新生成」强制覆盖。
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                        <button className="btn" disabled={mapBusy} onClick={() => genScriptMap(false)}>
                          {mapBusy ? '生成中...' : '🗺️ 生成地图'}
                        </button>
                        {scriptMap && (
                          <button className="btn btn-small" disabled={mapBusy} onClick={() => genScriptMap(true)} title="强制重新生成（regenerate=true，重新调 LLM）">
                            🔄 重新生成
                          </button>
                        )}
                      </div>
                      {scriptMapMeta && (
                        <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8 }}>
                          生成器：{(scriptMapMeta.generator && scriptMapMeta.generator.kind) === 'bsp' ? 'BSP（降级兜底）' : 'LLM（统一路径）'}
                          {scriptMapMeta.cached ? ' ｜ 缓存命中' : ''}
                          {scriptMapMeta.validation && !scriptMapMeta.validation.ok
                            ? ` ｜ 校验：${(scriptMapMeta.validation.errors || []).length} 错误 / ${(scriptMapMeta.validation.warnings || []).length} 警告`
                            : ''}
                          {(scriptMapMeta.fallback || []).length > 0 ? ` ｜ 兜底：${scriptMapMeta.fallback.join('、')}` : ''}
                        </div>
                      )}
                      {scriptMap ? (
                        <PhaserScriptMapView
                          map={scriptMap}
                          playerName={currentPlayer}
                          height={480}
                          searchedLocations={scriptMapSearched}
                        />
                      ) : (
                        <div style={{ fontSize: 12, color: 'var(--text-3)', padding: 8, border: '1px dashed var(--border, #334155)', borderRadius: 8 }}>
                          尚未生成地图 —— 点击「🗺️ 生成地图」（LLM 统一路径，失败自动 BSP 降级兜底；热点搜证联动剧本杀线索体系）。
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {status && <div className="status" style={{ marginTop: 12, textAlign: 'center', fontSize: 13, color: 'var(--text-2)' }}>{status}</div>}
          </>
        )}

        {/* ===== Character Modal ===== */}
        {modalType === 'char' && (
          <div className="modal-overlay" onClick={closeModal}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 500 }}>
              <div className="modal-header">
                <h3>{editTarget ? '编辑角色' : '新建角色'}</h3>
                <button className="btn btn-small" onClick={closeModal}>X</button>
              </div>
              <div className="modal-body">
                <div className="form-grid">
                  <div className="form-row">
                    <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="角色名" />
                    <input value={formVoice} onChange={e => setFormVoice(e.target.value)} placeholder="说话风格" />
                  </div>
                  <textarea value={formPersona} onChange={e => setFormPersona(e.target.value)} placeholder="人格设定：性格、动机、禁忌、关系等" rows={4} />
                  <textarea value={formBg} onChange={e => setFormBg(e.target.value)} placeholder="背景故事" rows={3} />
                  <div className="form-row">
                    <input style={{ flex: 1 }} value={formKeyword} onChange={e => setFormKeyword(e.target.value)} onKeyDown={e => e.key === 'Enter' && generateChar()} placeholder="AI 生成：输入关键词" />
                    <button className="btn" disabled={generating} onClick={generateChar}>{generating ? '生成中...' : 'AI 生成'}</button>
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn" onClick={closeModal}>取消</button>
                <button className="btn btn-primary" disabled={loading} onClick={saveChar}>{loading ? '保存中...' : '保存'}</button>
              </div>
            </div>
          </div>
        )}

        {/* ===== Scene Modal（P-0803-H：剧本卡编辑 —— 分类 / 默认角色组 / 默认地图） ===== */}
        {modalType === 'scene' && (
          <div className="modal-overlay" onClick={closeModal}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 560, maxHeight: '86vh', display: 'flex', flexDirection: 'column' }}>
              <div className="modal-header">
                <h3>{editTarget ? '编辑剧本' : '新建剧本'}</h3>
                <button className="btn btn-small" onClick={closeModal}>X</button>
              </div>
              <div className="modal-body" style={{ overflowY: 'auto', flex: 1 }}>
                <div className="form-grid">
                  <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="剧本名" />
                  {/* 需求 4：场景分类 —— 一般模式 / 狼人杀模式 */}
                  <div className="form-row" style={{ alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>分类：</span>
                    <button className={`chip ${formCategory === 'general' ? 'active' : ''}`} onClick={() => setFormCategory('general')}>一般模式</button>
                    <button className={`chip ${formCategory === 'werewolf' ? 'active' : ''}`} onClick={() => setFormCategory('werewolf')}>狼人杀模式</button>
                  </div>
                  <textarea value={formDesc} onChange={e => setFormDesc(e.target.value)} placeholder="剧本描述：地点、冲突、已知事实、开局状态等" rows={3} />
                  <div className="form-row">
                    <input style={{ flex: 1 }} value={formKeyword} onChange={e => setFormKeyword(e.target.value)} onKeyDown={e => e.key === 'Enter' && generateScene()} placeholder="AI 生成：输入关键词" />
                    <button className="btn" disabled={generating} onClick={generateScene}>{generating ? '生成中...' : 'AI 生成'}</button>
                  </div>
                  {/* 默认角色组（需求 3）：从角色库勾选，选择剧本时自动带上 */}
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                      默认角色组（选择剧本时自动带上）—— 已选 {formDefaultRoles.size} 个
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 110, overflowY: 'auto', border: '1px solid var(--border, #334155)', borderRadius: 6, padding: 6 }}>
                      {characters.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>暂无角色，先到角色库新建</span>}
                      {characters.map(c => (
                        <label key={c.name} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12, cursor: 'pointer', padding: '2px 6px', borderRadius: 4, background: formDefaultRoles.has(c.name) ? 'rgba(102,126,234,.15)' : 'transparent' }}>
                          <input
                            type="checkbox"
                            checked={formDefaultRoles.has(c.name)}
                            onChange={e => setFormDefaultRoles(prev => { const n = new Set(prev); e.target.checked ? n.add(c.name) : n.delete(c.name); return n; })}
                          />
                          {c.name}
                          {c.player_id === playerId ? '（我的）' : ''}
                        </label>
                      ))}
                    </div>
                  </div>
                  {/* 默认地图（需求 3）：BSP 确定性生成 → 预览 → 保存 */}
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>默认地图（点开剧本卡后地图预览）</div>
                    {formDefaultMap ? (
                      <>
                        <PhaserScriptMapView map={formDefaultMap} playerName={currentPlayer} height={200} />
                        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                          <button className="btn btn-small" disabled={mapGenBusy} onClick={genDefaultMap}>{mapGenBusy ? '生成中...' : '🔄 重新生成'}</button>
                          <button className="btn btn-small btn-danger" onClick={() => setFormDefaultMap('')}>清除地图</button>
                        </div>
                      </>
                    ) : (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <button className="btn btn-small" disabled={mapGenBusy} onClick={genDefaultMap}>{mapGenBusy ? '生成中...' : '🗺️ 生成默认地图'}</button>
                        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>BSP 确定性生成（契约 v1），保存后生效</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn" onClick={closeModal}>取消</button>
                <button className="btn btn-primary" disabled={loading} onClick={saveScene}>{loading ? '保存中...' : '保存'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
