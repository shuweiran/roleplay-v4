# 🎭 Roleplay v4 — 多智能体角色扮演系统

> **当前版本**: v4.1.0  
> **仓库**: https://github.com/shuweiran/roleplay-v4  
> **狼人杀模式**: ⚠️ 测试中，功能尚不稳定  
> **剧本杀模式**: 🚧 正在开发中，敬请期待  

基于 LLM 的多角色对话引擎，支持**铁轨路由**、**主控仲裁**、**上下文压缩**、**SSE 实时流**。

---

## 🚀 快速开始

### Windows 一键启动

**双击 `启动.bat`**，脚本会自动完成所有操作：

```
✅ 检查 Python 环境
✅ 自动安装依赖（pip install -r requirements.txt）
✅ 启动 Web 服务器（http://localhost:8000）
✅ 自动打开浏览器
```

### 手动启动

```powershell
pip install -r requirements.txt
python -m backend.main --port 8000
```

### 配置 API Key

打开浏览器 → 左下角 **⚙️ 设置** → 填入你的 API Key → 保存即可使用。

> 无需手动设置环境变量，所有配置通过网页端完成。密钥仅保存在本地 `backend/api_key.json`。

---

## 🎮 运行模式

| 模式 | 说明 | 状态 |
|------|------|------|
| **自由模式** (free) | 主控自主决定每轮谁说话、谁旁听 | ✅ 稳定 |
| **主角模式** (protagonist) | 指定主角始终活跃 | ✅ 稳定 |
| **多线模式** (multi_track) | 并行推进多条故事线 | ✅ 稳定 |
| **导演模式** (director) | 用户选择一个角色扮演，消息直接作为该角色发言 | ✅ 可用 |
| **狼人杀模式** (werewolf) | 身份分配、昼夜交替、投票出局、胜负判定 | ⚠️ 测试中 |
| **剧本杀模式** (script) | AI 生成的侦探推理剧本杀 | 🚧 开发中 |

## 📦 内置内容

### 默认角色（18个）

苏哲、林诗、老王、侦探、医生、商人、学生、教师、程序员、艺术家、记者、小樱、小雨、柳烟、瑶瑶、苏婉、莉莉丝、顾霆

### 默认场景（11个）

雨夜咖啡馆、老城图书馆、经典酒吧、经典校园、经典城堡、经典办公室、经典太空船、经典列车、狼人杀默认场景

---

## 🏗️ 架构

```
roleplay-v4/
├── 启动.bat                 # 🪄 一键启动脚本
├── .gitignore
├── README.md
├── requirements.txt
│
├── backend/                 # FastAPI 后端 (Python)
│   ├── main.py              # 入口
│   ├── config.py            # 配置 (dataclass)
│   ├── api_key.json         # 用户保存的 API Key（自动生成）
│   │
│   ├── api/                 # HTTP 路由层
│   │   ├── app.py                 # FastAPI 工厂
│   │   ├── dependencies.py        # 依赖注入
│   │   ├── routes_config.py       # ⚙️ API Key 配置接口
│   │   ├── routes_auth.py         # 邀请码认证
│   │   ├── routes_characters.py   # 角色 CRUD
│   │   ├── routes_scenes.py       # 场景 CRUD
│   │   ├── routes_round.py        # 回合管理
│   │   ├── routes_session.py      # 会话/模式/发送
│   │   ├── routes_sse.py          # SSE 实时事件流
│   │   ├── routes_history.py      # 历史查询
│   │   ├── routes_room.py         # 联机房间
│   │   └── routes_voice.py        # 语音输入
│   │
│   ├── core/                # 核心业务逻辑
│   │   ├── router.py              # 铁轨调度核心
│   │   ├── agent.py               # 角色 LLM 代理
│   │   ├── arbiter.py             # DM 主控
│   │   ├── memory.py              # 三级记忆管理
│   │   ├── compressor.py          # 对话压缩
│   │   ├── monitor.py             # 用量/成本追踪
│   │   ├── persona.py             # 人格定义
│   │   ├── lorebook.py            # 世界知识库
│   │   ├── track_manager.py       # 轨道管理
│   │   ├── scheduler.py           # 任务调度
│   │   ├── validator.py           # 数据验证
│   │   ├── script_runtime.py      # 📜 剧本杀运行时（开发中）
│   │   ├── werewolf_game.py       # 🐺 狼人杀游戏逻辑
│   │   ├── werewolf_api.py        # 狼人杀函数 API
│   │   └── werewolf_arbiter.py    # 狼人杀仲裁器
│   │
│   ├── games/               # 游戏定义
│   │   ├── engine.py              # 游戏引擎基类
│   │   ├── schema.py              # 游戏数据模型
│   │   ├── werewolf_engine.py     # 狼人杀引擎
│   │   └── scripts/               # 游戏规则 JSON
│   │
│   ├── models/              # 数据模型
│   │   ├── domain.py              # 领域模型
│   │   └── schemas.py             # Pydantic 验证模型
│   │
│   ├── services/            # 基础设施服务
│   │   ├── llm_client.py          # LLM HTTP 客户端
│   │   ├── persistence.py         # 原子 JSON 读写
│   │   ├── session_manager.py     # 会话持久化
│   │   ├── private_chat.py        # 私聊系统
│   │   ├── web_search.py          # 联网搜索
│   │   ├── invite_service.py      # 邀请码服务
│   │   ├── namespace.py           # 命名空间
│   │   └── whisper_service.py     # 语音识别
│   │
│   ├── profiles/            # 预设角色配置文件
│   ├── scenes/              # 预设场景配置文件
│   │
│   └── data/                # 运行时数据
│       ├── characters/           # 角色 JSON（18个默认角色）
│       ├── scenes/               # 场景 JSON（11个默认场景）
│       └── sessions/             # 会话历史（自动生成）
│
├── frontend/                # React SPA 前端
│   ├── dist/                # 构建产物（开箱即用）
│   ├── src/
│   │   ├── App.tsx               # 根组件
│   │   ├── main.tsx              # 入口
│   │   ├── api/client.ts         # API 客户端
│   │   ├── api/useSSE.ts         # SSE 连接
│   │   ├── store/appStore.ts     # 全局状态 (Zustand)
│   │   ├── types/index.ts        # TypeScript 类型
│   │   └── components/
│   │       ├── HomePage/         # 首页（模式/房间）
│   │       ├── ScenePage/        # 场景选择
│   │       ├── ChatPage/         # 对话界面
│   │       ├── SettingsPage/     # ⚙️ API 设置
│   │       ├── LoginPage/        # 登录
│   │       ├── HistoryPanel/     # 历史记录
│   │       └── MaterialPage/     # 资料管理
│   └── package.json
│
└── frontend/dist/           # 前端构建产物
```

---

## 📡 API 端点

启动后访问 `http://localhost:8000/docs` 查看完整 Swagger 文档。

### 系统配置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/config/apikey` | 获取 API Key 配置（已脱敏） |
| POST | `/api/config/apikey` | 设置新的 API Key |

### 角色管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/characters` | 列出所有角色 |
| POST | `/api/characters` | 创建角色 |
| PUT | `/api/characters/{name}` | 更新角色 |
| DELETE | `/api/characters/{name}` | 删除角色 |
| POST | `/api/characters/generate` | AI 生成角色 |
| POST | `/api/characters/batch` | 批量创建角色 |

### 场景管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/scenes` | 列出所有场景 |
| POST | `/api/scenes` | 创建场景 |
| POST | `/api/scenes/generate` | AI 生成场景 |
| POST | `/api/scenes/{id}/start` | 启动场景 |

### 会话控制

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/state` | 系统状态 |
| POST | `/api/init` | 初始化会话 |
| POST | `/api/send` | 发送消息 |
| POST | `/api/stop` | 停止对话 |
| POST | `/api/auto` | 自动运行（多轮） |
| POST | `/api/mode` | 切换模式 |
| POST | `/api/goals` | 设置剧情目标 |
| POST | `/api/round/start` | 启动回合 |
| POST | `/api/round/rollback` | 回退回合 |
| GET | `/api/events` | SSE 实时事件流 |

### 狼人杀

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/werewolf/init` | 初始化游戏 |
| POST | `/api/werewolf/setup` | 设置模式 |
| POST | `/api/werewolf/night_action` | 夜间行动 |
| POST | `/api/werewolf/vote` | 投票 |
| GET | `/api/werewolf/status` | 游戏状态 |

### 联机房间

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/rooms` | 创建房间 |
| POST | `/api/rooms/{code}/join` | 加入房间 |
| GET | `/api/rooms/{code}` | 房间状态 |
| POST | `/api/rooms/{code}/leave` | 离开房间 |

---

## 🔧 铁轨系统（Track System）

每轮对话，主控（Arbiter）根据剧情紧张度动态分配角色到三种轨道：

| 轨道 | 模式 | 说明 |
|------|------|------|
| **强链 (merged)** | [A]══[B] | 共享上下文，互相直接对话 |
| **弱链 (weak)** | [A]--[B] | 部分活跃输出，部分旁听 |
| **隔离 (isolated)** | [A]  [B] | 完全独立，上下文不可见 |

## 🧠 记忆系统

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

---

## ⚙️ 命令行参数

```bash
python -m backend.main [--port PORT] [--host HOST] [--dev] [--budget USD]

  --port PORT        服务器端口 (默认: 8000)
  --host HOST        服务器地址 (默认: 0.0.0.0)
  --dev              开发模式 (配合 Vite dev server)
  --data-dir DIR     数据目录 (默认: backend/data)
  --budget USD       LLM 预算上限 (默认: $10)
  --disable-arbiter  禁用主控 (回退到简单轮替)
```

## 🌐 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LLM_API_KEY` | API 密钥（仅作为后备） | 优先使用网页端配置 |
| `LLM_API_BASE` | API 地址 | `https://api.deepseek.com` |
| `LLM_MODEL` | 模型名称 | `deepseek-v4-flash` |
| `ROLEPLAY_ADMIN_KEY` | 管理员密钥 | `admin-secret-change-me` |

> 💡 **推荐在网页端设置页面配置 API Key**，比环境变量更方便。

---

## 📦 数据格式

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
  "scene_id": "雨夜咖啡馆",
  "name": "雨夜咖啡馆",
  "description": "雨夜的城市角落，暖黄灯光...",
  "initial_agent_names": ["苏哲", "林诗"]
}
```

---

## 🛠️ 技术栈

| 层面 | 技术 |
|------|------|
| **后端** | Python 3.14+, FastAPI, uvicorn, httpx, OpenAI SDK, PyYAML, Pydantic |
| **前端** | React 19, TypeScript, Vite 5, Zustand |
| **LLM** | DeepSeek (OpenAI 兼容 API)，支持自定义 |

---

## 📋 功能完成度

| 功能 | 状态 |
|------|------|
| 角色 CRUD（创建/编辑/删除/AI 生成） | ✅ 稳定 |
| 场景管理（创建/进入/删除/AI 生成） | ✅ 稳定 |
| 自由角色扮演（旁白/轮次/SSE 实时流） | ✅ 稳定 |
| 导演模式（用户扮演角色） | ✅ 可用 |
| 私聊系统 | ✅ 基础可用 |
| 联机房间 | ✅ 基础可用 |
| 语音输入（需本地 Whisper） | ⚠️ 需额外配置 |
| 狼人杀（身份/昼夜/投票/胜负） | ⚠️ 测试中，功能尚不稳定 |
| 剧本杀模式 | 🚧 正在开发中 |

## ⚠️ 已知限制

- 狼人杀前端尚无专属游戏面板（身份显示/投票/阶段指示器），目前复用聊天界面
- 剧本杀模式入口已预留，完整流程正在开发中（未来版本）
- 前后端未做会话级用户数据隔离
- Windows GBK 终端输出中文可能乱码，不影响实际功能

---

## 📜 更新日志

### v4.1.0 (当前版本)
- ✨ 新增网页端 API Key 配置界面（无需手动设环境变量）
- ✨ 新增一键启动脚本 `启动.bat`
- 🔧 API Key 本地持久化保存 (`backend/api_key.json`)
- 🔧 优化首次使用体验：启动时显示清晰的指引
- 🔧 整理数据目录，去除冗余 namespace 数据
- 📦 预构建前端，开箱即用无需 Node.js
