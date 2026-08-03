/**
 * SimulationScene.ts — Phaser 3.90 渲染层（阶段 1）
 *
 * 职责：把后端 /api/simulation/* 的状态渲染为 2D 世界（角色/障碍/听觉带/连接线/
 * 点击目标/旁白/对话气泡/群组框）。视觉与 static/simulation.html 自研 Canvas 一致（无回归），
 * 数据经 applySnapshot() 增量喂入——渲染层与数据流解耦（D-020 结构性前提）。
 *
 * 生命周期：React 组件持有 Phaser.Game；本 Scene 只负责绘制。destroy/重建由组件层
 * 按阶段 0 实证模式处理（game.destroy(true) + HMR dispose）。
 */
import Phaser from 'phaser';
import {
  WORLD_W, WORLD_H, agentColor, obstacleColor, groupModeColor,
  normalizeSnapshot, normalizeAgent,
  type SimAgent, type SimSnapshot, type SimGroup, type SimObstacle,
} from './simulationData';

export interface SceneCallbacks {
  /** 点击画布 → 世界坐标 → 交给组件层 POST /api/simulation/target/{agentName} */
  onSetTarget: (agentName: string, x: number, y: number) => void;
  /** P-0803-G：群组框「💬 加入对话 / 🚪 离开对话」按钮点击 → 组件层调 join/leave API */
  onGroupAction: (groupId: string, action: 'join' | 'leave') => void;
}

/**
 * 自研 Canvas 的虚线在 Phaser Graphics 上无原生 API，这里手写分段绘制：
 * dashCircle / dashRect / dashLine —— 视觉对齐 simulation.html 的 setLineDash。
 */
function dashCircle(g: Phaser.GameObjects.Graphics, x: number, y: number, r: number, dash: number, gap: number) {
  const total = Math.PI * 2;
  let t = 0;
  let drawing = true;
  while (t < total) {
    const seg = drawing ? dash : gap;
    const end = Math.min(t + seg, total);
    if (drawing) {
      g.beginPath();
      g.arc(x, y, r, t, end);
      g.strokePath();
    }
    t = end;
    drawing = !drawing;
    if (seg <= 0 || t >= total) break;
  }
}

function dashRect(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, dash: number, gap: number) {
  const edges: Array<[number, number, number, number]> = [
    [x, y, x + w, y],
    [x + w, y, x + w, y + h],
    [x + w, y + h, x, y + h],
    [x, y + h, x, y],
  ];
  for (const [x1, y1, x2, y2] of edges) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len <= 0) continue;
    const nx = (x2 - x1) / len;
    const ny = (y2 - y1) / len;
    let d = 0;
    let drawing = true;
    while (d < len) {
      const seg = drawing ? dash : gap;
      const end = Math.min(d + seg, len);
      if (drawing) {
        g.beginPath();
        g.moveTo(x1 + nx * d, y1 + ny * d);
        g.lineTo(x1 + nx * end, y1 + ny * end);
        g.strokePath();
      }
      d = end;
      drawing = !drawing;
    }
  }
}

function dashLine(g: Phaser.GameObjects.Graphics, x1: number, y1: number, x2: number, y2: number, dash: number, gap: number) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len <= 0) return;
  const nx = (x2 - x1) / len;
  const ny = (y2 - y1) / len;
  let d = 0;
  let drawing = true;
  while (d < len) {
    const seg = drawing ? dash : gap;
    const end = Math.min(d + seg, len);
    if (drawing) {
      g.beginPath();
      g.moveTo(x1 + nx * d, y1 + ny * d);
      g.lineTo(x1 + nx * end, y1 + ny * end);
      g.strokePath();
    }
    d = end;
    drawing = !drawing;
  }
}

export class SimulationScene extends Phaser.Scene {
  private agents = new Map<string, Phaser.GameObjects.Container>();
  private agentParts = new Map<string, {
    dot: Phaser.GameObjects.Graphics;
    emoji: Phaser.GameObjects.Text;
    name: Phaser.GameObjects.Text;
    bubble?: Phaser.GameObjects.Text;
    bubbleBg?: Phaser.GameObjects.Rectangle;
    speedLine?: Phaser.GameObjects.Graphics;
  }>();
  private lastAgentData = new Map<string, SimAgent>();
  private obstacleLabels: Phaser.GameObjects.Text[] = [];
  private groups: SimGroup[] = [];
  /** P-0803-G：群组加入/离开悬浮按钮（applyGroups 每轮重建，防泄漏；pointerdown 命中检查用） */
  private groupButtons: Phaser.GameObjects.Container[] = [];
  private clickTarget: { x: number; y: number } | null = null;
  private running = false;
  private lastObstacleCount = 0;
  private ready = false;
  private pendingSnapshots: SimSnapshot[] = [];
  // ── C-2：气泡单例 + 避让 ──
  /** 非空时世界内只显示该 agent 的气泡（单轨：用户在场 → 只播一人）；null = 显示全部（多轨） */
  private bubbleFilter: string | null = null;
  /** agent → 气泡避让层数（重叠时向上抬，硬约束不重叠） */
  private bubbleLanes = new Map<string, number>();

  private callbacks: SceneCallbacks;

  // 渲染对象（create() 中初始化——Phaser Scene 构造时 this.add 尚不可用）
  private gridG!: Phaser.GameObjects.Graphics;
  private obstacleG!: Phaser.GameObjects.Graphics;
  private linkG!: Phaser.GameObjects.Graphics;
  private markerG!: Phaser.GameObjects.Graphics;
  private groupG!: Phaser.GameObjects.Graphics;
  private narrationText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;

  constructor(callbacks: SceneCallbacks) {
    super({ key: 'SimulationScene' });
    this.callbacks = callbacks;
  }

  create() {
    this.gridG = this.add.graphics();
    this.obstacleG = this.add.graphics();
    this.linkG = this.add.graphics();
    this.markerG = this.add.graphics();
    this.groupG = this.add.graphics();
    this.narrationText = this.add.text(0, 0, '', { fontFamily: 'sans-serif', fontSize: '13px', color: '#fbbf24' }).setDepth(100).setOrigin(0.5);
    this.statusText = this.add.text(8, WORLD_H - 20, '', { fontFamily: 'sans-serif', fontSize: '11px', color: '#64748b' }).setDepth(100);
    this.drawGrid();

    // ready 标志 + 缓存重放：React 组件可能在 create() 完成前就 push 快照（挂载时序）
    this.ready = true;
    const pending = this.pendingSnapshots;
    this.pendingSnapshots = [];
    for (const snap of pending) this.applySnapshot(snap);

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      // P-0803-G：点击群组「加入/离开对话」按钮时，不触发移动目标（命中按钮则跳过）
      if (this.groupButtons.length > 0) {
        const hits = this.input.hitTestPointer(p);
        if (hits.some(go => this.groupButtons.includes(go as Phaser.GameObjects.Container))) return;
      }
      const x = Math.round(Math.max(10, Math.min(WORLD_W - 10, p.x)) * 100) / 100;
      const y = Math.round(Math.max(10, Math.min(WORLD_H - 10, p.y)) * 100) / 100;
      const names = Array.from(this.agents.keys());
      if (names.length === 0) return;
      // 优先选玩家类 agent（me / 我 / 主人），否则第一个
      let me: string | undefined = names.find(n => n === 'me' || n === '我' || n === '主人');
      if (!me) me = names[0]!;
      this.clickTarget = { x, y };
      this.drawMarker();
      setTimeout(() => { if (this.clickTarget && this.clickTarget.x === x && this.clickTarget.y === y) { this.clickTarget = null; this.drawMarker(); } }, 4000);
      this.callbacks.onSetTarget(me, x, y);
    });
  }

  private drawGrid() {
    const g = this.gridG;
    g.clear();
    g.fillStyle(0x0f172a, 1);
    g.fillRect(0, 0, WORLD_W, WORLD_H);
    g.lineStyle(0.5, 0x1e293b, 1);
    for (let x = 100; x < WORLD_W; x += 100) {
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, WORLD_H); g.strokePath();
    }
    for (let y = 100; y < WORLD_H; y += 100) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(WORLD_W, y); g.strokePath();
    }
    g.lineStyle(2, 0x334155, 1);
    g.strokeRect(0, 0, WORLD_W, WORLD_H);
  }

  private drawMarker() {
    const g = this.markerG;
    g.clear();
    if (!this.clickTarget) return;
    const { x, y } = this.clickTarget;
    g.lineStyle(2, 0x38bdf8, 0.4);
    dashLine(g, x - 8, y, x + 8, y, 4, 4);
    dashLine(g, x, y - 8, x, y + 8, 4, 4);
    g.lineStyle(1, 0x38bdf8, 0.27);
    g.strokeCircle(x, y, 6);
  }

  /** 渲染统计（自测/面板展示用）：agents/obstacles/groups 数量 */
  getStats(): { agents: number; obstacles: number; groups: number } {
    return { agents: this.agents.size, obstacles: this.lastObstacleCount, groups: this.groups.length };
  }

  /** create() 是否已完成（渲染对象就绪）；组件/自测在 push 快照前可轮询 */
  isReady(): boolean {
    return this.ready;
  }

  /** 全量快照（GET /api/simulation/state / SSE world_snapshot）→ 增量更新 */
  applySnapshot(snap: SimSnapshot) {
    if (!this.ready) {
      this.pendingSnapshots.push(snap); // create() 未完成时缓存，完成后重放
      return;
    }
    const s = normalizeSnapshot(snap);
    if (s.running !== undefined) this.running = s.running;
    if (s.agents) {
      // C-2：先算气泡避让层（基于本帧位置），再逐个 upsert（renderAgent 读层号）
      this.computeBubbleLanes(s.agents);
      for (const a of s.agents) this.upsertAgent(a);
      // 后端已移除的角色 → 删除渲染对象
      const alive = new Set(s.agents.map(a => a.agentName));
      for (const name of Array.from(this.agents.keys())) {
        if (!alive.has(name)) {
          this.agents.get(name)?.destroy();
          this.agents.delete(name);
          this.agentParts.delete(name);
          this.lastAgentData.delete(name);
        }
      }
    }
    if (s.obstacles) this.drawObstacles(s.obstacles.map(o => ({ ...o })));
    if (s.worldNarration !== undefined || s.directorActive !== undefined) {
      this.updateNarration(s.worldNarration || '', s.directorActive || false);
    }
    this.updateStatus(s.tick ?? 0);
  }

  /** C-2：世界气泡单例过滤（非空 → 只渲染该 agent 气泡；null → 全部，配避让层防重叠） */
  setBubbleFilter(name: string | null) {
    if (this.bubbleFilter === name) return;
    this.bubbleFilter = name;
    // 过滤变化 → 重算避让层并重绘全部气泡
    this.computeBubbleLanes(Array.from(this.lastAgentData.values()));
    for (const [n, c] of this.agents) {
      const parts = this.agentParts.get(n);
      const data = this.lastAgentData.get(n);
      if (c && parts && data) this.renderAgent(data, c, parts);
    }
  }

  /**
   * C-2：气泡避让层计算（硬约束：角色气泡不能重叠）。
   * 收集本帧可见气泡（filter 生效时只看单人），按 y 升序 x 升序确定性排序；
   * 逐个放入已放置矩形集合，重叠则向上抬一层（步进 22px，最多 4 层），
   * 层号存 bubbleLanes 供 renderAgent 使用（气泡锚定 agent 头部上方）。
   */
  private computeBubbleLanes(agents: SimAgent[]) {
    const R = 12;            // 角色半径（renderAgent 同值）
    const BASE = -R - 36;    // 气泡基准偏移（renderAgent 同值）
    const BW = 20;           // 气泡高（renderAgent 同值）
    const STEP = BW + 2;     // 层步进
    const MAX_LANES = 4;
    const FONT = 11;         // 气泡字号（renderAgent 同值）
    const MAX_W = 220;       // 气泡最大宽（renderAgent 同值）
    const TRUNC = 50;        // 气泡文本截断（renderAgent 同值）

    const entries: { name: string; x: number; y: number; w: number }[] = [];
    for (const a of agents) {
      if (!a || !a.agentName) continue;
      const msg = a.currentMessage && !a.currentMessage.startsWith('(主控') ? a.currentMessage : '';
      if (!msg) continue;
      if (this.bubbleFilter != null && a.agentName !== this.bubbleFilter) continue;
      const short = msg.length > TRUNC ? msg.slice(0, TRUNC) + '...' : msg;
      const tw = Math.min(short.length * FONT, MAX_W) + 16;
      entries.push({ name: a.agentName, x: a.x, y: a.y, w: tw });
    }
    entries.sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));

    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const lanes = new Map<string, number>();
    for (const e of entries) {
      let lane = 0;
      let y0 = e.y + BASE;
      let y1 = y0 + BW;
      while (lane < MAX_LANES && placed.some(p => e.x - e.w / 2 < p.x1 && e.x + e.w / 2 > p.x0 && y0 < p.y1 && y1 > p.y0)) {
        lane++;
        y0 = e.y + BASE - lane * STEP;
        y1 = y0 + BW;
      }
      lanes.set(e.name, lane);
      placed.push({ x0: e.x - e.w / 2, x1: e.x + e.w / 2, y0, y1 });
    }
    this.bubbleLanes = lanes;
  }

  /** 单 agent 增量（SSE 事件里按需细粒度更新时用；当前快照路径已覆盖） */
  applyAgent(raw: unknown) {
    const a = normalizeAgent(raw);
    if (a) this.upsertAgent(a);
  }

  private upsertAgent(a: SimAgent) {
    this.lastAgentData.set(a.agentName, a);
    let c = this.agents.get(a.agentName);
    if (!c) {
      c = this.add.container(0, 0);
      c.setDepth(10);
      this.agents.set(a.agentName, c);
      const dot = this.add.graphics();
      const nameT = this.add.text(0, 0, a.agentName, { fontFamily: 'sans-serif', fontSize: '12px', color: agentColor(a.agentName) }).setOrigin(0.5);
      const emojiT = this.add.text(0, 0, a.emotionEmoji || '😐', { fontFamily: 'sans-serif', fontSize: '14px' }).setOrigin(0.5);
      c.add([dot, emojiT, nameT]);
      this.agentParts.set(a.agentName, { dot, emoji: emojiT, name: nameT });
    }
    this.renderAgent(a, c, this.agentParts.get(a.agentName)!);
  }

  private renderAgent(a: SimAgent, c: Phaser.GameObjects.Container, parts: {
    dot: Phaser.GameObjects.Graphics;
    emoji: Phaser.GameObjects.Text;
    name: Phaser.GameObjects.Text;
    bubble?: Phaser.GameObjects.Text;
    bubbleBg?: Phaser.GameObjects.Rectangle;
    speedLine?: Phaser.GameObjects.Graphics;
  }) {
    const r = 12;
    c.setPosition(a.x, a.y);
    const color = agentColor(a.agentName);
    const { dot, emoji: emojiT, name: nameT } = parts;
    dot.clear();
    if (a.inConversation) {
      // glow：同心圆递减 alpha（径向渐变近似）
      for (let i = 0; i < 3; i++) {
        dot.fillStyle(Phaser.Display.Color.HexStringToColor(color).color, 0.18 - i * 0.05);
        dot.fillCircle(0, 0, r * (2.5 - i * 0.6));
      }
    }
    dot.fillStyle(Phaser.Display.Color.HexStringToColor(color).color, 1);
    dot.fillCircle(0, 0, r);
    dot.lineStyle(2, 0xffffff, 1);
    dot.strokeCircle(0, 0, r);
    emojiT.setPosition(0, -r - 8).setText(a.emotionEmoji || '😐');
    nameT.setPosition(0, r + 16).setText(a.agentName).setColor(color);

    // 消息气泡（替代 Canvas roundRect 气泡）
    // C-2：bubbleFilter 非空时只显示该 agent 气泡（世界内单轨只播一人）；避让层抬升防重叠
    const msg = a.currentMessage && !a.currentMessage.startsWith('(主控') ? a.currentMessage : '';
    const showBubble = msg && (this.bubbleFilter == null || a.agentName === this.bubbleFilter);
    if (showBubble) {
      const short = msg.length > 50 ? msg.slice(0, 50) + '...' : msg;
      const fontSize = 11;
      const textW = Math.min(short.length * fontSize, 220);
      const tw = textW + 16;
      const th = 20;
      const bx = -tw / 2;
      const lane = this.bubbleLanes.get(a.agentName) ?? 0;
      const by = -r - 36 - lane * 22;
      if (parts.bubbleBg) {
        parts.bubbleBg.setSize(tw, th).setPosition(bx + tw / 2, by + th / 2).setFillStyle(0x1e293b, 0.8);
      } else {
        const rect = this.add.rectangle(bx + tw / 2, by + th / 2, tw, th, 0x1e293b, 0.8);
        rect.setStrokeStyle(1, Phaser.Display.Color.HexStringToColor(color).color, 0.5);
        rect.setOrigin(0.5);
        parts.bubbleBg = rect;
        c.add(rect);
      }
      if (parts.bubble) {
        parts.bubble.setText(short).setPosition(0, by + 14);
      } else {
        const t = this.add.text(0, by + 14, short, { fontFamily: 'sans-serif', fontSize: '11px', color: '#e2e8f0' }).setOrigin(0.5);
        parts.bubble = t;
        c.add(t);
      }
    } else {
      if (parts.bubbleBg) { parts.bubbleBg.destroy(); parts.bubbleBg = undefined; }
      if (parts.bubble) { parts.bubble.destroy(); parts.bubble = undefined; }
    }

    // 速度线
    const speed = Math.sqrt((a.vx || 0) * (a.vx || 0) + (a.vy || 0) * (a.vy || 0));
    if (speed > 2) {
      if (!parts.speedLine) {
        const sg = this.add.graphics();
        parts.speedLine = sg;
        c.add(sg);
      }
      parts.speedLine.clear();
      parts.speedLine.lineStyle(1.5, Phaser.Display.Color.HexStringToColor(color).color, 0.5);
      parts.speedLine.beginPath();
      parts.speedLine.moveTo(0, 0);
      parts.speedLine.lineTo((a.vx || 0) * 2, (a.vy || 0) * 2);
      parts.speedLine.strokePath();
    } else if (parts.speedLine) {
      parts.speedLine.destroy();
      parts.speedLine = undefined;
    }
  }

  private drawObstacles(obstacles: SimObstacle[]) {
    // 先清理上一轮 label，再重画障碍
    for (const t of this.obstacleLabels) if (t.active) t.destroy();
    this.obstacleLabels = [];
    this.lastObstacleCount = obstacles.length;

    const g = this.obstacleG;
    g.clear();
    for (const o of obstacles) {
      const fill = Phaser.Display.Color.HexStringToColor(obstacleColor(o.type)).color;
      const stroke = Phaser.Display.Color.HexStringToColor(o.type === 'WALL' ? '#64748b' : '#475569').color;
      g.fillStyle(fill, 1);
      g.fillRect(o.x, o.y, o.width, o.height);
      g.lineStyle(1, stroke, 1);
      g.strokeRect(o.x, o.y, o.width, o.height);
      if (o.label) {
        const t = this.add.text(o.x + o.width / 2, o.y + o.height / 2 + 3, o.label, { fontFamily: 'sans-serif', fontSize: '9px', color: '#94a3b8' }).setOrigin(0.5).setDepth(5);
        this.obstacleLabels.push(t);
      }
      if (o.blocksSound) {
        g.lineStyle(0.5, 0xef4444, 0.2);
        dashRect(g, o.x - 2, o.y - 2, o.width + 4, o.height + 4, 2, 4);
      }
    }
  }

  /** 听觉带 + 连接线（每帧重绘，低成本） */
  private redrawLinks() {
    const g = this.linkG;
    g.clear();
    const list = Array.from(this.lastAgentData.values());
    for (const a of list) {
      const color = Phaser.Display.Color.HexStringToColor(agentColor(a.agentName)).color;
      g.lineStyle(1, color, 0.13);
      dashCircle(g, a.x, a.y, (a.hearRange || 200) * 0.7, 6, 6);
      g.lineStyle(1, color, 0.08);
      dashCircle(g, a.x, a.y, (a.hearRange || 200) * 2.5, 6, 6);
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const range = Math.min(a.hearRange || 200, b.hearRange || 200) * 0.7;
        if (dist <= range) {
          g.lineStyle(1, 0xfbbf24, 0.2);
          dashLine(g, a.x, a.y, b.x, b.y, 4, 4);
        }
      }
    }
  }

  /**
   * 群组框（conversation-status → 可视化 + P-0803-G 玩家加入/离开入口）。
   * opts.playerName + opts.playerInWorld：玩家角色在场时，为可加入的组叠加悬浮按钮——
   * 玩家已在组内 → 「🚪 离开对话」；未在组内且非 DYAD（后端 DYAD 上限 2 必满）→ 「💬 加入对话」；
   * 其余（玩家不在场 / DYAD 已满 / 无组 id）不显示入口。加入成功后 participants 自动含玩家名 → 变离开入口（4s 轮询自动反映）。
   */
  applyGroups(groups: SimGroup[], opts?: { playerName?: string; playerInWorld?: boolean }) {
    this.groups = groups || [];
    // 清理上一轮按钮（4s 轮询重建，防泄漏）
    for (const b of this.groupButtons) if (b.active) b.destroy();
    this.groupButtons = [];
    const g = this.groupG;
    g.clear();
    const pn = opts?.playerName ? String(opts.playerName).trim() : '';
    const playerInWorld = Boolean(pn && opts?.playerInWorld);
    for (const grp of this.groups) {
      const members = grp.participants || [];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const name of members) {
        const a = this.lastAgentData.get(name);
        if (!a) continue;
        minX = Math.min(minX, a.x - 25); maxX = Math.max(maxX, a.x + 25);
        minY = Math.min(minY, a.y - 50); maxY = Math.max(maxY, a.y + 25);
      }
      if (minX === Infinity) continue; // 成员均不在场 → 无可视区域（含按钮）
      const mc = Phaser.Display.Color.HexStringToColor(groupModeColor(grp.mode || '')).color;
      const pad = 15;
      // P-0803-G：玩家加入/离开入口（群组框右上角悬浮按钮）
      if (playerInWorld && grp.id) {
        const inGroup = members.includes(pn);
        if (inGroup) {
          this.drawGroupButton(grp.id, 'leave', maxX + pad, minY - pad, mc);
        } else if (grp.mode !== 'DYAD') {
          // DYAD 后端上限 2（1v1 语义，调研 §4.2 #5）——玩家不在组内时必满，不提供加入入口
          this.drawGroupButton(grp.id, 'join', maxX + pad, minY - pad, mc);
        }
      }
      if (members.length < 2) continue; // 可视化沿用既有规则：单成员组不画框
      g.lineStyle(1.5, mc, 1);
      dashRect(g, minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2, 8, 4);
      const label = `${grp.mode || 'GROUP'} (R${grp.rounds ?? 1})`;
      const t = this.add.text(minX - pad, minY - pad - 4, label, { fontFamily: 'sans-serif', fontSize: '10px', color: groupModeColor(grp.mode || '') }).setOrigin(0, 0).setDepth(9);
      this.time.delayedCall(6000, () => { if (t.active) t.destroy(); });
    }
  }

  /** P-0803-G：群组加入/离开悬浮按钮（群组框右上角，点击 → onGroupAction 上抛组件层调 API） */
  private drawGroupButton(groupId: string, action: 'join' | 'leave', right: number, top: number, color: number) {
    const text = action === 'join' ? '💬 加入对话' : '🚪 离开对话';
    const w = 92;
    const h = 22;
    const x = right - w;
    const y = top - h - 4;
    const btn = this.add.container(x, y);
    // Container 无 origin（子对象以容器本地 (0,0) 为基准）——bg/label 放 (w/2,h/2)，命中区 Rectangle(0,0,w,h) 即覆盖按钮可视区
    const bg = this.add.rectangle(w / 2, h / 2, w, h, 0x0f172a, 0.92).setStrokeStyle(1, color, 0.95);
    const label = this.add.text(w / 2, h / 2 + 0.5, text, { fontFamily: 'sans-serif', fontSize: '11px', color: '#e2e8f0' }).setOrigin(0.5);
    btn.add([bg, label]);
    btn.setDepth(80);
    btn.setInteractive(new Phaser.Geom.Rectangle(0, 0, w, h), Phaser.Geom.Rectangle.Contains);
    // hover 反馈（指针移入高亮）
    btn.on(Phaser.Input.Events.GAMEOBJECT_POINTER_OVER, () => { bg.setFillStyle(0x1e293b, 0.95); });
    btn.on(Phaser.Input.Events.GAMEOBJECT_POINTER_OUT, () => { bg.setFillStyle(0x0f172a, 0.92); });
    btn.on(Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN, () => {
      this.callbacks.onGroupAction(groupId, action);
    });
    this.groupButtons.push(btn);
  }

  private updateNarration(text: string, directorActive: boolean) {
    this.narrationText.setText(text ? '【主控】' + text : '');
    this.narrationText.setPosition(WORLD_W / 2, 8);
    this.narrationText.setAlpha(directorActive ? 1 : 0.7);
  }

  private updateStatus(tick: number) {
    this.statusText.setText(`Tick ${tick} | Agents ${this.agents.size} | ${this.running ? '运行中' : '已停止'}`);
  }

  /** 每帧：重绘链接层（听觉带/连线实时跟随角色移动） */
  update() {
    if (this.lastAgentData.size > 0) this.redrawLinks();
  }
}
