# Roleplay v4 -- 多智能体角色扮演系统

> **当前版本**: v4.1.0  
> **狼人杀模式**: ⚠️ 测试中，功能尚不稳定  
> **剧本杀模式**: 🚧 正在开发中，敬请期待  

基于 LLM 的多角色对话引擎，支持**铁轨路由**（强链/弱链/分离）、**主控仲裁**、**上下文压缩**、**SSE 实时流**。

## 一键启动

```powershell
# 1. 设置 API Key (或放到桌面 "新建 文本文档 (2).txt")
$env:LLM_API_KEY = "sk-xxxxxxxx"
$env:LLM_API_BASE = "https://api.deepseek.com"
$env:LLM_MODEL = "deepseek-v4-pro"

# 2. 安装依赖
pip install fastapi uvicorn httpx openai pyyaml jose

# 3. 构建前端 (首次或前端修改后)
cd frontend; npm install; npm run build; cd ..

# 4. 启动
python -m backend.main --port 8000
```

访问 `http://localhost:8000`。

## 运行模式

| 模式 | 说明 |
|------|------|
| **自由模式** (free) | 主控自主决定每轮谁说话、谁旁听 |
| **主角模式** (protagonist) | 指定主角始终活跃 |
| **多线模式** (multi_track) | 并行推进多条故事线 |
| **导演模式** (director) | 用户选择一个角色扮演，消息直接作为该角色发言 |
| **狼人杀模式** (werewolf) | 身份分配、昼夜交替、投票出局、胜负判定 |
| **剧本杀模式** (script) | 计划中，未来版本将支持 AI 生成的侦探推理剧本杀体验 |

## 功能完成度

- 角色 CRUD (创建/编辑/删除/AI生成) -- 稳定
- 场景管理 (创建/进入/删除/AI生成) -- 稳定
- 一般角色扮演 (发送旁白/推进轮次/SSE实时流) -- 稳定
- 导演模式 (用户扮演角色) -- 可用
- 狼人杀 (身份分配/阶段流转/夜昼交替) -- ⚠️ 基础可用，稳定性仍需改进，UI 待完善
- 剧本杀模式 -- 🚧 正在开发中，敬请期待
- 私聊系统 -- 基础可用
- 语音输入 -- 需要本地 Whisper 模型

## 已知限制

- 狼人杀前端尚无专属游戏面板（身份显示/投票/阶段指示器），目前复用聊天界面
- 剧本杀模式入口已预留，完整流程正在开发中（未来版本）
- 前后端未做会话级用户数据隔离
- Windows GBK 终端输出中文可能乱码，不影响实际功能
- 邀请码管理需 X-Admin-Key 请求头鉴权

## 架构

```
roleplay-v4/
├── backend/                # FastAPI 后端
│   ├── main.py             # 入口
│   ├── config.py           # 配置 (dataclass)
│   ├── api/                # HTTP 路由层
│   │   ├── app.py               # FastAPI 工厂 + lifespan
│   │   ├── dependencies.py      # 依赖注入
│   │   ├── routes_characters.py # 角色 CRUD
│   │   ├── routes_scenes.py     # 场景 CRUD
│   │   ├── routes_round.py      # 轮次管理 + 回退
│   │   ├── routes_session.py    # 会话/模式/目标/发送
│   │   ├── routes_sse.py        # SSE 事件流
│   │   └── routes_history.py    # 历史查询(服务端过滤)
│   ├── core/               # 业务逻辑 (零 HTTP 依赖)
│   │   ├── router.py            # 铁轨调度核心
│   │   ├── agent.py             # 角色 LLM 代理
│   │   ├── arbiter.py           # DM 主控
│   │   ├── memory.py            # 三级记忆管理
│   │   ├── compressor.py        # 对话压缩
│   │   ├── lorebook.py          # 世界知识库
│   │   ├── persona.py           # 人格定义
│   │   └── monitor.py           # 用量/成本追踪
│   ├── models/             # 纯数据结构
│   │   ├── domain.py            # Track/Message/Session 等
│   │   └── schemas.py           # Pydantic 验证模型
│   ├── services/           # 共享基础设施
│   │   ├── llm_client.py        # 单一共享 HTTP 客户端
│   │   ├── persistence.py       # 原子 JSON 文件读写
│   │   └── session_manager.py   # 会话持久化 + 自动裁剪
│   └── data/               # 运行时数据
│       ├── characters/          # 角色 JSON
│       ├── scenes/              # 场景 JSON
│       └── sessions/            # 会话 JSON
│
├── frontend/               # React SPA
│   ├── src/
│   │   ├── App.tsx              # 根组件 + SSE 事件中心
│   │   ├── main.tsx             # 入口
│   │   ├── types/index.ts       # TypeScript 类型
│   │   ├── store/appStore.ts    # Zustand 全局状态
│   │   ├── api/client.ts        # Fetch 封装
│   │   ├── api/useSSE.ts        # SSE 连接 Hook
│   │   ├── components/
│   │   │   ├── ScenePage/       # 场景选择页
│   │   │   └── ChatPage/        # 对话页
│   │   └── styles/global.css    # 暗色主题
│   └── vite.config.ts           # Vite 配置 + API proxy
│
└── README.md
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LLM_API_KEY` | LLM API 密钥 | 可通过网页端设置页面配置，也可通过环境变量设置 |
| `LLM_API_BASE` | API 地址 | `https://api.deepseek.com` |
| `LLM_MODEL` | 模型名称 | `deepseek-v4-flash` |
| `ROLEPLAY_ADMIN_KEY` | 管理员密钥 | `admin-secret-change-me` |

## API 文档

启动后端后访问 `http://localhost:8000/docs` 查看完整 Swagger 文档。

### 核心端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/state` | 系统状态（角色、场景、会话） |
| POST | `/api/characters` | 创建角色 |
| PUT | `/api/characters/{name}` | 原子更新角色 |
| DELETE | `/api/characters/{name}` | 删除角色 |
| POST | `/api/characters/generate` | AI 生成角色 |
| POST | `/api/scenes` | 创建场景 |
| POST | `/api/scenes/generate` | AI 生成场景 |
| POST | `/api/scenes/{id}/start` | 用选中角色启动场景 |
| POST | `/api/round/start` | 启动一轮 |
| POST | `/api/round/rollback` | 回退到指定轮次 |
| POST | `/api/send` | 发送导演旁白 |
| POST | `/api/stop` | 停止对话 |
| POST | `/api/mode` | 切换模式 |
| POST | `/api/goals` | 设置剧情目标 |
| GET | `/api/events` | SSE 事件流 |
| GET | `/api/history?round=N&character=名` | 历史消息（支持过滤） |

## 铁轨系统

每轮对话，主控（Arbiter）根据剧情紧张度动态分配角色到三种轨道：

| 轨道 | 模式 | 说明 |
|------|------|------|
| **强链 (merged)** | [A]══[B] | 共享上下文，互相直接对话 |
| **弱链 (weak)** | [A]--[B] | 部分活跃输出，部分旁听 |
| **隔离 (isolated)** | [A]  [B] | 完全独立，上下文不可见 |

配合三种运行模式：
- **自由模式** — 主控自主决定每轮谁说话、谁旁听
- **主人公模式** — 指定主角始终活跃
- **多线模式** — 并行推进多条故事线

## 记忆系统

```
短期记忆 (最近 20 轮原始消息)
    ↓ 每 5 轮压缩
中期记忆 (压缩摘要链 + 关键事件)
    ↓ 超 200 条消息
长期归档 (_archive.json)
```

- **自动保存**: 每 3 轮写入磁盘
- **自动裁剪**: 超 200 条消息自动存档
- **原子写入**: `.tmp` → `os.replace()`，崩溃不丢数据

## v3 → v4 改进

| 问题 | v3 | v4 |
|------|----|----|
| 自动保存 | `_autosave` = `pass` | 每 3 轮保存 |
| AI 生成角色 | `self.base_dir` 不存在 → 崩溃 | 使用 CharacterStore |
| 前端架构 | 2500 行单文件 HTML | React + TypeScript 模块化 |
| LLM 客户端 | N+1 个 httpx 实例 | 1 个共享连接池 |
| 会话增长 | 无限制 | 200 条裁剪 + 归档 |
| 历史查询 | 拉全部前端过滤 | 服务端过滤 + 分页 |
| 角色更新 | 先删后建 (崩溃丢数据) | PUT 原子更新 |
| 死代码 | `_run_agents_for_track` 100 行 | 已删除 |

## 命令行参数

```bash
python -m backend.main --help

  --host HOST        服务器地址 (默认: 0.0.0.0)
  --port PORT        服务器端口 (默认: 8000)
  --dev              开发模式 (配合 Vite dev server)
  --data-dir DIR     数据目录 (默认: backend/data)
  --budget USD       LLM 预算上限 (默认: $10)
  --disable-arbiter  禁用主控 (回退到简单轮替)
```

## 数据格式

### 角色 (`data/characters/{name}.json`)

```json
{
  "name": "苏哲",
  "persona": "你是一位理性冷静的哲学家...",
  "voice": "说话沉着、有条理...",
  "background": "曾在多所大学任教哲学..."
}
```

### 场景 (`data/scenes/{scene_id}.json`)

```json
{
  "scene_id": "scene_1783279211921",
  "name": "雨夜咖啡馆",
  "description": "雨夜的城市角落，暖黄灯光...",
  "initial_agent_names": ["苏哲", "林诗"]
}
```

### 会话 (`data/sessions/{session_id}.json`)

自动保存，包含完整消息历史、轮次日志、压缩块、轨道历史。超 200 条消息后裁剪并归档到 `{session_id}_archive.json`。

## 技术栈

**后端**: Python, FastAPI, httpx, OpenAI SDK, PyYAML, Pydantic
**前端**: React 19, TypeScript, Vite 5, Zustand, CSS Variables
**LLM**: DeepSeek (OpenAI 兼容 API)

## 配置 API Key

启动后访问 `http://localhost:8000`，在主页左下角点击 **⚙️ 设置** 按钮，即可配置：

1. **API Key** — 你的 LLM API 密钥
2. **API Base URL** — API 地址（默认：`https://api.deepseek.com`）
3. **模型名称** — 使用的模型（默认：`deepseek-v4-flash`）

密钥仅保存在本地 `backend/api_key.json` 文件中，不会上传至任何外部服务器。

也可以通过环境变量配置：

```bash
$env:LLM_API_KEY = "sk-xxx"
$env:LLM_API_BASE = "https://api.deepseek.com"
$env:LLM_MODEL = "deepseek-v4-flash"
```

注意：网页端配置的优先级高于环境变量。
