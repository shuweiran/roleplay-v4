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

**新版方式（推荐）：**

1. 打开浏览器，在**首页**点击 **⚙️ 展开设置**
2. 填入 API Key / 地址 / 模型 / 语言 → 保存
3. 或进入对话后，左下角 **⚙️ 设置** 同样可以配置

> 密钥仅保存在本地 `backend/api_key.json`，不上传任何外部服务器。

**从旧版迁移：**

旧版通过以下方式配置的 API Key，新版**自动兼容**：

| 旧版方式 | 新版兼容 |
|---------|---------|
| 环境变量 `$env:LLM_API_KEY` | ✅ 保留，作为后备读取 |
| `~/Desktop/新建 文本文档 (2).txt` | ✅ 不再读取，改为网页端配置 |
| `.claude_dotenv` 文件 | ✅ 保留，作为后备读取 |
| `~/.dashscope_api_key`（千问语音） | ✅ 保留，TTS 自动读取 |

**优先级（高→低）：**
```
网页端配置 (api_key.json)  >  环境变量  >  .claude_dotenv
```

> 建议用网页端配置，方便切换且不依赖环境变量。

---

## 🎮 角色模式

### 🧑 你的角色（me）

左侧边栏可以设置**你的角色名**（默认为 `me`），这个角色代表你本人。

**不同模式下 me 的行为：**

| 模式 | me 的行为 |
|------|----------|
| **自由模式** (free) | me 自动设为旁听（silent），AI 角色围绕场景自由对话，你观察剧情发展 |
| **导演模式** (director) | 你选择一名 AI 角色扮演，消息直接作为该角色发言，融入故事 |
| **主角模式** (protagonist) | 指定主角始终活跃，其他角色围绕主角行动 |
| **多线模式** (multi_track) | 同时推进多条故事线，各组角色各自发展 |
| **狼人杀模式** (werewolf) | 你是真人玩家，参与身份推理、投票出局 |
| **剧本杀模式** (script) | 你是剧本中的角色之一，参与搜证和推理 | 🚧 开发中

> 💡 **自由模式**下 me 是观察者，不参与对话。如果你想亲自参与，请切换到**导演模式**。

## 🎮 运行模式

| 模式 | 说明 | 状态 |
|------|------|------|
| **自由模式** (free) | 主控自主决定每轮谁说话、谁旁听 | ✅ 稳定 |
| **主角模式** (protagonist) | 指定主角始终活跃 | ✅ 稳定 |
| **多线模式** (multi_track) | 并行推进多条故事线 | ✅ 稳定 |
| **导演模式** (director) | 用户选择一个角色扮演，消息直接作为该角色发言 | ✅ 可用 |
| **狼人杀模式** (werewolf) | 身份分配、昼夜交替、投票出局、胜负判定 | ⚠️ 测试中 |
| **剧本杀模式** (script) | AI 生成的侦探推理剧本杀 | 🚧 开发中 |

## 🔈 语音输出（TTS）

系统支持**流式语音朗读**，AI 角色的回复会自动转为语音播放。

### 双 TTS 引擎策略

| 场景 | 引擎 | 特点 |
|------|------|------|
| **你与单个角色对话**（me + 1个AI） | Edge TTS（微软） | **低延迟流式**，边合成边播放，响应快 |
| **多角色/旁白/复杂场景** | 千问 CosyVoice（阿里） | **高音质**，语气丰富，情感自然 |

- **Edge TTS**：免费，无需 API Key，支持中日韩英多语言，真流式输出
- **CosyVoice**：需 DashScope API Key（配置在 `~/.dashscope_api_key`），音质更自然

系统自动根据当前场景选择合适的引擎，你也可以在设置页面切换。

> 💡 不需要语音时，可以在设置中关闭 TTS。

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

## 🔧 铁轨系统（Track System）—— 核心机制详解

铁轨系统是 Roleplay v4 的核心创新。它解决了传统多角色 AI 对话中的两个根本问题：

> ❓ **问题1**：5个角色同时说话，上下文窗口撑爆怎么办？  
> ❓ **问题2**：想让两个角色私下密聊、其他人听不见，怎么实现？

**答案**：每轮对话，主控仲裁器（Arbiter）将角色分配到不同的「轨道」上，每个轨道拥有独立的上下文空间。

---

### 🎯 三种轨道模式

| 轨道 | 图示 | 可见性 | 上下文 | 典型场景 |
|------|------|--------|--------|----------|
| **强链 (merged)** | [A]══[B] | A 和 B 相互可见 | 共享同一上下文 | 正常对话、公开讨论、情侣交谈 |
| **弱链 (weak)** | [A]--[B] | A 输出对 B 可见，B 仅旁听 | A 有完整上下文，B 仅有摘要 | 主配角互动、一方叙述一方倾听 |
| **隔离 (isolated)** | [A]  [B] | 完全不可见 | 完全独立的上下文 | 两人各怀心思、私下调查、分头行动 |

---

### 💡 实际场景举例

#### 场景：三国谈判（刘备、曹操、孙权）

| 轮次 | 轨道分配 | 对话内容 | 说明 |
|------|----------|----------|------|
| 第1轮 | **强链**：刘备══曹操══孙权 | 三人公开讨论结盟事宜 | 所有人都能听到彼此 |
| 第2轮 | **弱链**：刘备--孙权（曹操旁听） | 刘孙权商议密约，曹操只能听到部分 | 曹操知道他们在商量，但不知道细节 |
| 第3轮 | **隔离**：刘备 ⬜ 曹操 ⬜ 孙权 | 三人各怀心事，内心独白 | 每人都在想自己的计划，互不知情 |
| 第4轮 | **强链**：刘备══曹操（孙权隔离） | 刘曹公开谈判，孙权在暗中观察 | 孙权能看到全局，但不出声 |

---

### ⚙️ 工作流程

```
每轮开始
  │
  ▼
主控仲裁器 (Arbiter) 分析当前剧情
  │  ├─ 读取所有角色的最新消息
  │  ├─ 评估角色间的关系紧密度
  │  └─ 判断每个角色应处于哪种轨道
  │
  ▼
分配轨道
  │  ├─ 强链：主要对话角色（2-3人共享上下文）
  │  ├─ 弱链：次要角色（接收主上下文摘要）
  │  └─ 隔离：独立角色（完全私密上下文）
  │
  ▼
并行生成
  │  ├─ 强链角色互相直接对话
  │  ├─ 弱链角色基于摘要输出
  │  └─ 隔离角色独立输出（内心戏/秘密行动）
  │
  ▼
主控整合
  │  ├─ 收集所有轨道的输出
  │  ├─ 整合成连贯的剧情叙述
  │  └─ 推进到下一轮
  │
  ▼
新一轮开始 🔄
```

---

### 🏗️ 配合运行模式

铁轨系统和运行模式是**正交的**——你可以自由组合：

| 运行模式 | 铁轨行为 | 适用场景 |
|----------|----------|----------|
| **自由模式** (free) | 主控自主决定每轮轨道分配 | 自由角色扮演、开放式剧情 |
| **主角模式** (protagonist) | 主角始终在强链轨道，其他角色围绕主角动态分配 | 单主角冒险故事、追妻火葬场 |
| **多线模式** (multi_track) | 同时推进多条强链轨道，各组角色各自发展故事 | 群像剧、多线叙事、权谋宫斗 |
| **导演模式** (director) | 用户扮演的角色固定在强链，AI 角色围绕用户分配 | 玩家代入式体验、互动故事 |
| **狼人杀模式** (werewolf) | 夜晚阶段全员隔离，白天阶段全员强链 | 身份推理、狼人杀游戏 |

> 💡 **小技巧**：在多线模式下，你可以让「A组在皇宫议事」的同时「B组在民间查案」，两组完全互不知情，最后剧情交汇时效果炸裂！

---

### 📊 技术实现

```
每轮上下文预算：4000 tokens（可配置）
  ├─ 强链轨道：占用约 60-70% 预算（完整对话历史）
  ├─ 弱链轨道：占用约 20-25% 预算（压缩摘要 + 当前消息）
  └─ 隔离轨道：占用约 10-15% 预算（仅角色设定 + 最新消息）
```

- 主控仲裁器每轮使用 **150 tokens** 快速决策轨道分配
- 每个角色代理每轮使用 **300 tokens** 生成回复
- 超过 5 轮后触发**上下文压缩**，将历史对话压缩为摘要
- 超过 200 条消息后触发**长期归档**，旧消息移至 `_archive.json`

---

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
