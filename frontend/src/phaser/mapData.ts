/**
 * mapData.ts — 地图 JSON 契约 v1 数据适配（阶段 2）
 *
 * 职责：把后端 POST /api/script/map 返回的契约 v1 地图 JSON 归一为渲染层对象。
 * 契约文档：docs/地图JSON契约-v1.md（阶段 0 定稿；宽容解析规则 §3 对齐 D-014 纪律）。
 */

/** 契约 v1 地图（宽容解析后的规范结构） */
export interface ScriptMap {
  map_version: number;
  map_id: string;
  name: string;
  theme: string;
  tile_size: number;
  width: number;
  height: number;
  tileset?: { src?: string; first_gid?: number; tile_count?: number };
  layers: { ground: number[][]; collision: number[][] };
  rooms: MapRoom[];
  corridors: MapCorridor[];
  zones: MapZone[];
  spawn_points: MapSpawnPoint[];
  generator?: { kind?: string; seed?: number; model?: string; note?: string };
}

export interface MapRoom {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tags?: string[];
}

export interface MapCorridor {
  id: string;
  from: string;
  to: string;
  points: number[][];
}

export interface MapZone {
  id: string;
  name: string;
  type: string; // search / door / broadcast
  x: number;
  y: number;
  radius: number;
  clue_location?: string;
  prompt?: string;
}

export interface MapSpawnPoint {
  id: string;
  type: string; // player / npc
  x: number;
  y: number;
}

/* ── 宽容解析（对齐契约 §3：缺省兜底、不崩） ── */

function num(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function str(v: unknown, def: string): string {
  return v === undefined || v === null ? def : String(v);
}

function listOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function normalizeMap(raw: unknown): ScriptMap | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const layers = (m.layers && typeof m.layers === 'object' ? m.layers : {}) as Record<string, unknown>;
  const ground = Array.isArray(layers.ground) ? layers.ground as number[][] : [];
  const collision = Array.isArray(layers.collision) ? layers.collision as number[][] : [];
  if (ground.length === 0 || collision.length === 0) return null;

  const zones = listOf(m.zones).map(z => {
    const zz = z as Record<string, unknown>;
    return {
      id: str(zz.id, 'zone'),
      name: str(zz.name, '热点'),
      type: str(zz.type, 'search'),
      x: num(zz.x, 0),
      y: num(zz.y, 0),
      radius: Number(zz.radius) >= 0 ? Number(zz.radius) : 1,
      clue_location: str(zz.clue_location, ''),
      prompt: str(zz.prompt, ''),
    } as MapZone;
  });

  const spawns = listOf(m.spawn_points).map(s => {
    const ss = s as Record<string, unknown>;
    return {
      id: str(ss.id, 'spawn'),
      type: str(ss.type, 'npc'),
      x: num(ss.x, 0),
      y: num(ss.y, 0),
    } as MapSpawnPoint;
  });

  const rooms = listOf(m.rooms).map(r => {
    const rr = r as Record<string, unknown>;
    return {
      id: str(rr.id, 'room'),
      name: str(rr.name, ''),
      x: num(rr.x, 0),
      y: num(rr.y, 0),
      w: num(rr.w, 0),
      h: num(rr.h, 0),
      tags: Array.isArray(rr.tags) ? rr.tags.map(String) : [],
    } as MapRoom;
  });

  const corridors = listOf(m.corridors).map(c => {
    const cc = c as Record<string, unknown>;
    const pts = Array.isArray(cc.points)
      ? (cc.points as unknown[][]).filter(p => Array.isArray(p) && p.length >= 2).map(p => [Number(p[0]), Number(p[1])])
      : [];
    return { id: str(cc.id, 'cor'), from: str(cc.from, ''), to: str(cc.to, ''), points: pts } as MapCorridor;
  });

  return {
    map_version: Number(m.map_version) || 1,
    map_id: str(m.map_id, 'map'),
    name: str(m.name, '未命名地图'),
    theme: str(m.theme, ''),
    tile_size: num(m.tile_size, 32),
    width: num(m.width, ground[0]?.length ?? 0),
    height: num(m.height, ground.length),
    tileset: (m.tileset && typeof m.tileset === 'object' ? m.tileset : undefined) as ScriptMap['tileset'],
    layers: { ground, collision },
    rooms,
    corridors,
    zones,
    spawn_points: spawns,
    generator: (m.generator && typeof m.generator === 'object' ? m.generator : undefined) as ScriptMap['generator'],
  };
}

/** 瓦片 id → 运行时生成色块纹理的颜色（对齐契约 tiles.png 语义：1木地板 2墙 3草地 4地毯 5石板） */
export function tileColor(id: number): number {
  switch (id) {
    case 1: return 0x8b5e3c; // 木地板
    case 2: return 0x64748b; // 墙
    case 3: return 0x3f9e4d; // 草地
    case 4: return 0x9c3d3d; // 地毯
    case 5: return 0x94a3b8; // 石板
    default: return 0x2a2a35; // 未知/装饰
  }
}
