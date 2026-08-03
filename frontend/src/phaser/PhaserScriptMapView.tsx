/**
 * PhaserScriptMapView.tsx — 剧本杀地图视图（阶段 2 + P-0803-E 地图增强）
 *
 * 数据流（后端零改动契约，阶段 2 新增 POST /api/script/map）：
 *   map JSON（契约 v1）→ Phaser ScriptMapScene 渲染（瓦片/碰撞/热点/出生点）
 *   热点搜证 → POST /api/script/search（player + zone.clue_location）→ 搜证结果卡片
 *
 * P-0803-E（调研项 2/3）：
 *   - 相机跟随 + 滚轮缩放（ScriptMapScene 内实现，本组件零感知）
 *   - 小地图（MiniMap DOM canvas 覆盖层，消费 onPlayerMove 玩家格坐标 + 已搜证列表）
 *   - 全屏（Fullscreen API 作用于本卡片容器，Phaser Scale.FIT 随容器自适应；「单页不双开」决策兼容）
 *
 * 生命周期（阶段 0 实证模式复用，与 PhaserSimulationView 一致）：
 *   Game 实例挂 React Ref；卸载 / StrictMode double-mount → game.destroy(true)；
 *   Vite HMR → import.meta.hot.dispose 销毁。
 */
import { useEffect, useRef, useState } from 'react';
import Phaser from 'phaser';
import { ScriptMapScene, type ScriptMapSceneCallbacks } from './ScriptMapScene';
import { MiniMap } from './MiniMap';
import { normalizeMap, type ScriptMap, type MapZone } from './mapData';

export interface PhaserScriptMapViewProps {
  /** 契约 v1 地图 JSON（POST /api/script/map 响应 .map） */
  map: ScriptMap;
  /** 当前玩家名（搜证主体，POST /api/script/search player 字段） */
  playerName: string;
  /** 容器高度（px），默认 560 */
  height?: number;
  /** P-0803-E 方案 B: 搜证足迹（已搜过地点列表，来自 map 响应/对局状态）→ 挂载时恢复绿点 */
  searchedLocations?: string[];
}

interface SearchResult {
  ok: boolean;
  text: string;
  clues: { id: string; content: string; ap_cost?: number }[];
  ap?: number;
}

export function PhaserScriptMapView({ map, playerName, height = 560, searchedLocations = [] }: PhaserScriptMapViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null); // 全屏目标容器（整卡）
  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<ScriptMapScene | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  // P-0803-E：小地图数据（玩家格坐标 + 已搜证列表）+ 全屏态
  const [playerPos, setPlayerPos] = useState<{ x: number; y: number } | null>(null);
  const [searchedZones, setSearchedZones] = useState<string[]>([]);
  const [fullscreen, setFullscreen] = useState(false);

  // 全屏态监听（Fullscreen API，ESC/系统退出也同步按钮态）
  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleFullscreen = () => {
    const el = cardRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen();
    }
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;

    const onSearch: ScriptMapSceneCallbacks['onSearch'] = async (zone: MapZone) => {
      const location = zone.clue_location || zone.name || '';
      setBusy(true);
      setResult(null);
      try {
        const r = await fetch('/api/script/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ player: playerName, location }),
        });
        const d = await r.json();
        const found = Array.isArray(d.clues) ? d.clues : [];
        const ap = d.ap !== undefined ? Number(d.ap) : undefined;
        const text = String(d.result || (found.length ? `搜证成功：获得 ${found.length} 条线索` : '该地点没有更多可搜证线索'));
        const ok = !d.error && !text.includes('行动点不足');
        if (ok && found.length > 0) {
          // 搜证成功 → 热点变绿（已搜证标记）+ 小地图绿点同步
          sceneRef.current?.markZoneSearched(zone.id);
          setSearchedZones(prev => (prev.includes(zone.id) ? prev : [...prev, zone.id]));
        }
        setResult({ ok, text, clues: found as SearchResult['clues'], ap });
      } catch (e: any) {
        setResult({ ok: false, text: '搜证请求失败：' + (e?.message || '网络错误'), clues: [] });
      } finally {
        setBusy(false);
      }
    };

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host,
      width: 800,
      height,
      backgroundColor: '#0f172a',
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: 800,
        height,
      },
      physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } },
      scene: [new ScriptMapScene(normalizeMap(map) ?? map, {
        onSearch,
        onPlayerMove: (gx, gy) => setPlayerPos({ x: gx, y: gy }),
      })],
      banner: false,
    });
    gameRef.current = game;
    // P-0803-E 方案 B: 恢复搜证足迹绿点（快照/重连后地图不丢已搜证状态）。
    // Phaser 场景启动异步：getScene 在 scene 激活前返回 null → 轮询等待实例后恢复；
    // create() 未完成时 restoreSearched 内部挂起（pendingSearched），create 末尾执行。
    const existing = game.scene.getScene('ScriptMapScene') as ScriptMapScene | null;
    if (existing) {
      sceneRef.current = existing;
      existing.restoreSearched(searchedLocations);
    } else {
      let tries = 0;
      const timer = window.setInterval(() => {
        const sc = game.scene.getScene('ScriptMapScene') as ScriptMapScene | null;
        if (sc) {
          sceneRef.current = sc;
          sc.restoreSearched(searchedLocations);
          window.clearInterval(timer);
        } else if (++tries > 40) {
          window.clearInterval(timer); // 2s 内未激活（异常路径）放弃，不阻塞
        }
      }, 50);
    }

    return () => {
      if (gameRef.current) {
        gameRef.current.destroy(true);
        gameRef.current = null;
        sceneRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, playerName, height]);

  // ── Vite dev HMR 保护 ──
  useEffect(() => {
    const dispose = () => {
      if (gameRef.current) {
        gameRef.current.destroy(true);
        gameRef.current = null;
        sceneRef.current = null;
      }
    };
    if (import.meta.hot) {
      import.meta.hot.dispose(dispose);
    }
    return () => { /* 组件卸载由主 effect cleanup 处理 */ };
  }, []);

  const gen = map?.generator as Record<string, unknown> | undefined;

  return (
    <div className="script-map-view" ref={cardRef} style={{ border: '1px solid var(--border, #334155)', borderRadius: 10, overflow: 'hidden', background: '#0f172a' }}>
      <div style={{ display: 'flex', gap: 8, padding: '8px 12px', background: '#1e293b', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: '#38bdf8', fontWeight: 600 }}>🗺️ 剧本杀地图（Phaser 渲染）</span>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>
          {map.width}×{map.height} 格 · {map.zones.length} 热点 · 生成器：
          {gen && gen.kind === 'bsp' ? <span style={{ color: '#fbbf24' }}>BSP（降级）</span> : <span style={{ color: '#3ddc84' }}>LLM</span>}
        </span>
        <span style={{ fontSize: 11, color: '#64748b' }}>WASD 移动 · 滚轮缩放 · 点击金色区域或按 E 搜证</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* P-0803-E：小地图（调研项 2 方案 B，DOM canvas 覆盖层） */}
          <MiniMap map={map} player={playerPos} searched={searchedZones} />
          {/* P-0803-E：全屏（调研项 3，Fullscreen API，不新开窗口） */}
          <button
            onClick={toggleFullscreen}
            title="全屏探索地图（ESC 退出）"
            style={{
              background: '#0b1220', color: '#7dd3fc', border: '1px solid #334155', borderRadius: 6,
              fontSize: 12, padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {fullscreen ? '⛶ 退出全屏' : '⛶ 全屏'}
          </button>
        </span>
      </div>
      {/* P-0803-E：host 容器全屏时 flex:1 撑满（CSS :fullscreen 规则），Phaser Scale.FIT 自适应 */}
      <div ref={hostRef} className="script-map-host" style={{ width: '100%', height: fullscreen ? undefined : height }} />
      {/* 搜证结果卡片 */}
      {(result || busy) && (
        <div className="script-map-result" style={{ padding: '10px 14px', borderTop: '1px solid var(--border, #334155)', background: '#0b1220', fontSize: 13 }}>
          {busy ? (
            <span style={{ color: '#94a3b8' }}>搜证中...</span>
          ) : result ? (
            <div>
              <div style={{ color: result.ok ? '#3ddc84' : '#f87171', fontWeight: 600, marginBottom: 4 }}>
                {result.ok ? '✅ ' : '⚠️ '}{result.text}
                {result.ap !== undefined && <span style={{ color: '#94a3b8', fontWeight: 400 }}> ｜ 剩余 AP：{result.ap}</span>}
              </div>
              {result.clues.length > 0 && (
                <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                  {result.clues.map(c => (
                    <li key={c.id} style={{ color: '#e2e8f0', lineHeight: 1.6 }}>
                      🔎 {c.content}
                      {c.ap_cost !== undefined && <span style={{ color: '#94a3b8' }}>（消耗 {c.ap_cost} AP）</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
