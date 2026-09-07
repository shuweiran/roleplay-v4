/**
 * GameBridge.tsx — 真实对局启动器（接后端游玩）
 *
 * 一般·自由聊天且玩家扮演角色时，先进入 Director preflight：
 * 身份/关系/在场角色/出场顺序确认完成后才创建真实场景。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDemoStore } from '../store';
import { useAppStore } from '../../store/appStore';
import { api } from '../../api/client';
import { directorApi } from '../../api/director';
import { getGeneralScriptById, getMurderScriptById } from '../mockData';
import { ChatPage } from '../../components/ChatPage/ChatPage';
import { GalGeneralView } from '../../gal/GalGeneralView';
import { useGalStore } from '../../gal/GalStore';
import { PhaserSimulationView } from '../../phaser/PhaserSimulationView';
import type { ScriptMap } from '../../phaser/mapData';
import type { GeneralScript, RoleCard } from '../types';
import { DirectorPreflightPanel, DirectorRuntimePanel } from '../components/DirectorChatPanels';

const WW_AI_NAMES = ['AI·白', 'AI·青', 'AI·玄', 'AI·墨', 'AI·雪', 'AI·枫', 'AI·岚', 'AI·渊'];

type Phase = 'preflight' | 'launching' | 'ready' | 'error';

export function GameBridge() {
  const gameMode = useDemoStore(s => s.gameMode);
  const gamePlayers = useDemoStore(s => s.gamePlayers);
  const runMode = useDemoStore(s => s.runMode);
  const withPlayer = useDemoStore(s => s.withPlayer);
  const selectCtx = useDemoStore(s => s.selectCtx);
  const playerRole = useDemoStore(s => s.playerRole);
  const generatedMurder = useDemoStore(s => s.generatedMurder);
  const generatedGeneral = useDemoStore(s => s.generatedGeneral);
  const backendMurder = useDemoStore(s => s.backendMurder);
  const backendGeneral = useDemoStore(s => s.backendGeneral);
  const freeRoles = useDemoStore(s => s.freeRoles);
  const genRoles = useDemoStore(s => s.genRoles);
  const extraRoles = useDemoStore(s => s.extraRoles);
  const go = useDemoStore(s => s.go);
  const back = useDemoStore(s => s.back);

  const [phase, setPhase] = useState<Phase>('launching');
  const [step, setStep] = useState('正在初始化…');
  const [error, setError] = useState('');
  const startedRef = useRef(false);
  const [galClassic, setGalClassic] = useState(false);
  const [chatSessionId, setChatSessionId] = useState('');
  const [exploreMap, setExploreMap] = useState<ScriptMap | null>(null);
  const [preflightId, setPreflightId] = useState('');
  const [preflightReply, setPreflightReply] = useState('');
  const [preflightState, setPreflightState] = useState<any>(null);

  const generalSessionId = useAppStore(s => s.sessionId);
  const generalMaps = useDemoStore(s => s.generalMaps);
  const setGeneralMap = useDemoStore(s => s.setGeneralMap);
  const mapGen = useDemoStore(s => s.settings.mapGen);

  const script = useMemo(() => {
    if (gameMode === 'murder') {
      return selectCtx.scriptId
        ? (getMurderScriptById(selectCtx.scriptId) ?? (generatedMurder?.id === selectCtx.scriptId ? generatedMurder : undefined) ?? backendMurder.find(x => x.id === selectCtx.scriptId))
        : undefined;
    }
    if (gameMode === 'general') {
      return selectCtx.scriptId
        ? (getGeneralScriptById(selectCtx.scriptId) ?? (generatedGeneral?.id === selectCtx.scriptId ? generatedGeneral : undefined) ?? backendGeneral.find(x => x.id === selectCtx.scriptId))
        : undefined;
    }
    return undefined;
  }, [gameMode, selectCtx, generatedMurder, generatedGeneral, backendMurder, backendGeneral]);

  const roleByName = useMemo(() => {
    const map = new Map<string, RoleCard>();
    const put = (r: RoleCard) => map.set(r.name, r);
    script?.roles.forEach(put);
    (extraRoles[selectCtx.scriptId ?? ''] || []).forEach(put);
    genRoles.forEach(put);
    freeRoles.forEach(put);
    if (playerRole) put(playerRole);
    return map;
  }, [script, extraRoles, selectCtx.scriptId, genRoles, freeRoles, playerRole]);

  const characterDetails = (names: string[]) => names.map(name => {
    const r = roleByName.get(name);
    return r ? {
      name: r.name,
      persona: r.personality || '',
      personality: r.personality || '',
      voice: r.tts?.voice || r.talkStyle || '',
      talk_style: r.talkStyle || '',
      background: r.background || '',
      intro: r.intro || '',
    } : { name };
  });

  const launch = async (confirmedPreflightId = '') => {
    const app = useAppStore.getState();
    setPhase('launching');
    try {
      if (!useAppStore.getState().initialized) {
        setStep('正在连接后端…');
        await app.loadState();
      }

      if (gameMode === 'murder') {
        const savedSessionId = localStorage.getItem('scriptSessionId') || '';
        const savedRoleKey = localStorage.getItem('scriptRoleKey') || '';
        if (savedSessionId && savedRoleKey) {
          setStep('正在恢复剧本杀对局…');
          const resumed = await api.scriptResume({ game_id: savedSessionId, player_key: savedRoleKey });
          if (resumed?.error) throw new Error(String(resumed.error));
          const resumedPlayer = String(resumed?.player || app.currentPlayer || '');
          if (!resumedPlayer || !resumed?.session_id) throw new Error('恢复响应缺少玩家或 session_id');
          app.setScriptSessionId(String(resumed.session_id));
          app.setScriptRoleKey(savedRoleKey);
          app.setScriptState(resumed);
          useAppStore.setState({ mode: 'script', currentPlayer: resumedPlayer, boundCharacterName: resumedPlayer });
          setPhase('ready');
          return;
        }

        setStep('正在生成剧本并分发角色…');
        if (!script) throw new Error('剧本数据缺失，请返回重新选择。');
        const selectedPlayer = playerRole?.name;
        if (!selectedPlayer) throw new Error('请先在角色选择页选择你要扮演的角色。');
        const players = [selectedPlayer, ...gamePlayers.filter(name => name !== selectedPlayer)];
        const resp = await api.scriptInit(script.title, players, 'full', undefined, selectedPlayer);
        const sid = resp?.session_id;
        if (sid) useAppStore.getState().setScriptSessionId(String(sid));
        if (resp?.role_key) useAppStore.getState().setScriptRoleKey(String(resp.role_key));
        useAppStore.setState({ mode: 'script', currentPlayer: selectedPlayer, boundCharacterName: selectedPlayer });
        await useAppStore.getState().loadState();
        useAppStore.setState({
          mode: 'script',
          currentPlayer: selectedPlayer,
          boundCharacterName: selectedPlayer,
          ...(resp?.role_key ? { scriptRoleKey: String(resp.role_key) } : {}),
        });
        if (sid) {
          api.scriptGenerateFull(sid).catch((e: any) =>
            console.warn('[GameBridge] generate_full 触发失败（可在状态面板手动重试）：', e));
        }
      } else if (gameMode === 'werewolf') {
        setStep('正在创建狼人杀对局（AI 补满 8 人）…');
        const playerName = playerRole?.name ?? (gamePlayers[0] || '我');
        const aiFill = WW_AI_NAMES.filter(n => !gamePlayers.includes(n));
        const players = [...gamePlayers, ...aiFill].slice(0, 8);
        const resp = await api.werewolfInit(playerName, players);
        const sid = resp?.session_id;
        if (sid) useAppStore.setState({ werewolfSessionId: sid });
        useAppStore.setState({ mode: 'werewolf', currentPlayer: playerName });
        await useAppStore.getState().loadState();
      } else if (gameMode === 'general' && (runMode === 'explore' || selectCtx.scriptId === 'g_dawn_social')) {
        setStep('正在加载 2D 世界（生成地图）…');
        const g = script as (GeneralScript | undefined);
        if (selectCtx.scriptId === 'g_dawn_social') {
          setExploreMap((g as any)?.map ?? null);
          setPhase('ready');
          return;
        }
        if (selectCtx.scriptId && generalMaps[selectCtx.scriptId]) {
          setExploreMap(generalMaps[selectCtx.scriptId]);
        } else {
          try {
            if (g && g.desc?.trim()) {
              const seedText = String(mapGen.seed || '').trim();
              const structure = await api.structureGenerate({
                theme: g.desc.trim(),
                kind: mapGen.kind || 'city_block',
                map_mode: mapGen.mapMode || 'single',
                width: mapGen.width,
                height: mapGen.height,
                style: mapGen.style === '随剧本风格' ? undefined : mapGen.style,
                audit: mapGen.audit,
                ...(seedText && !Number.isNaN(Number(seedText)) ? { seed: Number(seedText) } : {}),
              });
              const mapId = structure?.current_map_id || Object.keys(structure?.maps || {})[0] || '';
              const generatedMap = (structure?.maps && mapId ? structure.maps[mapId] : undefined)
                || Object.values(structure?.maps || {})[0];
              if (generatedMap) {
                if (selectCtx.scriptId) setGeneralMap(selectCtx.scriptId, generatedMap as ScriptMap);
                setExploreMap(generatedMap as ScriptMap);
              } else {
                setExploreMap((g as any)?.map ?? null);
              }
            } else {
              setExploreMap((g as any)?.map ?? null);
            }
          } catch {
            setExploreMap((g as any)?.map ?? null);
          }
        }
      } else if (gameMode === 'general') {
        setStep('正在进入场景（自由对话）…');
        const g = script as (GeneralScript | undefined);
        if (!g) throw new Error('场景数据缺失，请返回重新选择。');
        const aiNames = gamePlayers.filter(n => n !== playerRole?.name);
        const playerName = withPlayer && playerRole ? playerRole.name : undefined;
        const agents = playerName ? [...aiNames, playerName] : aiNames;
        if (agents.length === 0) throw new Error('至少需要一名角色（请点亮角色卡）。');
        const details = characterDetails(agents);

        const startResp = confirmedPreflightId
          ? await directorApi.startScene(g.title, agents, playerName, details, confirmedPreflightId, g.desc || g.background || '')
          : await api.startScene(g.title, agents, playerName, details);

        useGalStore.getState().setLiveGoals(startResp?.goals);
        const scid = startResp?.session_id || '';
        setChatSessionId(scid);
        useAppStore.setState({ sessionId: scid });
        useAppStore.setState({ mode: 'free', currentPlayer: playerRole?.name ?? '我' });
        await useAppStore.getState().loadState();
        if (scid) useAppStore.setState({ sessionId: scid });
      }
      setPhase('ready');
    } catch (e: any) {
      console.warn('[GameBridge] 对局启动失败：', e);
      setError(e?.message || '对局启动失败（请确认后端 8000 已运行）');
      setPhase('error');
    }
  };

  const prepareDirectorPreflight = async () => {
    const app = useAppStore.getState();
    try {
      if (!useAppStore.getState().initialized) {
        setStep('正在连接后端…');
        await app.loadState();
      }
      const g = script as (GeneralScript | undefined);
      if (!g || !playerRole) throw new Error('缺少场景或玩家角色，无法创建进场确认。');
      const aiNames = gamePlayers.filter(n => n !== playerRole.name);
      const agents = [...aiNames, playerRole.name];
      const details = characterDetails(agents);
      const player = details.find(x => x.name === playerRole.name) || { name: playerRole.name };
      const sceneDescription = [g.desc, g.background, g.opening].filter(Boolean).join('\n');
      const res = await directorApi.createPreflight({
        scene_id: g.title,
        scene_description: sceneDescription,
        player,
        characters: details,
        relationships: g.relations || [],
        entry_order: [playerRole.name, ...aiNames],
        onstage: agents,
      });
      setPreflightId(res.preflight_id || '');
      setPreflightReply(res.reply || '');
      setPreflightState(res.state || null);
      setPhase('preflight');
    } catch (e: any) {
      setError(e?.message || '主控进场确认初始化失败');
      setPhase('error');
    }
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const needsPreflight = gameMode === 'general' && runMode === 'chat' && withPlayer && !!playerRole;
    if (needsPreflight) void prepareDirectorPreflight();
    else void launch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameMode]);

  const title = gameMode === 'murder' ? '剧本杀对局' : gameMode === 'werewolf' ? '狼人杀' : (runMode === 'explore' ? '一般模式 · 2D 探索' : '一般模式 · 自由聊天');

  if (phase === 'preflight' && preflightId) {
    return (
      <DirectorPreflightPanel
        preflightId={preflightId}
        initialReply={preflightReply}
        initialState={preflightState}
        onBack={back}
        onConfirmed={async state => {
          setPreflightState(state);
          await launch(preflightId);
        }}
      />
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <button className="btn2 btn2-ghost btn2-sm" onClick={back}>← 返回角色选择</button>
        <b style={{ fontSize: 15 }}>🎮 {title}</b>
        <span style={{ fontSize: 12, color: 'var(--color-text-dim2)' }}>
          {gamePlayers.length} 名角色{gameMode === 'general' ? (withPlayer ? ' · 带玩家' : ' · 不带玩家（观看）') : ''}
        </span>
        <button className="btn2 btn2-sm" style={{ marginLeft: 'auto' }} onClick={() => go('home')}>🏠 模式选择</button>
      </div>

      {phase === 'launching' && (
        <div className="card2" style={{ textAlign: 'center', padding: 40 }}>
          <div className="loading-dots" style={{ fontSize: 30 }}>🔄</div>
          <div style={{ marginTop: 12, color: 'var(--color-text-dim)' }}>{step}</div>
          <div className="hint" style={{ marginTop: 8 }}>正在按已确认的主控状态创建场景。</div>
        </div>
      )}

      {phase === 'error' && (
        <div className="card2" style={{ maxWidth: 520, margin: '40px auto', textAlign: 'center' }}>
          <div style={{ fontSize: 34 }}>⚠️</div>
          <div style={{ marginTop: 12, color: 'var(--color-danger)', fontWeight: 700 }}>对局启动失败</div>
          <div className="hint" style={{ marginTop: 8, lineHeight: 1.8 }}>{error}</div>
          <div style={{ marginTop: 16, display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button className="btn2" onClick={() => { startedRef.current = false; setPhase('launching'); setError(''); window.location.reload(); }}>重试</button>
            <button className="btn2 btn2-ghost" onClick={() => go('roles')}>返回角色选择</button>
          </div>
        </div>
      )}

      {phase === 'ready' && (
        <>
          {gameMode === 'general' && (runMode === 'explore' || selectCtx.scriptId === 'g_dawn_social') ? (
            <PhaserSimulationView
              characters={gamePlayers.map(n => {
                const r = roleByName.get(n);
                return { name: n, persona: r?.personality || '', voice: r?.tts?.voice || '', background: r?.background || '' };
              })}
              scene={exploreMap ? 'custom' : 'park'}
              map={exploreMap ?? undefined}
              playerName={withPlayer && playerRole ? playerRole.name : undefined}
              galChat
            />
          ) : gameMode === 'general' && runMode === 'chat' ? (
            galClassic ? (
              <div style={{ position: 'relative' }}>
                <button
                  className="btn2 btn2-ghost btn2-sm"
                  style={{ position: 'fixed', top: 74, right: 14, zIndex: 2000 }}
                  onClick={() => setGalClassic(false)}
                >
                  ← 返回 Gal 视图
                </button>
                <ChatPage />
              </div>
            ) : (
              <GalGeneralView
                sessionId={chatSessionId || generalSessionId}
                playerName={withPlayer && playerRole ? playerRole.name : undefined}
                onBack={back}
                onClassic={() => setGalClassic(true)}
              />
            )
          ) : (
            <ChatPage />
          )}
          {preflightId && <DirectorRuntimePanel />}
        </>
      )}
    </div>
  );
}
