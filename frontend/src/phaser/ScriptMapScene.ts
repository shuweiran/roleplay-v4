/**
 * ScriptMapScene.ts — 剧本杀地图渲染 Scene（阶段 2，契约 v1）
 *
 * 职责：把 POST /api/script/map 返回的契约 v1 地图 JSON 渲染为可交互 2D 地图：
 *   - 瓦片地面层 + 碰撞层（对齐阶段 0 tileScene：setCollisionByExclusion 隐藏物理层）
 *   - zones[] 搜证热点（金色区域 + 脉冲 + 名称标签；靠近提示 + 点击/E 触发搜证回调）
 *   - spawn_points[] 玩家/AI 出生点标记；rooms[] 房间名标注
 *   - 玩家 WASD 移动 + 瓦片碰撞（对齐阶段 0 zoneScene 交互模式）
 *
 * 交互回传：onSearch(zone) → React 组件调 POST /api/script/search（zones[].clue_location ↔
 * clues[].location 绑定）；搜证成功后 markZoneSearched(id) 把热点变绿（已搜证）。
 */
import Phaser from 'phaser';
import { normalizeMap, tileColor, type ScriptMap, type MapZone } from './mapData';

export interface ScriptMapSceneCallbacks {
  /** 触发搜证：zone 的 clue_location 即搜索地点（POST /api/script/search） */
  onSearch: (zone: MapZone) => void;
  /** 玩家位置变化回调（格坐标；仅格变化时触发，供小地图/HUD 消费） */
  onPlayerMove?: (gridX: number, gridY: number) => void;
}

/** 画布尺寸（对齐阶段 0 demo 800×560） */
const CANVAS_W = 800;
const CANVAS_H = 560;

export class ScriptMapScene extends Phaser.Scene {
  private mapJson: ScriptMap;
  private callbacks: ScriptMapSceneCallbacks;

  private b!: { ox: number; oy: number; ts: number; map: Phaser.Tilemaps.Tilemap };
  private zoneG!: Phaser.GameObjects.Graphics;
  private spawnG!: Phaser.GameObjects.Graphics;
  private zoneLabels: Phaser.GameObjects.Text[] = [];
  private zoneStates = new Map<string, boolean>(); // id → searched
  private hint!: Phaser.GameObjects.Text;
  /** 玩家精灵：this.physics.add.image 返回 Arcade.Image（含 arcade body / 物理方法），故类型用 Physics.Arcade.Image 而非 GameObject Image */
  private player!: Phaser.Physics.Arcade.Image;
  private nearZone: MapZone | null = null;
  private eKey: Phaser.Input.Keyboard.Key | null = null; // keyboard 插件可能为 null（headless/无输入场景），可空
  private ready = false;
  /** 初始缩放基准（滚轮缩放上下限：baseZoom ~ 2×baseZoom） */
  private baseZoom = 1;
  /** 上次上报的玩家格坐标（节流：仅格变化时回调 onPlayerMove） */
  private lastReportedGx = -1;
  private lastReportedGy = -1;
  /** P-0803-E 方案 B: 挂起待恢复的搜证足迹（create() 完成前调用 restoreSearched 时暂存） */
  private pendingSearched: string[] | null = null;

  constructor(map: ScriptMap, callbacks: ScriptMapSceneCallbacks) {
    super({ key: 'ScriptMapScene' });
    this.mapJson = normalizeMap(map) ?? map;
    this.callbacks = callbacks;
  }

  /** 地图 JSON（外部轮询获取后重载用；正常流程创建即注入） */
  setMap(map: ScriptMap) {
    this.mapJson = normalizeMap(map) ?? map;
  }

  /** 搜证成功 → 热点变绿（已搜证标记，React 组件在 search 成功后调用） */
  markZoneSearched(id: string) {
    this.zoneStates.set(id, true);
    const label = this.zoneLabels.find(t => t.getData('zoneId') === id);
    if (label) label.setColor('#3ddc84');
  }

  /**
   * P-0803-E 方案 B: 按搜证足迹恢复绿点（zone.clue_location ∈ locations → 已搜证态）。
   * 可在 create() 完成前调用（暂存，create 末尾执行）；幂等。
   */
  restoreSearched(locations: string[] | undefined | null) {
    if (!locations || locations.length === 0) return;
    if (!this.ready) {
      this.pendingSearched = locations;
      return;
    }
    const set = new Set(locations);
    for (const z of this.mapJson.zones) {
      if (z.clue_location && set.has(z.clue_location)) this.markZoneSearched(z.id);
    }
  }

  /** 冒烟自测用：Scene create() 是否已完成（对齐阶段 1 SimulationScene.isReady 模式） */
  isReady(): boolean {
    return this.ready;
  }

  create() {
    const m = this.mapJson;
    const ts = m.tile_size || 32;
    const mapPxW = m.width * ts;
    const mapPxH = m.height * ts;

    // 相机自适应缩放（地图超画布时缩小，小时不放大）；baseZoom 记录缩放基准
    const scale = Math.min(CANVAS_W / mapPxW, CANVAS_H / mapPxH, 1.5);
    this.baseZoom = scale;
    this.cameras.main.setZoom(scale);
    // P-0803-E（调研项 2 相机跟随）：边界 clamp + 初始居中；startFollow 在玩家创建后启用
    this.cameras.main.setBounds(0, 0, mapPxW, mapPxH);
    this.cameras.main.centerOn(mapPxW / 2, mapPxH / 2);
    // P-0803-E（调研项 2 滚轮缩放增强）：baseZoom ~ 2×baseZoom
    this.input.on('wheel', (_p: Phaser.Input.Pointer, _go: unknown, _dx: number, dy: number) => {
      const cam = this.cameras.main;
      const z = Phaser.Math.Clamp(cam.zoom + (dy > 0 ? -0.12 : 0.12), this.baseZoom, this.baseZoom * 2);
      cam.setZoom(z);
    });

    // ── 运行时生成瓦片纹理（契约 tileset 语义：5 格色块，无素材依赖） ──
    const texKey = this.createTilesetTexture(ts);

    // ── 瓦片地面层 + 隐藏碰撞层（对齐阶段 0 buildMap） ──
    const map = this.make.tilemap({ data: m.layers.ground as unknown as number[][], tileWidth: ts, tileHeight: ts });
    const tileset = map.addTilesetImage(texKey, texKey, ts, ts, 0, 0);
    // null 收窄：纹理键为我们自己运行时生成，addTilesetImage 失败属于异常状态，直接抛错（避免把 null 传给 createLayer）
    if (!tileset) throw new Error('tileset 创建失败：' + texKey);
    map.createLayer(0, tileset, 0, 0);
    const collLayer = map.createBlankLayer('collision', tileset, 0, 0);
    // null 收窄：createBlankLayer 返回 TilemapLayer | null，后续 putTileAt/setVisible/setCollisionByExclusion/collider 均需非空
    if (!collLayer) throw new Error('碰撞层创建失败');
    const coll = m.layers.collision;
    for (let y = 0; y < coll.length; y++) {
      for (let x = 0; x < coll[y].length; x++) {
        if (coll[y][x]) collLayer.putTileAt(1, x, y);
      }
    }
    collLayer.setVisible(false);
    collLayer.setCollisionByExclusion([-1]);
    this.physics.world.setBounds(0, 0, mapPxW, mapPxH);
    this.b = { ox: 0, oy: 0, ts, map };

    // ── 房间名标注 ──
    for (const r of m.rooms) {
      if (!r.name) continue;
      this.add.text((r.x + r.w / 2) * ts, r.y * ts - 4, r.name, {
        fontFamily: 'sans-serif', fontSize: '13px', color: '#e2e8f0', backgroundColor: '#00000066',
        padding: { x: 4, y: 1 },
      }).setOrigin(0.5, 1).setDepth(4);
    }

    // ── 玩家出生点（spawn_points type=player；缺省第一个可通行点） ──
    const playerSpawn = m.spawn_points.find(s => s.type === 'player') ?? m.spawn_points[0];
    const px = playerSpawn ? (playerSpawn.x + 0.5) * ts : ts * 1.5;
    const py = playerSpawn ? (playerSpawn.y + 0.5) * ts : ts * 1.5;
    const playerTex = this.createDotTexture('player-dot', 0x38bdf8, ts * 0.45);
    this.player = this.physics.add.image(px, py, playerTex);
    this.player.setCollideWorldBounds(true);
    // arcade body 可空：physics.add.image 后 body 一般立即可用，但类型上为 Body | null，用可选链 + 非空守卫
    const pBody = this.player.body as Phaser.Physics.Arcade.Body | null;
    if (pBody) pBody.setCircle(ts * 0.3);
    this.physics.add.collider(this.player, collLayer);
    // P-0803-E（调研项 2）：玩家创建后启用相机跟随（地图大时局部视野漫游；地图小时 clamped 居中不抖）
    this.cameras.main.startFollow(this.player, true, 0.1, 0.1);
    this.add.text(px, py - ts * 0.7, '玩家', { fontFamily: 'sans-serif', fontSize: '11px', color: '#38bdf8' })
      .setOrigin(0.5).setDepth(10);

    // WASD 控制
    // keyboard 插件可能为 null（类型可空）；无键盘时跳过按键注册，update() 内对 keys 做非空守卫
    const keys = this.input.keyboard?.addKeys('W,A,S,D,UP,LEFT,DOWN,RIGHT') as Record<string, Phaser.Input.Keyboard.Key> | undefined;
    if (keys) this.registry.set('keys', keys);

    // ── 热点（zones） ──
    this.zoneG = this.add.graphics().setDepth(8);
    this.spawnG = this.add.graphics().setDepth(7);
    for (const z of m.zones) {
      const searched = this.zoneStates.get(z.id);
      const label = this.add.text((z.x + 0.5) * ts, (z.y + 0.5) * ts + ts * 0.8, z.name, {
        fontFamily: 'sans-serif', fontSize: '11px', color: searched ? '#3ddc84' : '#ffe08a', backgroundColor: '#00000088',
        padding: { x: 3, y: 1 },
      }).setOrigin(0.5).setDepth(9);
      label.setData('zoneId', z.id);
      this.zoneLabels.push(label);
    }

    // 出生点标记（玩家蓝 / NPC 灰）
    for (const s of m.spawn_points) {
      const cx = (s.x + 0.5) * ts, cy = (s.y + 0.5) * ts;
      const color = s.type === 'player' ? 0x38bdf8 : 0x94a3b8;
      this.spawnG.fillStyle(color, 0.55).fillCircle(cx, cy, ts * 0.22);
      this.spawnG.lineStyle(1, 0xffffff, 0.8).strokeCircle(cx, cy, ts * 0.22);
      if (s.type === 'npc') {
        this.add.text(cx, cy - ts * 0.35, 'AI', { fontFamily: 'sans-serif', fontSize: '9px', color: '#cbd5e1' })
          .setOrigin(0.5).setDepth(8);
      }
    }

    // 提示条 + 标题
    this.hint = this.add.text(CANVAS_W / 2, CANVAS_H - 12, '', {
      fontFamily: 'sans-serif', fontSize: '13px', color: '#ffe08a', backgroundColor: '#000000bb',
      padding: { x: 10, y: 5 },
    }).setOrigin(0.5, 1).setScrollFactor(0).setDepth(20);
    this.add.text(10, 8, `🗺️ ${m.name}（${m.map_id}）`, {
      fontFamily: 'sans-serif', fontSize: '13px', color: '#38bdf8', backgroundColor: '#00000088',
      padding: { x: 6, y: 3 },
    }).setScrollFactor(0).setDepth(20);

    // 点击热点 → 搜证
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      const z = this.hitTest(p.worldX, p.worldY);
      if (z) this.interact(z);
    });
    this.eKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.E) ?? null;

    this.ready = true;
    // P-0803-E 方案 B: create 完成前挂起的足迹恢复（幂等）
    if (this.pendingSearched) {
      const p = this.pendingSearched;
      this.pendingSearched = null;
      this.restoreSearched(p);
    }
  }

  /** 运行时瓦片纹理：5 色块横排（契约 tile_count=5） */
  private createTilesetTexture(ts: number): string {
    const key = `map-tiles-${ts}`;
    if (this.textures.exists(key)) return key;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    for (let i = 1; i <= 5; i++) {
      g.fillStyle(tileColor(i), 1);
      g.fillRect((i - 1) * ts, 0, ts, ts);
      g.lineStyle(1, 0x000000, 0.35);
      g.strokeRect((i - 1) * ts, 0, ts, ts);
    }
    g.generateTexture(key, ts * 5, ts);
    g.destroy();
    return key;
  }

  /** 单色圆点纹理（玩家/AI） */
  private createDotTexture(key: string, color: number, r: number): string {
    if (this.textures.exists(key)) return key;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(color, 1);
    g.fillCircle(r, r, r);
    g.lineStyle(2, 0xffffff, 0.9);
    g.strokeCircle(r, r, r);
    g.generateTexture(key, r * 2, r * 2);
    g.destroy();
    return key;
  }

  /** 热点命中（worldX/worldY，摄像头变换后坐标） */
  private hitTest(wx: number, wy: number): MapZone | null {
    const ts = this.b.ts;
    for (const z of this.mapJson.zones) {
      const r = Math.max((z.radius || 1) * ts, ts * 0.6);
      const cx = (z.x + 0.5) * ts, cy = (z.y + 0.5) * ts;
      if (wx >= cx - r && wx <= cx + r && wy >= cy - r && wy <= cy + r) return z;
    }
    return null;
  }

  private interact(z: MapZone) {
    if (this.zoneStates.get(z.id)) {
      this.hint.setText(`✅ ${z.name}（该处已搜证过）`).setColor('#3ddc84');
      return;
    }
    this.hint.setText(`🔍 搜证中：${z.name}（${z.clue_location || '未知地点'}）...`).setColor('#ffe08a');
    this.callbacks.onSearch(z);
  }

  /** 渲染统计（冒烟自测用） */
  getStats() {
    return {
      zones: this.mapJson.zones.length,
      spawns: this.mapJson.spawn_points.length,
      rooms: this.mapJson.rooms.length,
      width: this.mapJson.width,
      height: this.mapJson.height,
    };
  }

  update() {
    if (!this.ready) return;
    // WASD / 方向键移动（keys 非空守卫：无键盘插件时跳过移动逻辑）
    const keys = this.registry.get('keys') as Record<string, Phaser.Input.Keyboard.Key> | undefined;
    if (!keys) return;
    const speed = 150;
    let vx = 0, vy = 0;
    if (keys.A.isDown || keys.LEFT.isDown) vx = -1;
    else if (keys.D.isDown || keys.RIGHT.isDown) vx = 1;
    if (keys.W.isDown || keys.UP.isDown) vy = -1;
    else if (keys.S.isDown || keys.DOWN.isDown) vy = 1;
    if (vx !== 0 && vy !== 0) { vx *= 0.7071; vy *= 0.7071; }
    this.player.setVelocity(vx * speed, vy * speed);

    const ts = this.b.ts;
    const px = this.player.x, py = this.player.y;

    // 脉冲热点 + 靠近检测（对齐阶段 0 zoneScene）；pulse 用于未靠近热点的呼吸透明度
    const pulse = 0.35 + 0.25 * Math.sin(this.time.now / 250);
    this.zoneG.clear();
    let near: MapZone | null = null;
    for (const z of this.mapJson.zones) {
      const searched = this.zoneStates.get(z.id);
      const cx = (z.x + 0.5) * ts, cy = (z.y + 0.5) * ts;
      const r = Math.max((z.radius || 1) * ts, ts * 0.6);
      const dist = Math.hypot(px - cx, py - cy);
      if (dist <= r + ts * 0.4) near = z;
      if (searched) {
        this.zoneG.fillStyle(0x3ddc84, 0.28).fillRoundedRect(cx - r, cy - r, r * 2, r * 2, 6);
        this.zoneG.lineStyle(2, 0x3ddc84, 0.9).strokeRoundedRect(cx - r, cy - r, r * 2, r * 2, 6);
      } else {
        this.zoneG.fillStyle(0xffd166, near === z ? 0.5 : pulse).fillRoundedRect(cx - r, cy - r, r * 2, r * 2, 6);
        this.zoneG.lineStyle(2, near === z ? 0xffffff : 0xffd166, 0.9).strokeRoundedRect(cx - r, cy - r, r * 2, r * 2, 6);
      }
    }
    this.nearZone = near;

    const searchedCount = this.mapJson.zones.filter(z => this.zoneStates.get(z.id)).length;
    if (near) {
      this.hint.setText(`🔍 靠近搜证点：${near.name} —— 点击该区域 或 按 E 搜证（地点：${near.clue_location || '未知'}）`).setColor('#ffe08a');
    } else {
      this.hint.setText(`金色区域=搜证点：点击 或 靠近后按 E（已搜证 ${searchedCount}/${this.mapJson.zones.length}）`).setColor('#ffe08a');
    }

    if (this.eKey && Phaser.Input.Keyboard.JustDown(this.eKey) && this.nearZone) {
      this.interact(this.nearZone);
    }

    // P-0803-E（调研项 2）：玩家格坐标变化 → 回调 onPlayerMove（小地图消费；节流=仅格变化时触发）
    if (this.callbacks.onPlayerMove) {
      const gx = Math.floor(px / ts);
      const gy = Math.floor(py / ts);
      if (gx !== this.lastReportedGx || gy !== this.lastReportedGy) {
        this.lastReportedGx = gx;
        this.lastReportedGy = gy;
        this.callbacks.onPlayerMove(gx, gy);
      }
    }
  }
}
