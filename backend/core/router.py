"""
Router / Scheduler — v4 round-based track-aware conversation orchestrator.

Round flow:
1. Arbiter configures tracks (configure_tracks)
2. Tasks derived from tracks (zero-LLM _assign_tasks)
3. Agents generate output per track (_run_round_agents)
4. Arbiter integrates outputs
5. Save to memory, check compression, emit events

v4 fixes:
- All services injected (LLMClient, stores, session_manager)
- Dead _run_agents_for_track removed
- auto_generate_character uses CharacterStore (not nonexistent base_dir)
- Auto-save via SessionManager.autosave()
- Session pruning on message overflow
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from datetime import datetime
from enum import Enum
from typing import AsyncGenerator, Callable, Dict, List, Optional

from ..config import AppConfig
from ..models.domain import (
    IMPORTANCE_NORMAL,
    IMPORTANCE_USER_INTERRUPT,
    Message,
    NightAction,
    Track,
    TrackConfig,
    TrackMode,
    WerewolfGameState,
)
from ..services.llm_client import LLMClient
from ..services.persistence import CharacterStore, SceneStore
from ..services.session_manager import SessionManager
from ..services.tts_service import stream_tts
from .agent import Agent
from .arbiter import Arbiter, UserInputCategory
from .compressor import Compressor
from .lorebook import Lorebook
from .memory import MemoryStore
from .monitor import Monitor
from .persona import Persona
from .werewolf_game import WerewolfGameMixin


class TurnPhase(Enum):
    IDLE = "idle"
    RUNNING = "running"
    STOPPED = "stopped"


class RoundPhase(Enum):
    IDLE = "idle"
    CONFIGURE_TRACKS = "configure_tracks"
    ASSIGN_TASKS = "assign_tasks"
    AGENTS_RUNNING = "agents_running"
    INTEGRATE = "integrate"
    COMPLETE = "complete"


class MessageEvent:
    """An event emitted during conversation processing."""

    def __init__(self, event_type: str, data: dict):
        self.event_type = event_type
        self.data = data


TRACK_COLORS = [
    "#4CAF50", "#2196F3", "#FF9800", "#E91E63",
    "#9C27B0", "#00BCD4", "#FF5722", "#795548",
    "#607D8B", "#8BC34A",
]


def role_name_cn(role: str) -> str:
    """Convert English role name to Chinese."""
    mapping = {
        "wolf": "狼人", "seer": "预言家", "witch": "女巫",
        "hunter": "猎人", "villager": "平民",
    }
    return mapping.get(role, role)


class Router(WerewolfGameMixin):
    """Core scheduler — v4 round-based track-aware conversation."""

    def __init__(
        self,
        config: AppConfig = None,
        *,
        llm_client: LLMClient = None,
        character_store: CharacterStore = None,
        scene_store: SceneStore = None,
        session_manager: SessionManager = None,
        monitor: Monitor = None,
    ):
        self.config = config or AppConfig()
        self._llm = llm_client
        self._char_store = character_store
        self._scene_store = scene_store
        self._session_manager = session_manager or SessionManager("data/sessions")
        self.monitor = monitor or Monitor()
        

        # Memory
        self.memory = MemoryStore(
            session_manager=self._session_manager,
            short_term_rounds=self.config.memory.short_term_rounds,
        )

        # Modules
        self.arbiter: Optional[Arbiter] = (
            Arbiter(self.config, llm_client=self._llm) if self.config.arbiter.enabled else None
        )
        self.lorebook: Optional[Lorebook] = (
            Lorebook() if self.config.lorebook.enabled else None
        )
        self.compressor: Optional[Compressor] = None
        self._lorebook_loaded = False

        # Agents
        self.agents: Dict[str, Agent] = {}

        # State
        self.phase: TurnPhase = TurnPhase.IDLE
        self.round_phase: RoundPhase = RoundPhase.IDLE
        self.session_id: str = ""
        self.current_round: int = 0
        self.current_scene: Optional[str] = None
        self.scene_description: str = ""
        self.current_track_config: Optional[TrackConfig] = None
        self.track_history: List[dict] = []

        # Control
        self._auto_running = False
        self._stop_requested = False
        self._event_callbacks: List[Callable] = []
        self._compressing = False

        # Goals
        self.goals: List[str] = []

        # Werewolf game state
        self._werewolf_state: Optional[WerewolfGameState] = None
        self._werewolf_role_hints: Dict[str, str] = {}  # agent -> role hint for system prompt
        self._werewolf_human_players: set = set()  # names of human-controlled players
        self._script_human_players: set = set()  # names of human-controlled script players
        self._werewolf_human_buffer: Dict[str, str] = {}  # human player output buffer (per round)
        self._werewolf_discussion_human_spoken: bool = False  # tracks whether human has spoken in discussion
        self._werewolf_waiting_for_human: bool = False  # UI hint: waiting for human input

        from ..services.private_chat import PrivateChatManager
        self._private_chat_manager = PrivateChatManager()

        # Private chat tracks
        self._private_tracks: Dict[str, Track] = {}  # track_id -> Track

        # Script system
        self._script_config: Optional[dict] = None
        self._character_relations: Dict[str, Dict] = {}  # agent_name -> {relation, to, from}
        self._script_scenes: List[dict] = []
        self._current_script_scene_index: int = 0

        # Legacy: for backward compat with existing server patterns
        self._saved_characters: Dict[str, Persona] = {}
        self._saved_scenes: Dict[str, dict] = {}
        self._load_saved_data()

    def _get_mode_id(self) -> str:
        """Get current mode id for message tagging."""
        mode = self.config.mode.mode
        if mode == "werewolf":
            return f"werewolf_{self.session_id}" if self._werewolf_state else f"werewolf_pending"
        elif mode == "script":
            return f"script_{self.session_id}" if self._script_config else f"script_pending"
        return f"director_{self.session_id}"

    def _switch_mode(self, new_mode: str) -> None:
        """Switch mode: clear old game state, set up new mode."""
        old_mode = self.config.mode.mode

        # Clear old game state
        self.clear_game_state()

        # Set new mode
        self.config.mode.mode = new_mode

        # Announce mode switch
        mode_names = {"free": "导演模式", "director": "导演模式", "werewolf": "狼人杀", "script": "剧本杀"}
        new_name = mode_names.get(new_mode, new_mode)

        announce = Message(
            role="system", name="主控",
            content=f"【模式切换】\n已切换至{new_name}模式。我将作为本局主持人，严格遵循当前模式规则。",
            track_id="main",
            visible_to=list(self.agents.keys()) if self.agents else [],
            importance=IMPORTANCE_USER_INTERRUPT,
            mode_id=self._get_mode_id(),
        )
        self.memory.add_message(announce)

        print(f"[Router] Mode switched: {old_mode} → {new_mode}")

    def clear_game_state(self) -> None:
        """Clear all game-specific state when switching modes."""
        self._werewolf_state = None
        self._werewolf_role_hints = {}
        self._werewolf_human_players = set()
        self._werewolf_human_buffer = {}
        self._werewolf_discussion_human_spoken = False
        self._werewolf_waiting_for_human = False
        self._private_tracks = {}
        self._script_config = None
        self._script_human_players = set()
        self._character_relations = {}
        self._script_scenes = []
        self._current_script_scene_index = 0

    def _load_saved_data(self) -> None:
        """Load characters and scenes from disk stores."""
        if self._char_store:
            for cdata in self._char_store.list_full():
                try:
                    self._saved_characters[cdata["name"]] = Persona.from_dict(cdata)
                except Exception:
                    pass
        if self._scene_store:
            for sdata in self._scene_store.list_all():
                self._saved_scenes[sdata.get("scene_id", "")] = sdata

    # ================================================================
    # Initialization
    # ================================================================

    async def init_with_characters(
        self,
        characters: List[Persona],
        scene_id: Optional[str] = None,
        session_id: Optional[str] = None,
        resume: bool = False,
    ) -> None:
        """Initialize the router with N characters."""
        self.agents = {}
        for persona in characters:
            agent = Agent(
                persona, persona.name,
                llm_client=self._llm,
                llm_config=self.config.llm,
                monitor=self.monitor,
            )
            self.agents[persona.name] = agent

        if not session_id:
            session_id = f"roleplay_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        self.session_id = session_id

        # Compressor
        if self._llm and self.agents:
            self.compressor = Compressor(
                llm_client=self._llm,
                model=self.config.llm.model,
                compression_interval=self.config.round.compression_interval,
            )
            self.memory.compressor = self.compressor

        if scene_id and scene_id in self._saved_scenes:
            self.current_scene = scene_id
            self.scene_description = self._saved_scenes[scene_id].get("description", "")

        if resume:
            try:
                latest = self._session_manager.get_latest()
                if latest and os.path.exists(latest):
                    self.memory.load_session(latest)
                    self.session_id = self.memory.session.session_id
                    self.current_round = self.memory.session.round_count
                    self.phase = TurnPhase.IDLE
                    return
            except Exception as e:
                print(f"[Router] Resume failed: {e}, starting fresh")

        # New session
        agent_names = [p.name for p in characters]
        self.memory.create_session(
            session_id=self.session_id,
            agent_names=agent_names,
            config={"summary_interval": self.config.memory.summary_interval,
                    "model": self.config.llm.model},
        )
        welcome = Message(
            role="system", name="System",
            content=f"角色扮演开始！\n" + "\n".join(f"角色{i+1}: {p.name}" for i, p in enumerate(characters)) +
                     "\n点击「启动一轮」开始对话。",
            track_id="main", visible_to=agent_names,
        )
        self.memory.add_message(welcome)
        self.phase = TurnPhase.IDLE

        # Werewolf mode: assign roles and send role messages
        if self.config.mode.mode == "werewolf":
            self._init_werewolf_game(characters)

    # ================================================================
    # Event system
    # ================================================================

    def on_event(self, callback: Callable) -> None:
        self._event_callbacks.append(callback)

    async def _emit(self, event_type: str, data: dict) -> None:
        event = MessageEvent(event_type, data)
        # Filter private events: only emit agent_output that the human player can see
        human_set = self._werewolf_human_players | self._script_human_players
        if human_set:
            if event_type == "agent_output":
                visible_to = data.get("visible_to", [])
                # [DEBUG] Log filter check for debugging visibility issues
                alive_players = self._werewolf_state.alive_players if self._werewolf_state else 'N/A'
                print(f"[DEBUG _emit] event_type={event_type}, visible_to={visible_to}, human_set={human_set}, alive_players={alive_players}")
                
                if not any(hp in visible_to for hp in human_set):
                    # Public werewolf tracks (discussion/voting merged) should always be visible
                    track_mode = data.get("track_mode", "")
                    track_id = data.get("track_id", "")
                    # Only day_discussion and day_vote are public; wolf_night stays private
                    if self._werewolf_state and track_id in ("day_discussion", "day_vote"):
                        print(f"[DEBUG _emit] Allowing public werewolf track event: track_id={track_id}")
                    else:
                        return
        for cb in self._event_callbacks:
            try:
                if asyncio.iscoroutinefunction(cb):
                    await cb(event)
                else:
                    cb(event)
            except Exception as e:
                print(f"[Router] Event callback error: {e}")

    # ================================================================
    # Character & Scene CRUD
    # ================================================================

    def save_character(self, persona: Persona) -> str:
        self._saved_characters[persona.name] = persona
        if self._char_store:
            self._char_store.save(persona.to_dict())
        return persona.name

    def delete_character(self, name: str) -> bool:
        if name not in self._saved_characters:
            return False
        del self._saved_characters[name]
        if name in self.agents:
            del self.agents[name]
        if self.config.mode.protagonist == name:
            self.config.mode.protagonist = ""
        if self.current_track_config:
            for track in self.current_track_config.tracks:
                track.agents = [n for n in track.agents if n != name]
                track.agent_actions.pop(name, None)
        for track_config in self.track_history:
            for track in track_config.get("tracks", []):
                track["agents"] = [n for n in track.get("agents", []) if n != name]
                track.get("agent_actions", {}).pop(name, None)
        if self._char_store:
            self._char_store.delete(name)
        return True

    def get_characters(self) -> List[dict]:
        if self._char_store:
            return self._char_store.list_all()
        return [
            {"name": p.name, "persona": p.persona[:80], "voice": p.voice[:60]}
            for p in self._saved_characters.values()
        ]

    def save_scene(self, scene_id: str, name: str, description: str,
                   agent_names: List[str] = None) -> dict:
        data = {"scene_id": scene_id, "name": name, "description": description,
                "initial_agent_names": agent_names or []}
        self._saved_scenes[scene_id] = data
        if self._scene_store:
            self._scene_store.save(scene_id, data)
        return data

    def delete_scene(self, scene_id: str) -> bool:
        if scene_id not in self._saved_scenes:
            return False
        del self._saved_scenes[scene_id]
        if self.current_scene == scene_id:
            self.current_scene = None
            self.scene_description = ""
        if self._scene_store:
            self._scene_store.delete(scene_id)
        return True

    def get_scenes(self) -> List[dict]:
        if self._scene_store:
            return self._scene_store.list_all()
        return list(self._saved_scenes.values())

    def enter_scene(self, scene_id: str) -> bool:
        if scene_id not in self._saved_scenes:
            return False
        self.current_scene = scene_id
        scene = self._saved_scenes[scene_id]
        self.scene_description = scene.get("description", "")
        if self.memory.session:
            scene_msg = Message(
                role="system", name="主控",
                content=f"【场景】{scene.get('name', '')}\n{self.scene_description}",
                track_id="main", visible_to=list(self.agents.keys()),
                importance=IMPORTANCE_NORMAL,
            )
            self.memory.add_message(scene_msg)
        return True

    # ================================================================
    # Generation endpoints
    # ================================================================

    async def auto_generate_scene(self, keywords: str = "") -> dict:
        """AI-generate a scene. FIXED: uses CharacterStore, not self.base_dir."""
        if not self.arbiter:
            return {"error": "no arbiter"}
        scene_data = await self.arbiter.generate_scene(
            keywords=keywords, current_scene=self.scene_description,
        )
        scene_id = f"scene_{int(time.time() * 1000)}"
        return self.save_scene(
            scene_id=scene_id,
            name=scene_data.get("name", ""),
            description=scene_data.get("description", ""),
            agent_names=list(self.agents.keys()),
        )

    async def auto_generate_character(self, keywords: str = "") -> dict:
        """AI-generate a character. FIXED: uses CharacterStore, not self.base_dir."""
        if not self.arbiter:
            return {"error": "no arbiter"}
        char_data = await self.arbiter.generate_character(keywords=keywords)
        name = char_data.get("name", "")
        if not name:
            return {"error": "empty name"}
        persona = Persona(
            name=name,
            persona=char_data.get("persona", ""),
            voice=char_data.get("voice", ""),
            background=char_data.get("background", ""),
        )
        self.save_character(persona)
        return char_data

    # ================================================================
    # Werewolf game logic
    # ================================================================


    async def load_script(self, script_data: dict, human_player_names: list = None) -> dict:
        """Load a script, generate characters and scenes."""
        self._script_config = script_data
        self._character_relations = {}
        self._script_scenes = []
        self._current_script_scene_index = 0

        title = script_data.get("title", "未命名")
        description = script_data.get("description", "")
        characters = script_data.get("characters", [])

        # Clear existing agents and create script characters
        self.agents = {}
        self.save_character(Persona(name="主控", persona="公正的游戏主持人，负责推进剧本发展"))

        # Set human players from parameter or auto-detect "me"
        self._script_human_players = set(human_player_names) if human_player_names else set()
        for char in characters:
            name = char.get("name", "")
            persona_text = char.get("persona", "")
            goal = char.get("goal", "")
            background = char.get("background", "")

            full_persona = persona_text
            if goal:
                full_persona += f"\n【当前目标】{goal}"

            p = Persona(name=name, persona=full_persona, background=background)
            self.save_character(p)

            # Don't create LLM agent for human players
            if name == "me":
                self._script_human_players.add(name)
                continue

            agent = Agent(p, name, llm_client=self._llm, llm_config=self.config.llm, monitor=self.monitor)
            self.agents[name] = agent

        # Build relationship graph
        self._build_character_relations(script_data)

        # Generate scene descriptions
        self._generate_script_scenes(script_data)

        # Initialize session
        agent_names = [c.get("name", "") for c in characters]
        self.memory.create_session(
            session_id=f"script_{title}_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
            agent_names=agent_names,
            config={"script_title": title},
        )

        rel_summary = ""
        for from_c, targets in self._character_relations.items():
            for to_c, info in targets.items():
                rel_summary += f"{from_c}→{to_c}: {info['relation']}\n"

        welcome = Message(
            role="system", name="主控",
            content=f"【剧本开始】\n剧本：《{title}》\n简介：{description}\n"
                    f"角色：{'、'.join(agent_names)}\n"
                    + (f"关系：\n{rel_summary}" if rel_summary else ""),
            track_id="main", visible_to=agent_names,
        )
        self.memory.add_message(welcome)

        first_scene = self._script_scenes[0] if self._script_scenes else {}
        if first_scene:
            self.scene_description = first_scene.get("description", "")
            scene_msg = Message(
                role="system", name="主控",
                content=f"【第一幕】{first_scene.get('name', '')}\n{first_scene.get('description', '')}",
                track_id="main", visible_to=agent_names,
                importance=IMPORTANCE_NORMAL,
            )
            self.memory.add_message(scene_msg)

        # Set mode to script (don't call _switch_mode which clears game state)
        self.config.mode.mode = "script"

        return {
            "status": "ok",
            "title": title,
            "character_count": len(characters),
            "scene_count": len(self._script_scenes),
            "characters": agent_names,
        }

    def _configure_script_tracks(self) -> TrackConfig:
        """Configure script tracks with 主控-controlled visibility chains.
        
        Chain types:
        - strong: A↔B mutually visible (direct relationship)
        - weak: A→B one-way partial visibility (overheard/suspected)
        - none: A↔B isolated (default)
        
        主控 dynamically adjusts chains each round via track_chain_overrides.
        """
        script = self._script_config
        if not script:
            return TrackConfig(tracks=[], round=self.current_round, description="")

        chars = script.get("characters", [])
        agent_names = [c.get("name", "") for c in chars if c.get("name")]
        tracks = []

        # Track 1: 主控 (narrator) — sees everything, controls chains
        track_narrator = Track(
            id="narrator",
            agents=["主控"],
            agent_actions={"主控": "silent"},  # 主控 doesn't speak, only controls
            mode="merged",
            color="#FFB300", label="主控视角",
        )
        tracks.append(track_narrator)

        # Track 2: Narration — visible to all
        narration = Track(
            id="narration", agents=[], mode="merged",
            color="#FFB300", label="剧情主线",
            agent_actions={},
        )
        tracks.append(narration)

        # Get current chain overrides (set by 主控 after each round)
        chain_overrides = getattr(self, '_track_chain_overrides', {})
        
        # Each character gets a track with dynamic visibility
        for c in chars:
            name = c.get("name", "")
            if not name:
                continue
            is_human = (name == "me")
            
            # Determine visible agents based on chains
            visible_agents = [name]
            # Apply chain overrides set by 主控
            for other_name in agent_names:
                if other_name == name:
                    continue
                chain_key = f"{name}→{other_name}"
                chain_type = chain_overrides.get(chain_key, "none")
                if chain_type == "strong":
                    visible_agents.append(other_name)
                elif chain_type == "weak":
                    visible_agents.append(other_name)  # partial visibility

            track = Track(
                id=f"char_{name}", agents=[name],
                agent_actions={name: "silent" if is_human else "active"},
                mode="isolated",
                color="#4CAF50" if not is_human else "#FF7043",
                label=f"{name}",
            )
            tracks.append(track)

            # Character's secrets — only visible to themselves and 主控
            secret = c.get("secret", "")
            if secret:
                secret_msg = Message(
                    role="system", name="主控",
                    content=f"【你隐藏的秘密】{secret}\n注意：这是只有你知道的秘密。",
                    track_id=f"char_{name}", visible_to=[name, "主控"],
                )
                self.memory.add_message(secret_msg)

        cfg = TrackConfig(
            tracks=tracks,
            round=self.current_round,
            description=f"剧本《{script.get('title', '')}》第{self.current_round}轮",
        )
        return cfg

    async def _configure_script_tracks_with_requests(self) -> TrackConfig:
        """剧本杀模式变链流程：同轮审批，共享进度→各自上下文"""
        from .track_request import request_manager, RequestType, TRACK_STRENGTH
        from .i18n import t as _t
        lang = getattr(self.config.mode, 'language', 'zh')

        # Step 1: 主控整理当前剧情进度摘要（所有角色共享）
        shared_summary = self._build_script_shared_context()

        # 缓存共享上下文供后续使用
        self._script_shared_context = shared_summary

        # Step 2: 评估角色变链需求（基于共享进度 + 个人目标）
        character_goals = self._get_script_character_goals()
        track_requests = []

        if self.arbiter:
            goals_text = "\n".join(f"- {g['name']}: {g['goal']}" for g in character_goals)
            current_tracks = ""
            if self.current_track_config:
                for t in self.current_track_config.tracks:
                    current_tracks += f"  轨道 {t.id} ({t.mode}): {'、'.join(t.agents)}\n"

            scene_text = self.scene_description or "未设置"

            prompt = f"""你是剧本杀主控仲裁者，请评估每个角色本轮是否需要调整轨道。

【剧本逻辑】
当前场景：{scene_text}

【当前剧情进度】
{shared_summary or '（新开场）'}

【当前轨道配置】
{current_tracks or '（未配置）'}

【角色个人目标】
{goals_text}

对每个角色判断：
1. 基于他们的个人目标，他们是否需要本轮单独行动（isolated）？
2. 他们是否需要私下交流（weak）？
3. 还是维持集体讨论（merged）？

返回JSON（必须包含所有角色）：
{{"requests": [
  {{"agent": "角色名", "preferred_mode": "merged/weak/isolated", "reason": "基于其目标的原因"}},
  ...
]}}"""

            try:
                result = await self.arbiter._llm.call_json(prompt, max_tokens=600)
                track_requests = result.get("requests", [])
            except Exception:
                track_requests = []

        # Step 3: 主控审批（基于剧本逻辑 + 场景逻辑，不受角色目标影响）
        approved_changes = {}
        if self.arbiter and track_requests:
            requests_text = "\n".join(
                f"- {r.get('agent','?')} 希望切换到 {r.get('preferred_mode','merged')}（理由：{r.get('reason','')}）"
                for r in track_requests
            )

            goals = self.goals or []
            goals_text = "；".join(goals) if goals else "推进剧情发展"

            approve_prompt = f"""你是剧本杀主控，请审批以下角色的轨道变更申请。

审批标准（只考虑以下两点）：
1. ✅ 是否符合剧本逻辑——这场戏的设定是什么？角色应该在哪里？
2. ✅ 是否符合场景逻辑——当前场景是否允许这种轨道分配？

【剧本逻辑】当前场景：{scene_text}
【场景设定】{shared_summary or '新开场'}

【角色申请】
{requests_text}

逐条判断，返回JSON：
{{"reviews": [
  {{"agent": "角色名", "approve": true/false, "track": "merged/weak/isolated", "reasoning": "基于剧本和场景逻辑的审批理由"}},
  ...
]}}
注意：至少保持 2 个角色在 merged 轨道，维持剧情推进。"""

            try:
                result = await self.arbiter._llm.call_json(approve_prompt, max_tokens=500)
                reviews = result.get("reviews", [])
            except Exception:
                reviews = []

            for review in reviews:
                agent = review.get("agent", "")
                if review.get("approve", False):
                    approved_changes[agent] = review.get("track", "merged")
                    # 记录申请（用于历史追踪）
                    request_manager.submit_request(
                        agent_name=agent,
                        current_mode="unknown",
                        target_mode=review.get("track", "merged"),
                        reason=review.get("reasoning", ""),
                    )

        # Step 4: 生成最终轨道（基础轨道 + 已批准的变更）
        sc = self._configure_script_tracks()

        # 应用批准的轨道变更
        if approved_changes:
            for track in sc.tracks:
                track.agents = [a for a in track.agents if a not in approved_changes]

            # 为批准变更的角色分配新轨道
            for agent_name, target_mode in approved_changes.items():
                target_track = None
                for t in sc.tracks:
                    if t.mode == target_mode:
                        target_track = t
                        break
                if target_track is None:
                    # 创建新轨道
                    from .track_manager import Track as TrackCls
                    import uuid
                    new_track = TrackCls(
                        id=f"script_{uuid.uuid4().hex[:6]}",
                        agents=[agent_name],
                        agent_actions={agent_name: "active"},
                        mode=target_mode,
                        label=f"轨道{len(sc.tracks)+1}",
                    )
                    sc.tracks.append(new_track)
                else:
                    target_track.agents.append(agent_name)
                    if hasattr(target_track, 'agent_actions'):
                        target_track.agent_actions[agent_name] = "active"

        return sc

    def _build_script_shared_context(self) -> str:
        """为剧本杀模式构建所有角色共享的剧情进度摘要"""
        if not self.memory:
            return ""

        # 获取最近几轮的摘要
        summary = self.memory.get_summary_context() if hasattr(self.memory, 'get_summary_context') else ""

        # 补充当前场景信息
        parts = []
        if self.scene_description:
            parts.append(f"场景：{self.scene_description}")
        if self.current_round:
            parts.append(f"当前第{self.current_round}轮")
        if self.goals:
            parts.append(f"剧情目标：{'；'.join(self.goals[:3])}")
        if summary:
            parts.append(f"剧情进度：{summary[:500]}")

        return "\n".join(parts) if parts else "（对话刚开始）"

    def _get_script_character_goals(self) -> list:
        """获取剧本杀模式中所有角色的个人目标"""
        goals = []
        for name, agent in self.agents.items():
            goal = ""
            if hasattr(agent.persona, 'script_goal') and agent.persona.script_goal:
                goal = agent.persona.script_goal
            elif hasattr(agent.persona, 'description'):
                # 从角色描述中提取目标
                goal = agent.persona.description[:100] if agent.persona.description else ""
            goals.append({"name": name, "goal": goal or "无明确目标"})
        return goals

    def _filter_game_output(self, agent_name: str, content: str, mode: str) -> str:
        """Filter AI output in rule-based modes — only keep speech + actions.
        Strips internal monologue, narration, and meta-commentary."""
        if mode not in ("script", "werewolf"):
            return content
        import re
        # Remove parentheses/brackets internal thoughts: （...）【...】(...) [...]  — if they contain introspective content
        filtered = re.sub(r'[（\(\[【][^）\)\]】]*(?:心想|思考|想|觉得|认为|猜测|怀疑|内心|暗自|暗中)[^）\)\]】]*[）\)\]】]', '', content)
        # Remove narration markers
        filtered = re.sub(r'【[^】]*】', '', filtered)
        # Clean up extra whitespace
        filtered = re.sub(r'\n{2,}', '\n', filtered).strip()
        if not filtered:
            filtered = content  # fallback: return original if filter removed everything
        return filtered

    def _clean_tts_text(self, raw: str) -> str:
        """清洗文本用于TTS：只保留说话内容，去掉动作/心理/括号标注"""
        import re
        # 去掉【】内的内容
        text = re.sub(r'\u3010[^\u3011]*\u3011', '', raw)
        # 去掉[]内的内容
        text = re.sub(r'\[[^\]]*\]', '', text)
        # 去掉（）内的内容（中文括号的心理活动）
        text = re.sub(r'\（[^\）]*\）', '', text)
        # 去掉( )内的内容
        text = re.sub(r'\([^)]*\)', '', text)
        # 去掉【*】强调标记
        text = re.sub(r'\*[^*]*\*', '', text)
        # 清理多余空白
        text = re.sub(r'\s+', ' ', text).strip()
        # 如果清洗后为空，返回原文本的前50字（保底）
        if not text or len(text) < 2:
            return raw[:80]
        return text

    async def _stream_tts_to_frontend(self, text: str, lang: str = "zh",
                                        backend: str = "auto") -> None:
        """将文本转为语音并流式推送到前端
        自动清洗非对话内容（动作/心理/括号标注），TTS只朗读说话文本。
        
        backend:
            - "edge": Edge TTS (低延迟流式)，me与单角色对话时用
            - "cosyvoice": 千问 CosyVoice (高音质)，多角色/旁白时用
            - "auto": 自动选择
        """
        try:
            clean = self._clean_tts_text(text)
            await self._emit("tts_start", {
                "text": clean[:50] + "..." if len(clean) > 50 else clean,
                "lang": lang,
                "backend": backend,
                "original": text[:30] + "..." if len(text) > 30 else text,
            })

            async for audio_chunk in stream_tts(clean, lang=lang, backend=backend):
                chunk_b64 = base64.b64encode(audio_chunk).decode("ascii")
                await self._emit("tts_chunk", {
                    "data": chunk_b64,
                    "len": len(audio_chunk),
                })

            await self._emit("tts_end", {"status": "done"})
        except Exception as e:
            await self._emit("tts_error", {"error": str(e)})

    def _build_character_relations(self, script_data: dict) -> None:
        """Build internal relationship graph from script relationships."""
        self._character_relations = {}

        relationships = script_data.get("relationships", [])
        for rel in relationships:
            from_char = rel.get("from", rel.get("from_char", ""))
            to_char = rel.get("to", "")
            relation = rel.get("relation", "")
            desc = rel.get("description", "")

            if from_char and to_char:
                if from_char not in self._character_relations:
                    self._character_relations[from_char] = {}
                self._character_relations[from_char][to_char] = {
                    "relation": relation,
                    "description": desc,
                }

        # Store relationship graph in memory
        if self._character_relations:
            rel_lines = []
            for from_c, targets in self._character_relations.items():
                for to_c, info in targets.items():
                    rel_lines.append(f"{from_c}→{to_c}: {info['relation']}（{info['description']}）")

            rel_msg = Message(
                role="system", name="主控",
                content="【角色关系图】\n" + "\n".join(rel_lines),
                track_id="main", visible_to=list(self.agents.keys()),
                importance=IMPORTANCE_NORMAL,
            )
            self.memory.add_message(rel_msg)

    def _generate_script_scenes(self, script_data: dict) -> None:
        """Generate scene descriptions from script scenes."""
        scenes = []

        script_scenes = script_data.get("scenes", [])
        for i, scene in enumerate(script_scenes):
            if scene.get("description"):
                scenes.append({
                    "scene_id": scene.get("scene_id", f"scene_{i}"),
                    "name": scene.get("name", f"第{i+1}幕"),
                    "description": scene.get("description", ""),
                    "characters_involved": scene.get("characters_involved", []),
                    "order": scene.get("order", i),
                })

        if not scenes and script_data.get("description"):
            desc = script_data.get("description", "")
            scenes.append({
                "scene_id": "scene_0",
                "name": "开场",
                "description": desc,
                "characters_involved": list(self.agents.keys()),
                "order": 0,
            })

        self._script_scenes = sorted(scenes, key=lambda s: s.get("order", 0))

    def _prevent_drift_prompt(self, agent_name: str) -> str:
        """Generate anti-drift prompt for an agent based on script config."""
        if not self._script_config:
            return ""

        characters = self._script_config.get("characters", [])
        char_info = None
        for c in characters:
            c_dict = c if isinstance(c, dict) else c
            if c_dict.get("name") == agent_name:
                char_info = c_dict
                break

        if not char_info:
            return ""

        parts = [f"【剧本角色设定 — {agent_name}】"]
        if char_info.get("persona"):
            parts.append(f"人格：{char_info['persona'][:300]}")
        if char_info.get("goal"):
            parts.append(f"当前目标：{char_info['goal']}")
        if char_info.get("background"):
            parts.append(f"背景：{char_info['background'][:200]}")

        # Add relationships
        rels = self._character_relations.get(agent_name, {})
        if rels:
            rel_lines = []
            for target, info in rels.items():
                rel_lines.append(f"与{target}的关系：{info['relation']}（{info['description']}）")
            parts.append("角色关系：\n" + "\n".join(rel_lines))

        parts.append("请严格依据以上设定行动，不要偏离角色的背景、目标和人际关系。")
        return "\n\n".join(parts)

    def _get_relation_summary(self, agent_name: str) -> str:
        """Get a brief relationship summary for an agent."""
        rels = self._character_relations.get(agent_name, {})
        if not rels:
            return ""
        parts = []
        for target, info in rels.items():
            parts.append(f"与{target}：{info['relation']}")
        return "；".join(parts)

    def _advance_script_scene(self) -> Optional[dict]:
        """Advance to the next scene in the script."""
        if not self._script_scenes:
            return None
        self._current_script_scene_index += 1
        if self._current_script_scene_index >= len(self._script_scenes):
            return None
        scene = self._script_scenes[self._current_script_scene_index]
        self.scene_description = scene.get("description", "")
        return scene

    # ================================================================
    # Private chat
    # ================================================================

    async def handle_private_chat_request(self, player_name: str, target: str, message: str = "") -> dict:
        """Director judges whether to allow a private chat request.
        Returns {'allowed': bool, 'reason': str, 'track_id': str}."""
        is_director = self.config.mode.mode in ("director", "werewolf")
        dc = self.config.mode.director_character

        # Validate participants
        all_names = set(self.agents.keys())
        if player_name not in all_names and player_name not in self._werewolf_human_players:
            return {"allowed": False, "reason": f"玩家 '{player_name}' 不在当前会话中", "track_id": ""}
        if target not in all_names and target not in self._werewolf_human_players:
            return {"allowed": False, "reason": f"角色 '{target}' 不在当前会话中", "track_id": ""}
        if player_name == target:
            return {"allowed": False, "reason": "不能和自己私聊", "track_id": ""}

        # PrivateChatManager rule-based phase check
        if hasattr(self, '_private_chat_manager'):
            phase = self._werewolf_state.phase if self._werewolf_state else ""
            manager_result = self._private_chat_manager.request_chat(player_name, target, message, phase)
            if not manager_result.approved:
                return {"allowed": False, "reason": manager_result.reason, "track_id": ""}

        # Check if already has an active private track with this target
        for tid, track in list(self._private_tracks.items()):
            if player_name in track.agents and target in track.agents:
                return {"allowed": True, "reason": "已有活跃的私聊轨道", "track_id": tid}

        # Director judgment (LLM call)
        if self.arbiter:
            judgment = await self._director_judge_private_chat(player_name, target, message)
        else:
            judgment = {"allowed": True, "reason": "导演未启用，默认允许"}

        if not judgment.get("allowed", False):
            return {"allowed": False, "reason": judgment.get("reason", "现在不是合适的时机"), "track_id": ""}

        # Create private track
        track_id, track = self._create_private_track(player_name, target, dc)

        # Notify participants
        reason_text = judgment.get("reason", "")
        notify_msg = Message(
            role="system", name="主控",
            content=f"【私聊开始】{player_name} 和 {target} 的私聊已建立。{reason_text}",
            track_id=track_id,
            visible_to=[player_name, target, dc] if dc else [player_name, target],
            importance=IMPORTANCE_NORMAL,
        )
        self.memory.add_message(notify_msg)

        return {"allowed": True, "reason": reason_text, "track_id": track_id}

    async def _director_judge_private_chat(self, player_name: str, target: str, message: str) -> dict:
        """LLM call to judge whether private chat should be allowed."""
        if not self.arbiter or not self._llm:
            return {"allowed": True, "reason": ""}

        scene = self.scene_description or "未指定场景"
        alive_info = ""
        if self._werewolf_state:
            alive = self._werewolf_state.alive_players
            phase = self._werewolf_state.phase
            alive_info = f"当前阶段: {phase}，存活玩家: {'、'.join(alive)}"

        prompt = (
            f"你是一个角色扮演游戏的主控（导演）。以下是一位玩家请求与另一位角色私聊的请求：\n\n"
            f"请求者: {player_name}\n"
            f"私聊目标: {target}\n"
            f"请求消息: {message or '(无附加消息)'}\n"
            f"当前场景: {scene}\n"
            f"{alive_info}\n\n"
            f"请根据当前剧情阶段、角色关系和故事发展，判断是否应该允许这次私聊。\n"
            f"私聊应当合理：比如两人私下交谈、传递秘密信息等。\n"
            f"如果拒绝，请给出简短的理由（如'现在不是合适的时机'）。\n\n"
            f"返回JSON格式：{{\"allowed\": true/false, \"reason\": \"理由\"}}"
        )

        try:
            response = await self._llm.chat(
                messages=[{"role": "user", "content": prompt}],
                max_tokens=100, temperature=0.3, stream=False,
            )
            result = json.loads(response.strip())
            return {"allowed": result.get("allowed", True), "reason": result.get("reason", "")}
        except Exception:
            return {"allowed": True, "reason": ""}

    def _create_private_track(self, player_name: str, target: str, dc: str = "") -> tuple:
        """Create an isolated private chat track between two players."""
        track_id = f"private_{player_name}_{target}_{int(time.time())}"
        agents = [player_name, target]
        if dc and dc not in agents:
            agents.append(dc)

        track = Track(
            id=track_id,
            agents=agents,
            agent_actions={n: "active" for n in agents},
            mode="isolated",
            color="#9C27B0",
            label=f"{player_name}↔{target} 私聊",
        )
        self._private_tracks[track_id] = track
        return track_id, track

    def destroy_private_track(self, track_id: str) -> bool:
        """Destroy a private chat track."""
        if track_id in self._private_tracks:
            track = self._private_tracks.pop(track_id)
            dc = self.config.mode.director_character
            visible_to = track.agents if dc and dc in track.agents else track.agents
            close_msg = Message(
                role="system", name="主控",
                content="【私聊结束】私聊已结束。",
                track_id=track_id,
                visible_to=visible_to,
                importance=IMPORTANCE_NORMAL,
            )
            self.memory.add_message(close_msg)
            return True
        return False

    def get_private_tracks(self, player_name: str = "") -> List[dict]:
        """Get private tracks, optionally filtered by player."""
        result = []
        for tid, track in self._private_tracks.items():
            if player_name and player_name not in track.agents:
                continue
            result.append({
                "track_id": tid,
                "agents": track.agents,
                "label": track.label,
                "mode": track.mode,
            })
        return result

    async def send_private_message(self, track_id: str, player_name: str, text: str) -> dict:
        """Send a message in a private chat track."""
        if track_id not in self._private_tracks:
            return {"status": "error", "message": "私聊轨道不存在或已销毁"}

        track = self._private_tracks[track_id]
        if player_name not in track.agents:
            return {"status": "error", "message": "你不是该私聊的参与者"}

        msg = Message(
            role="agent", name=player_name, content=text,
            track_id=track_id,
            visible_to=track.agents,
            importance=IMPORTANCE_NORMAL,
        )
        self.memory.add_message(msg)
        await self._emit("agent_output", {
            "agent_name": player_name, "content": text,
            "track_id": track_id, "track_label": track.label,
            "track_mode": "isolated",
            "visible_to": track.agents,
        })

        return {"status": "ok", "message": "私聊消息已发送", "track_id": track_id}

    # ================================================================
    # Track configuration
    # ================================================================

    async def _configure_tracks(self) -> TrackConfig:
        """Arbiter configures this round's tracks."""
        # 静默处理上一轮遗留的待审批轨道变更申请
        from .track_request import request_manager, RequestType
        self._process_pending_track_requests()

        # 根据模式和活跃度设置轨道变更频率
        activity = getattr(self.config.mode, 'track_activity', 'auto')
        mode = self.config.mode.mode

        # 一般模式：最低活跃度（尽量不变链）
        # 剧本杀模式：最高活跃度（频繁变链）
        # 其他模式：自动
        if activity == 'auto':
            if mode in ('free', 'protagonist', 'director'):
                self._track_activity_level = 'minimal'
            elif mode == 'script':
                self._track_activity_level = 'maximum'
            else:
                self._track_activity_level = 'normal'
        else:
            self._track_activity_level = activity

        # 记录上一轮的轨道分配，用于后续对比检测角色轨道变化
        self._prev_track_modes: dict = {}
        if self.current_track_config:
            for t in self.current_track_config.tracks:
                for agent_name in t.agents:
                    self._prev_track_modes[agent_name] = t.mode

        # Werewolf mode: use LLM arbiter like free mode, with game state context
        if self.config.mode.mode == "werewolf" and self._werewolf_state:
            if self.arbiter:
                state = self._werewolf_state
                phase_cn = {"night":"夜间","discussion":"白天讨论","voting":"投票"}.get(state.phase, state.phase)
                desc = f"狼人杀第{state.round_number}轮 {phase_cn}。存活:{'、'.join(state.alive_players)}。"
                tracks, reasoning = await self.arbiter.configure_tracks(
                    scene_description=desc,
                    agent_names=list(self.agents.keys()),
                    history_summary="",
                    mode_config=self.config.mode,
                    previous_tracks=self.current_track_config.tracks if self.current_track_config else None,
                )
                tc = TrackConfig(tracks=tracks, round=self.current_round, description=reasoning)
                self.current_track_config = tc
                self.track_history.append(tc.to_dict())
                return tc
            wc = await self._configure_werewolf_tracks()
            self.current_track_config = wc
            self.track_history.append(wc.to_dict())
            return wc

        # Script mode: 角色目标驱动的变链申请 → 审批 → 定轨 → 对话
        if self.config.mode.mode == "script" and self._script_config:
            sc = await self._configure_script_tracks_with_requests()
            self.current_track_config = sc
            self.track_history.append(sc.to_dict())
            return sc

        if not self.arbiter:
            all_names = list(self.agents.keys())
            tracks = []
            # 一般模式：≥3人自动加主控
            if self.config.mode.mode == "free" and len(all_names) >= 3:
                narrator_track = Track(
                    id="narrator", agents=["主控"],
                    agent_actions={"主控": "silent"},
                    mode="merged", label="主控视角", color="#FFB300",
                )
                tracks.append(narrator_track)
            # Free mode: human player "me" should be silent (AI doesn't generate for them)
            actions = {n: "active" for n in all_names}
            if self.config.mode.mode == "free" and "me" in actions:
                actions["me"] = "silent"
            main_track = Track(id="main", agents=all_names,
                          agent_actions=actions,
                          mode="merged", label="主线", color=TRACK_COLORS[0])
            tracks.append(main_track)
            return TrackConfig(tracks=tracks, round=self.current_round, description="默认")

        history_summary = self.memory.get_summary_context(use_structured=True)

        prev_tracks = self.current_track_config.tracks if self.current_track_config else None
        tracks, reasoning = await self.arbiter.configure_tracks(
            scene_description=self.scene_description,
            agent_names=list(self.agents.keys()),
            history_summary=history_summary or "(新对话)",
            mode_config=self.config.mode,
            previous_tracks=prev_tracks,
        )

        # 一般模式：≥3人自动注入主控轨道
        if self.config.mode.mode == "free" and len(self.agents) >= 3:
            has_narrator = any("主控" in t.agents for t in tracks)
            if not has_narrator:
                narrator_track = Track(
                    id="narrator", agents=["主控"],
                    agent_actions={"主控": "silent"},
                    mode="merged", label="主控视角", color="#FFB300",
                )
                tracks.insert(0, narrator_track)

        dc = self.config.mode.director_character
        if self.config.mode.mode in ("director", "werewolf", "script") and dc and dc in self.agents:
            for track in tracks:
                if dc in track.agents:
                    if track.mode == "isolated":
                        track.mode = "merged"
                    if hasattr(track, 'agent_actions'):
                        track.agent_actions[dc] = "silent"
        # Free mode: human player "me" should always be silent
        if self.config.mode.mode == "free" and "me" in self.agents:
            for track in tracks:
                if "me" in track.agents and hasattr(track, 'agent_actions'):
                    track.agent_actions["me"] = "silent"

        # 检测角色自主轨道变更：对比上一轮和本轮，记录为角色自主申请+已批准
        new_modes: dict = {}
        for t in tracks:
            for agent_name in t.agents:
                new_modes[agent_name] = t.mode

        activity_level = getattr(self, '_track_activity_level', 'normal')
        from .i18n import t as _t
        lang = getattr(self.config.mode, 'language', 'zh')

        for agent_name, new_mode in new_modes.items():
            old_mode = self._prev_track_modes.get(agent_name)
            if old_mode and old_mode != new_mode:
                # 根据活跃度决定是否记录
                if activity_level == 'minimal':
                    continue  # 一般模式：忽略轨道变化，保持稳定
                elif activity_level == 'normal':
                    # 普通模式：只记录大幅变化（isolated ↔ merged）
                    strengths = {'isolated': 0, 'weak': 1, 'merged': 2}
                    diff = abs(strengths.get(new_mode, 0) - strengths.get(old_mode, 0))
                    if diff < 2:
                        continue  # 小幅变化不记录
                # maximum: 记录所有变化（剧本杀模式）

                reason = _t("track_change_req", lang)
                req = request_manager.submit_request(
                    agent_name=agent_name,
                    target_agent="",
                    current_mode=old_mode,
                    target_mode=new_mode,
                    reason=reason,
                )
                # 主控已在本轮批准该变更，标记为已批
                if req.status.value == "pending":
                    goals_text = ", ".join(self.goals) if self.goals else "无明确目标"
                    approve_reason = _t("track_change_approve", lang, goals=goals_text)
                    request_manager.approve_request(req.id, approve_reason)

        tc = TrackConfig(tracks=tracks, round=self.current_round, description=reasoning)
        self.current_track_config = tc
        self.track_history.append(tc.to_dict())
        return tc

    async def _assign_tasks(self) -> List[dict]:
        """Derive explicit per-agent tasks from the current track config."""
        # Werewolf mode: use game-phase tasks
        if self.config.mode.mode == "werewolf" and self._werewolf_state:
            return await self._assign_werewolf_tasks()

        base = "继续当前场景中的下一步行动，保持人设和已建立事实"
        if self.current_scene and self.scene_description:
            base += "；不要擅自切换场景"
        if self.goals:
            base += f"；当前剧情目标：{'；'.join(self.goals[:3])}"

        # Check previous round outputs for length violations
        overlong_agents: Dict[str, int] = {}
        if self.memory and self.memory.session and self.memory.session.round_log:
            prev_round = self.memory.session.round_log[-1]
            for out in prev_round.get("outputs", []):
                length = out.get("content_length", 0)
                if length > 350:
                    overlong_agents[out["agent_name"]] = length

        dc = self.config.mode.director_character
        is_director = self.config.mode.mode in ("director", "werewolf")

        if not self.current_track_config:
            agents = [n for n in self.agents if not (is_director and n == dc)]
            return [{"agent_name": n, "task": base} for n in agents]

        tasks = []
        for track in self.current_track_config.tracks:
            track_scope = ""
            if track.mode == "merged":
                track_scope = "你与同轨角色处在同一场景，可直接回应对方。"
            elif track.mode == "weak":
                track_scope = "你能听到同轨角色的动静，但不要假定自己知道隔离信息。"
            elif track.mode == "isolated":
                track_scope = "你处于隔离轨道，只依据自己可见的上下文行动。"
            for name, action in track.agent_actions.items():
                if action == "active" and not (is_director and name == dc):
                    task_text = f"{base}。{track_scope}只写{name}自己的台词、动作和判断。"
                    if name in overlong_agents:
                        task_text += f"注意：上一轮你的发言过长（{overlong_agents[name]}字），本轮请控制在500字以内，保持简洁有力。"
                    tasks.append({"agent_name": name, "task": task_text})
        return tasks or [{"agent_name": n, "task": base} for n in self.agents if not (is_director and n == dc)]

    # ================================================================
    # Agent execution
    # ================================================================

    async def _generate_for_agent(
        self, agent, agent_name: str, track, tasks: list, same_round_outputs: list = None
    ) -> str:
        """Generate a response for one agent with persona and track-aware context."""
        system_prompt = agent.persona.get_prompt_by_round(self.current_round)

        # Script drift prevention: append character constraints
        if self._script_config:
            drift_prompt = self._prevent_drift_prompt(agent_name)
            if drift_prompt:
                system_prompt = system_prompt + "\n\n" + drift_prompt
        context_msgs = self._build_agent_context(agent_name)
        # In werewolf mode, skip compressed summary context to prevent role info leakage
        if self.config.mode.mode == "werewolf" and self._werewolf_state:
            summary_context = ""
        else:
            summary_context = self.memory.get_compressed_context() if self.memory else ""

        task_text = "继续当前对话"
        for t in tasks:
            if t.get("agent_name") == agent_name:
                task_text = t.get("task", task_text)
                break

        # Build roster — in werewolf mode, only show alive players
        if self.config.mode.mode == "werewolf" and self._werewolf_state:
            roster_names = self._werewolf_state.alive_players
        else:
            roster_names = list(self.agents.keys())

        roster_lines = []
        for name in roster_names:
            active_agent = self.agents.get(name)
            if not active_agent:
                continue
            marker = "（你）" if name == agent_name else ""
            roster_lines.append(f"- {active_agent.persona.fingerprint_prompt}{marker}")
        roster_text = "\n".join(roster_lines) if roster_lines else "- 无"

        track_mode = getattr(track, "mode", "merged") if track else "merged"
        track_agents = getattr(track, "agents", list(self.agents.keys())) if track else list(self.agents.keys())
        interactable_agents = [n for n in track_agents if n != agent_name]
        other_info = "、".join(interactable_agents) if interactable_agents else "无"

        if track_mode == "isolated":
            track_policy = "本轮你在隔离轨道。不得引用本轮其他角色刚说的话；只能依据历史中对你可见的内容行动。"
            visible_round_outputs = []
        elif track_mode == "weak":
            track_policy = "本轮是弱链轨道。你可以听到同轨前序发言，但只把它当作现场线索，不要替对方补完心理和行动。"
            visible_round_outputs = same_round_outputs or []
        else:
            track_policy = "本轮是强链轨道。同轨前序发言是刚刚发生的对话，你可以直接承接。"
            visible_round_outputs = same_round_outputs or []

        round_context = ""
        if visible_round_outputs:
            round_parts = []
            for out in visible_round_outputs[-4:]:
                round_parts.append(f"[{out['agent_name']}刚刚说]：{out['content'][:260]}")
            round_context = "\n\n【本轮已发生的同轨对话】\n" + "\n".join(round_parts)

        scene_text = self.scene_description or "未设置具体场景"

        werewolf_context = ""
        if self.config.mode.mode == "werewolf" and self._werewolf_state:
            role_hint = self._werewolf_role_hints.get(agent_name, "")
            phase = self._werewolf_state.phase

            phase_instructions = {
                "night": (
                    "现在是夜晚阶段。狼人请秘密商量今晚要暗杀的目标；预言家可以查验一人身份；"
                    "女巫可以决定是否使用解药或毒药。白天时请伪装好身份，不要暴露。"
                    "请直接给出你的行动，格式如【暗杀X】【查验X】等。"
                ),
                "day_discuss": (
                    "现在是白天讨论阶段。所有存活玩家公开讨论，推理谁是狼人。"
                    "请根据你的身份发言——如果你是狼人，请伪装成村民；如果你是好人，请分享你的推理。"
                    "请直接给出你的发言内容。"
                ),
                "day_vote": (
                    "现在是投票阶段。请根据讨论内容，投票放逐你认为最可能是狼人的一名玩家。"
                    "格式：【投票X】其中X为目标角色名。"
                ),
            }
            phase_text = phase_instructions.get(phase, "")

            werewolf_context = f"""
【狼人杀模式 — 你的身份与当前阶段】
{role_hint}

当前阶段：{phase}
本轮号：{self._werewolf_state.round_number}
存活玩家：{'、'.join(self._werewolf_state.alive_players)}

{phase_text}
"""

        address_instruction = f"""
【本轮身份与场景约束】
当前场景：{scene_text}{werewolf_context}
当前轨道：{track_mode}；同轨角色：{'、'.join(track_agents)}
可互动角色：{other_info}
{track_policy}

【角色名册，用于防混淆】
{roster_text}

【输出规则】
1. 你只能扮演{agent_name}，不能替其他角色写台词、动作、心理活动或结论。
2. 如果需要回应别人，明确写出回应对象，但不要把对方的风格变成自己的风格。
3. 优先承接当前场景、当前物件、上一轮事实和本轮任务。
4. 不要突然引入无关地点、无关角色或重置剧情。
5. 回复应体现{agent_name}的人格与说话风格。
"""

        prompt_interjection = {
            "sender": "主控",
            "content": (
                f"【本轮任务】{task_text}\n\n"
                f"{round_context}\n\n"
                f"{address_instruction}\n"
                f"请直接输出{agent_name}的回应。"
            ),
        }

        full = ""
        async for chunk in agent.generate(
            system_prompt=system_prompt,
            history=context_msgs,
            user_interjection=prompt_interjection,
            summary_context=summary_context,
            stream=False,
            task_type="chat",
        ):
            full = chunk
        return full

    async def _run_round_agents(self, tasks: List[dict]) -> List[dict]:
        """Execute all tracks' active agents sequentially. Human players use buffer."""
        if not self.current_track_config:
            return []

        all_outputs = []
        for track in self.current_track_config.tracks:
            track_outputs = []

            # Pre-inject buffered messages from silent human players
            all_humans = self._werewolf_human_players | self._script_human_players
            for agent_name in track.silent_agents:
                if agent_name in all_humans:
                    content = self._werewolf_human_buffer.pop(agent_name, None)
                    if content:
                        visible_to = [agent_name] if track.mode == "isolated" else track.agents
                        output_item = {
                            "agent_name": agent_name, "content": content,
                            "track_id": track.id, "visible_to": visible_to,
                        }
                        all_outputs.append(output_item)
                        track_outputs.append(output_item)
                        await self._emit("agent_output", {
                            "agent_name": agent_name, "content": content,
                            "track_id": track.id, "track_label": track.label,
                            "track_mode": track.mode,
                            "visible_to": visible_to,
                        })

            for agent_name in track.active_agents:
                all_humans = self._werewolf_human_players | self._script_human_players
                if agent_name in all_humans:
                    content = self._werewolf_human_buffer.pop(agent_name, None)
                    if content:
                        visible_to = [agent_name] if track.mode == "isolated" else track.agents
                        output_item = {
                            "agent_name": agent_name, "content": content,
                            "track_id": track.id, "visible_to": visible_to,
                        }
                        all_outputs.append(output_item)
                        track_outputs.append(output_item)
                        await self._emit("agent_output", {
                            "agent_name": agent_name, "content": content,
                            "track_id": track.id, "track_label": track.label,
                            "track_mode": track.mode,
                            "visible_to": visible_to,
                        })
                    continue

                agent = self.agents.get(agent_name)
                if agent:
                    try:
                        content = await self._generate_for_agent(
                            agent, agent_name, track, tasks,
                            same_round_outputs=track_outputs if track.mode in ("merged", "weak") else [],
                        )
                        if content:
                            # Apply output filter for rule-based modes
                            filtered = self._filter_game_output(agent_name, content, self.config.mode.mode)
                            if filtered and filtered != content:
                                # Emit filter notice to 主控
                                pass  # 主控 receives both original and filtered
                            visible_to = [agent_name] if track.mode == "isolated" else track.agents
                            content = filtered  # Use filtered content for output
                            output_item = {
                                "agent_name": agent_name, "content": content,
                                "track_id": track.id, "visible_to": visible_to,
                            }
                            all_outputs.append(output_item)
                            track_outputs.append(output_item)
                            await self._emit("agent_output", {
                                "agent_name": agent_name, "content": content,
                                "track_id": track.id, "track_label": track.label,
                                "track_mode": track.mode,
                                "visible_to": visible_to,
                            })
                            # 流式 TTS：根据上下文选择后端
                            # me+单角色对话 → Edge (低延迟流式)
                            # 多角色/旁白 → CosyVoice (高音质)
                            if content and len(content) > 5:
                                lang = getattr(self.config.mode, 'language', 'zh')
                                # 判断是否 me+单角色对话
                                agent_count = len(track.agents) if track else 0
                                has_me = "me" in (track.agents if track else [])
                                chat_mode = self.config.mode.mode
                                if chat_mode in ("free", "director") and has_me and agent_count <= 2:
                                    tts_backend = "edge"
                                else:
                                    tts_backend = "cosyvoice"
                                try:
                                    asyncio.create_task(self._stream_tts_to_frontend(content, lang, tts_backend))
                                except Exception:
                                    pass
                    except Exception as e:
                        err = f"[{agent_name} 走神了: {e}]"
                        visible_to = [agent_name] if track.mode == "isolated" else track.agents
                        all_outputs.append({
                            "agent_name": agent_name, "content": err,
                            "track_id": track.id, "visible_to": visible_to,
                        })

        return all_outputs

    def _build_agent_context(self, agent_name: str) -> List[Message]:
        """Build context messages visible to one agent."""
        return self.memory.get_agent_context(agent_name)

    # ================================================================
    # Round orchestration
    # ================================================================

    async def run_round(self) -> AsyncGenerator[MessageEvent, None]:
        """Execute one full round."""
        if self.phase == TurnPhase.RUNNING:
            return
        if self._werewolf_waiting_for_human:
            return  # Skip: waiting for player input, don't enter try/finally

        self.phase = TurnPhase.RUNNING
        self._stop_requested = False
        self.current_round += 1

        try:
            # Phase 1: Configure tracks
            self.round_phase = RoundPhase.CONFIGURE_TRACKS
            track_config = await self._configure_tracks()

            yield MessageEvent("round_start", {
                "round": self.current_round,
                "track_config": track_config.to_dict(),
                "scene": self.current_scene or "",
            })

            # Phase 2: Assign tasks (zero-LLM)
            self.round_phase = RoundPhase.ASSIGN_TASKS
            tasks = await self._assign_tasks()

            # Sanitize tasks for the event (strip private task content in werewolf mode)
            if self.config.mode.mode == "werewolf" and self._werewolf_state:
                sanitized_tasks = [
                    {"agent_name": t["agent_name"], "task": f"【狼人杀】第{self._werewolf_state.round_number}轮 - {self._werewolf_state.phase}阶段"}
                    for t in tasks
                ]
            else:
                sanitized_tasks = tasks

            yield MessageEvent("arbiter_task", {
                "round": self.current_round,
                "tasks": sanitized_tasks,
                "track_config": track_config.to_dict(),
            })

            # Phase 3: Run agents
            self.round_phase = RoundPhase.AGENTS_RUNNING
            all_outputs = await self._run_round_agents(tasks)

            if self._stop_requested:
                yield MessageEvent("stopped", {"round": self.current_round})
                return

            # Phase 4: Integrate
            self.round_phase = RoundPhase.INTEGRATE
            integration = {"narration": "", "scene_progress": ""}

            if self.config.mode.mode == "werewolf" and self._werewolf_state:
                # Werewolf mode: use SAME arbiter architecture as free mode
                # Code handles game rules, LLM handles everything else
                if self.arbiter and all_outputs:
                    state = self._werewolf_state
                    phase_cn = {"night":"夜间","discussion":"白天讨论","voting":"投票"}.get(state.phase, state.phase)
                    alive = "、".join(state.alive_players)
                    dead = "、".join(e.get("name","") for e in state.eliminated) if state.eliminated else "无"
                    scene_desc = f"狼人杀第{state.round_number}轮 {phase_cn}。存活:{alive}。出局:{dead}。"
                    integration = await self.arbiter.integrate_outputs(
                        scene_description=scene_desc,
                        tracks=track_config.tracks,
                        agent_outputs=all_outputs,
                    )
                    # Code verification: run game rules silently
                    code_narration, phase_change = await self._integrate_werewolf_phase(all_outputs)
                    integration["scene_progress"] = phase_change
                    integration["narration"] = integration.get("narration") or code_narration
                else:
                    narration, phase_change = await self._integrate_werewolf_phase(all_outputs)
                    integration = {"narration": narration, "scene_progress": phase_change}
            elif self.arbiter and all_outputs:
                # Free mode with <3 participants: skip arbiter/narrator integration
                if self.config.mode.mode == "free" and len(self.agents) < 3:
                    integration = {"narration": "", "scene_progress": ""}
                else:
                    integration = await self.arbiter.integrate_outputs(
                    scene_description=self.scene_description,
                    tracks=track_config.tracks,
                    agent_outputs=all_outputs,
                )

            yield MessageEvent("arbiter_integrate", {
                "round": self.current_round,
                "narration": integration["narration"],
                "scene_progress": integration["scene_progress"],
                "next_round": integration.get("next_round", {}),
                "chain_analysis": integration.get("chain_analysis", {}),
            })

            # Phase 5: Save to memory
            self.round_phase = RoundPhase.COMPLETE

            for output in all_outputs:
                msg = Message(
                    role="agent", name=output["agent_name"], content=output["content"],
                    track_id=output.get("track_id", "main"),
                    visible_to=output.get("visible_to", []),
                    round_number=self.current_round,
                    importance=IMPORTANCE_NORMAL,
                )
                self.memory.add_message(msg)

            if integration["narration"]:
                # In werewolf mode, only alive players see the integration
                if self.config.mode.mode == "werewolf" and self._werewolf_state:
                    visible_to = list(self._werewolf_state.alive_players)
                else:
                    visible_to = list(self.agents.keys())
                integ_msg = Message(
                    role="arbiter", name="主控", content=integration["narration"],
                    track_id="main", visible_to=visible_to,
                    round_number=self.current_round,
                    importance=IMPORTANCE_NORMAL,
                )
                self.memory.add_message(integ_msg)

            self.memory.set_current_tracks(track_config.to_dict()["tracks"])

            # Round log
            round_data = {
                "round": self.current_round,
                "track_config": track_config.to_dict(),
                "tasks": tasks,
                "outputs": [{"agent_name": o["agent_name"], "content": o["content"][:100], "content_length": len(o["content"])}
                            for o in all_outputs],
                "integration": integration,
                "timestamp": datetime.now().isoformat(),
            }
            if self.memory.session:
                self.memory.session.add_round_log(round_data)

            # Phase 6: Compression check
            if self.compressor and self.compressor.should_compress(self.current_round):
                await self._run_compression()

            # Auto-save
            if self.memory.session:
                self._session_manager.autosave(self.memory.session)

            yield MessageEvent("round_complete", {
                "round": self.current_round,
                "track_config": track_config.to_dict(),
                "outputs": [{"agent_name": o["agent_name"], "content": o["content"]}
                            for o in all_outputs],
                "integration": integration,
                "track_history": self.track_history[-10:],
            })

        except Exception as e:
            print(f"[Router] Round {self.current_round} failed: {e}")
            import traceback
            traceback.print_exc()
            yield MessageEvent("error", {"round": self.current_round, "error": str(e)})
        finally:
            self.phase = TurnPhase.IDLE
            self.round_phase = RoundPhase.IDLE

    # ================================================================
    # Auto rounds
    # ================================================================

    async def run_auto_rounds(self, turns: int = 5) -> AsyncGenerator[MessageEvent, None]:
        """Run multiple rounds automatically."""
        self._auto_running = True
        for _ in range(turns):
            if self._stop_requested:
                break
            async for event in self.run_round():
                yield event
            # Pause auto rounds if werewolf is waiting for human input
            if self._werewolf_waiting_for_human:
                yield MessageEvent("werewolf_wait_human", {
                    "phase": "discussion",
                    "message": "请真人玩家发言",
                    "round": self.current_round,
                })
                break
            await asyncio.sleep(0.1)
        self._auto_running = False
        yield MessageEvent("auto_complete", {"rounds": self.current_round})

    # ================================================================
    # User input
    # ================================================================

    async def handle_user_input(self, text: str, player_name: str = "") -> AsyncGenerator[MessageEvent, None]:
        """Process user input → DM narration → trigger round.
        If player_name is provided in werewolf mode, routes through track pipeline."""
        stripped = text.strip().lower()
        if stripped == "/stop":
            self.stop()
            yield MessageEvent("stopped", {"round": self.current_round})
            return
        if stripped == "/save":
            path = self.memory.save_session()
            yield MessageEvent("saved", {"path": path})
            return

        is_director = self.config.mode.mode in ("director", "werewolf")
        director_char = self.config.mode.director_character
        is_werewolf = self.config.mode.mode == "werewolf" and self._werewolf_state is not None

        # Werewolf mode: human player speech via track pipeline
        if is_werewolf and player_name and player_name in self._werewolf_human_players:
            state = self._werewolf_state
            # Game already over
            if state.phase in ("ended", "game_over"):
                yield MessageEvent("user_input", {
                    "content": "[系统] 游戏已结束。",
                    "round": self.current_round,
                })
                return
            # Dead players cannot speak
            if state.eliminated and any(e.get('name') == player_name for e in state.eliminated):
                yield MessageEvent("user_input", {
                    "content": "[系统] 你已死亡，无法发言。请安静观战。",
                    "round": self.current_round,
                })
                return
            # During night: human can still speak in wolf discussion (track handles visibility)
            # But the night_action API should be used for structured actions
            if state.phase == "night":
                role = state.role_assignments.get(player_name, "")
                # Parse human night action from chat input
                action = None
                target = None
                import re
                if role in ("wolf", "witch", "seer"):
                    # Parse kill: 杀XXX / 暗杀XXX (longer patterns first)
                    m = re.search(r'(?:暗杀|杀)(\S{1,10})', text)
                    if m and m.group(1) in state.alive_players:
                        action, target = "kill", m.group(1)
                    # Parse check: 查XXX / 查验XXX
                    if not action:
                        m = re.search(r'(?:查验|查)(\S{1,10})', text)
                        if m and m.group(1) in state.alive_players:
                            action, target = "check", m.group(1)
                    # Parse save: 救XXX / 救活XXX
                    if not action:
                        m = re.search(r'(?:救活|救)(\S{1,10})', text)
                        if m and m.group(1) in state.alive_players:
                            action, target = "save", m.group(1)
                    # Parse poison: 毒XXX / 毒杀XXX / 毒死XXX
                    if not action:
                        m = re.search(r'(?:毒杀|毒死|毒)(\S{1,10})', text)
                        if m and m.group(1) in state.alive_players:
                            action, target = "poison", m.group(1)
                    # "不救" / "不毒" / "什么都不做"
                    if re.search(r'(?:不救|不毒|不杀|不查|不做|跳过|放弃)', text):
                        action, target = "skip", ""

                if action and target:
                    from ..models.domain import NightAction as NA
                    state.night_actions.append(NA(action_type=action, target=target, source=player_name))
                    self._werewolf_waiting_for_human = False
                    yield MessageEvent("user_input", {
                        "content": f"[系统] 你已选择{'杀' if action == 'kill' else '查' if action == 'check' else '救' if action == 'save' else '毒'}{target}",
                        "round": self.current_round,
                    })
                    # Auto-continue the round
                    async for event in self.run_round():
                        yield event
                    return
                elif action == "skip":
                    self._werewolf_waiting_for_human = False
                    yield MessageEvent("user_input", {
                        "content": "[系统] 你选择不行动。",
                        "round": self.current_round,
                    })
                    # Auto-continue the round
                    async for event in self.run_round():
                        yield event
                    return
                if role in ("villager", "hunter"):
                    yield MessageEvent("user_input", {
                        "content": "[系统] 你是平民/猎人，夜间无法行动。请等待天亮。",
                        "round": self.current_round,
                    })
                    return
            # During discussion: human speech saved directly, triggers transition to voting
            if state.phase == "discussion":
                human_msg = Message(
                    role="agent", name=player_name, content=text,
                    track_id="day_discussion",
                    visible_to=list(state.alive_players),
                    round_number=self.current_round,
                    importance=IMPORTANCE_NORMAL,
                )
                self.memory.add_message(human_msg)
                self._werewolf_discussion_human_spoken = True
                self._werewolf_waiting_for_human = False
                self._werewolf_waiting_for_human = False
                state.phase = "voting"

                # Emit the human's discussion message so frontend can display it
                await self._emit("agent_output", {
                    "agent_name": player_name, "content": text,
                    "track_id": "day_discussion",
                    "track_label": f"第{state.round_number}天讨论",
                    "track_mode": "merged",
                    "visible_to": list(state.alive_players),
                })

                transition_msg = Message(
                    role="system", name="系统",
                    content=f"【第{state.round_number}天】\n真人玩家发言完毕，讨论结束。现在进入投票阶段，请所有玩家投票选出你认为是狼人的人。",
                    track_id="main", visible_to=list(state.alive_players),
                    round_number=self.current_round,
                    importance=IMPORTANCE_NORMAL,
                )
                self.memory.add_message(transition_msg)

                yield MessageEvent("user_input", {
                    "content": text,
                    "character": player_name,
                    "round": self.current_round,
                    "category": "human_discussion",
                })
                yield MessageEvent("arbiter_integrate", {
                    "round": self.current_round,
                    "narration": transition_msg.content,
                    "scene_progress": "discussion→voting",
                    "next_round": {},
                    "chain_analysis": {},
                })
                # Safety: don't start a new round if one is already running
                if self.phase == TurnPhase.RUNNING:
                    print(f"[Router] handle_user_input: round already running, skipping run_round()")
                    return
                async for event in self.run_round():
                    yield event
                return
            # Store message in buffer for _run_round_agents to inject into track
            self._werewolf_human_buffer[player_name] = text
            yield MessageEvent("user_input", {
                "content": text,
                "character": player_name,
                "round": self.current_round,
                "category": "human_speech",
            })
            async for event in self.run_round():
                yield event
            return

        # In werewolf mode, restrict visibility to alive players only
        if is_werewolf:
            # During night, reject user input (players can't talk at night)
            if self._werewolf_state.phase == "night":
                yield MessageEvent("user_input", {
                    "content": "[系统] 现在是夜间阶段，你不能发言。请等待天亮。",
                    "round": self.current_round,
                })
                return
            # During voting, only allow vote format
            if self._werewolf_state.phase == "voting":
                # Let it through but mark as voting
                pass

            visible_players = list(self._werewolf_state.alive_players)
            if director_char in visible_players or director_char not in self.agents:
                pass  # OK to speak
        else:
            visible_players = list(self.agents.keys())

        if is_werewolf:
            visible_to = list(self._werewolf_state.alive_players) if self._werewolf_state else list(self.agents.keys())
        else:
            visible_to = list(self.agents.keys())

        # Free mode: if player_name is provided and is an agent, send as character speech
        if player_name and player_name in self.agents and not is_werewolf:
            char_msg = Message(
                role="agent", name=player_name, content=text,
                track_id="main", visible_to=visible_to,
                round_number=self.current_round,
                importance=IMPORTANCE_USER_INTERRUPT,
            )
            self.memory.add_message(char_msg)
            yield MessageEvent("user_input", {
                "content": text,
                "character": player_name,
                "round": self.current_round,
                "category": "human_speech",
            })
        elif is_director and director_char and director_char in self.agents:
            director_msg = Message(
                role="agent", name=director_char, content=text,
                track_id="main", visible_to=visible_to,
                round_number=self.current_round,
                importance=IMPORTANCE_USER_INTERRUPT,
            )
            self.memory.add_message(director_msg)
            yield MessageEvent("user_input", {
                "content": text,
                "character": director_char,
                "round": self.current_round,
                "category": "director_speech",
            })
        elif self.arbiter:
            context_msgs = self.memory.get_agent_context("")
            category = await self.arbiter.classify_user_input(text, context_history=context_msgs[-10:])

            scene_narration = await self.arbiter.process_user_input(
                text=text, category=category,
                scene_description=self.scene_description,
                agent_names=list(self.agents.keys()),
                goals=self.goals,
            )

            arbiter_msg = Message(
                role="system", name="主控", content=scene_narration,
                track_id="main", visible_to=visible_to,
                round_number=self.current_round,
                importance=IMPORTANCE_USER_INTERRUPT,
            )
            self.memory.add_message(arbiter_msg)

            yield MessageEvent("user_input", {
                "content": f"[主控旁白] {scene_narration}",
                "round": self.current_round,
                "category": category.value,
            })
        else:
            user_msg = Message(
                role="user", name="用户", content=text,
                track_id="main", visible_to=visible_to,
                round_number=self.current_round,
                importance=IMPORTANCE_USER_INTERRUPT,
            )
            self.memory.add_message(user_msg)
            yield MessageEvent("user_input", {"content": text, "round": self.current_round})

        async for event in self.run_round():
            yield event

    # ================================================================
    # Compression
    # ================================================================

    async def _run_compression(self) -> None:
        """Run compression (every 5 rounds)."""
        if self._compressing or not self.compressor:
            return
        self._compressing = True
        try:
            recent_msgs = self.memory.get_short_term_context(max_rounds=5)
            if len(recent_msgs) < 3:
                return

            msg_dicts = [
                {"role": m.role, "name": m.name, "content": m.content}
                for m in recent_msgs
            ]
            start_round = max(0, self.current_round - 5)

            chunk = await self.compressor.compress(
                messages=msg_dicts, start_round=start_round, end_round=self.current_round,
            )

            if self.compressor._llm:
                open_loops = await self.compressor.extract_open_loops(
                    self.memory.session.compressed_chunks + [chunk]
                )
                chunk.open_loops = open_loops

            if self.memory.session:
                self.memory.session.compressed_chunks.append(chunk)

            await self._emit("compression", {
                "round": self.current_round,
                "chunk_id": chunk.chunk_id,
                "summary": chunk.summary,
                "key_events": chunk.key_events,
                "open_loops": chunk.open_loops,
            })
        except Exception as e:
            print(f"[Router] Compression failed: {e}")
        finally:
            self._compressing = False

    # ================================================================
    # Control
    # ================================================================

    def stop(self) -> None:
        self._stop_requested = True
        self._auto_running = False
        self.phase = TurnPhase.STOPPED

    def reset(self) -> None:
        """Reset runtime state while preserving stores."""
        self.agents = {}
        self.memory = MemoryStore(
            session_manager=self._session_manager,
            short_term_rounds=self.config.memory.short_term_rounds,
        )
        self.compressor = None
        self._lorebook_loaded = False
        self.phase = TurnPhase.IDLE
        self.round_phase = RoundPhase.IDLE
        self.session_id = ""
        self.current_round = 0
        self.current_scene = None
        self.scene_description = ""
        self.current_track_config = None
        self.track_history = []
        self._auto_running = False
        self._stop_requested = False
        self._event_callbacks = []
        self._compressing = False
        self._werewolf_state = None
        self._werewolf_role_hints = {}
        self._werewolf_human_players = set()
        self._werewolf_human_buffer = {}
        self._werewolf_discussion_human_spoken = False
        self._werewolf_waiting_for_human = False
        self._private_tracks = {}
        self._script_config = None
        self._script_human_players = set()
        self._character_relations = {}
        self._script_scenes = []
        self._current_script_scene_index = 0

    # ================================================================
    # Goals
    # ================================================================

    def set_goals(self, goals: List[str]) -> None:
        self.goals = goals
        if goals and self.memory.session:
            msg = Message(
                role="system", name="主控",
                content=f"【当前剧情目标】\n" + "\n".join(f"• {g}" for g in goals),
                track_id="main", visible_to=list(self.agents.keys()),
                importance=IMPORTANCE_NORMAL,
            )
            self.memory.add_message(msg)

    def clear_goals(self) -> None:
        self.goals = []

    def get_goals(self) -> List[str]:
        return self.goals

    # ================================================================
    # Silent Track Request System (角色自主申请，主控后台静默审批)
    # ================================================================

    def _process_pending_track_requests(self) -> None:
        """静默处理所有待审批的轨道变更申请。
        不显示在前端，不写入对话上下文。
        """
        from .track_request import request_manager, RequestStatus
        pending = request_manager.get_pending_requests()
        if not pending:
            return

        for req in pending:
            # 根据剧情目标自动判断
            goals = self.goals
            goals_text = ", ".join(goals) if goals else "无明确目标"
            request_manager.approve_request(req.id, f"符合剧情目标: {goals_text}")

            # 静默应用轨道变更
            if hasattr(self, 'track_manager') and self.track_manager:
                tracks = self.track_manager.list_by_agent(req.agent_name)
                for track in tracks:
                    if req.agent_name in track.members:
                        track.members.discard(req.agent_name)
                        track.agent_actions.pop(req.agent_name, None)
                        self._emit("track_updated", track.to_dict())

    # ================================================================
    # State
    # ================================================================

    def get_state(self) -> dict:
        return {
            "session_id": self.session_id,
            "round": self.current_round,
            "phase": self.phase.value,
            "round_phase": self.round_phase.value,
            "agents": list(self.agents.keys()),
            "scene": self.current_scene,
            "scene_description": self.scene_description[:100] if self.scene_description else "",
            "track_config": self.current_track_config.to_dict() if self.current_track_config else None,
            "track_history": self.track_history[-10:] if self.track_history else [],
            "compressed_chunks": len(self.memory.session.compressed_chunks) if self.memory.session else 0,
            "mode": self.config.mode.mode,
            "protagonist": self.config.mode.protagonist,
            "director_character": self.config.mode.director_character,
            "goals": self.goals,
            "werewolf_state": self._werewolf_state.to_dict() if self._werewolf_state else None,
            "werewolf_public_state": self._get_werewolf_public_state() if self._werewolf_state else None,
        }

    def get_conversation_history(self) -> List[Message]:
        if not self.memory.session:
            return []
        return self.memory.session.messages

    def get_round_logs(self) -> List[dict]:
        if not self.memory.session:
            return []
        return self.memory.session.round_log

    def rollback_to_round(self, target_round: int) -> bool:
        """Rollback to a specific round, removing all messages after it."""
        if not self.memory or not self.memory.session:
            return False
        if target_round < 0 or target_round >= self.current_round:
            return False
        if self.phase == TurnPhase.RUNNING:
            self.stop()

        original_count = len(self.memory.session.messages)
        self.memory.session.messages = [
            m for m in self.memory.session.messages
            if getattr(m, 'round_number', 0) <= target_round
        ]
        self.memory.session.round_log = [
            log for log in self.memory.session.round_log
            if log.get('round', 0) <= target_round
        ]
        self.memory.session.compressed_chunks = [
            c for c in self.memory.session.compressed_chunks
            if getattr(c, 'end_round', 0) <= target_round
        ]
        self.track_history = [
            th for th in self.track_history
            if th.get('round', 0) <= target_round
        ]
        self.current_round = target_round

        removed = original_count - len(self.memory.session.messages)
        print(f"[Router] Rolled back to round {target_round}, removed {removed} messages")
        return True
