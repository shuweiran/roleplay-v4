"""
Domain data models for Roleplay v4.

Pure data structures — no IO, no business logic.
Separated from core/ to avoid circular imports between api/ and core/.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional


# ── Importance constants ───────────────────────────────────────────

IMPORTANCE_USER_INTERRUPT = 8
IMPORTANCE_LORE_TRIGGER = 7
IMPORTANCE_NORMAL = 5
IMPORTANCE_REPETITIVE = 1


# ── Track models ───────────────────────────────────────────────────

class TrackMode(str, Enum):
    MERGED = "merged"
    WEAK = "weak"
    ISOLATED = "isolated"


@dataclass
class Track:
    """A single conversation track."""
    id: str = "main"
    agents: List[str] = field(default_factory=list)
    agent_actions: Dict[str, str] = field(default_factory=dict)  # name → active|silent|offline
    mode: str = "merged"
    color: str = "#4CAF50"
    label: str = "主线"

    def __post_init__(self):
        if not self.agent_actions and self.agents:
            if self.mode == "weak":
                self.agent_actions = {n: ("active" if i == 0 else "silent") for i, n in enumerate(self.agents)}
            elif self.mode == "isolated":
                self.agent_actions = {n: "offline" for n in self.agents}
            else:
                self.agent_actions = {n: "active" for n in self.agents}

    @property
    def active_agents(self) -> List[str]:
        """Return active agents in the order they appear in the agents list (i.e., speaking order)."""
        return [n for n in self.agents if self.agent_actions.get(n) == "active"]

    @property
    def silent_agents(self) -> List[str]:
        return [n for n, a in self.agent_actions.items() if a == "silent"]

    def to_dict(self) -> dict:
        return {
            "id": self.id, "agents": self.agents,
            "agent_actions": self.agent_actions, "mode": self.mode,
            "color": self.color, "label": self.label,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Track":
        names = data.get("agents", data.get("agent_names", []))
        if isinstance(names, str):
            names = [names]
        names = [n["name"] if isinstance(n, dict) and "name" in n else str(n) for n in names]
        return cls(
            id=data.get("id", "main"),
            agents=names,
            agent_actions=data.get("agent_actions", {}),
            mode=data.get("mode", "merged"),
            color=data.get("color", "#4CAF50"),
            label=data.get("label", "主线"),
        )


@dataclass
class TrackConfig:
    """A round's full track configuration."""
    tracks: List[Track] = field(default_factory=list)
    round: int = 0
    description: str = ""

    def to_dict(self) -> dict:
        return {
            "round": self.round,
            "tracks": [t.to_dict() for t in self.tracks],
            "description": self.description,
        }

    def get_active_agents(self) -> List[str]:
        return sorted(set(n for t in self.tracks for n in t.active_agents))

    def get_track_for_agent(self, agent_name: str) -> Optional[Track]:
        for t in self.tracks:
            if agent_name in t.agents:
                return t
        return None


# ── Message ────────────────────────────────────────────────────────

@dataclass
class Message:
    """A single conversation message with track-aware visibility."""
    role: str          # "system" | "agent" | "user" | "arbiter"
    name: str
    content: str
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    importance: int = IMPORTANCE_NORMAL
    track_id: str = "main"
    visible_to: List[str] = field(default_factory=list)
    round_number: int = 0
    mode_id: str = ""  # mode identifier for memory isolation

    def to_dict(self) -> dict:
        return {
            "role": self.role, "name": self.name, "content": self.content,
            "timestamp": self.timestamp, "importance": self.importance,
            "track_id": self.track_id, "visible_to": self.visible_to,
            "round_number": self.round_number,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Message":
        role = data.get("role", "agent")
        # Normalize v3 roles (agent_a/agent_b → agent)
        if role in ("agent_a", "agent_b"):
            role = "agent"
        return cls(
            role=role,
            name=data.get("name", "Unknown"),
            content=data.get("content", ""),
            timestamp=data.get("timestamp", datetime.now().isoformat()),
            importance=data.get("importance", IMPORTANCE_NORMAL),
            track_id=data.get("track_id", "main"),
            visible_to=data.get("visible_to", []),
            round_number=data.get("round_number", 0),
        )


# ── Structured Summary ─────────────────────────────────────────────

@dataclass
class StructuredSummary:
    arc: str = ""
    key_events: list = field(default_factory=list)
    open_loops: list = field(default_factory=list)
    tension: float = 0.5
    location: str = ""
    time_progress: str = ""

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    def to_short_string(self) -> str:
        parts = [f"剧情线:{self.arc}"] if self.arc else []
        if self.open_loops:
            parts.append(f"线索:{','.join(self.open_loops[:2])}")
        if self.location:
            parts.append(f"地点:{self.location}")
        return " | ".join(parts) if parts else ""

    @classmethod
    def from_json(cls, json_str: str) -> "StructuredSummary":
        try:
            data = json.loads(json_str)
            return cls(**data)
        except (json.JSONDecodeError, TypeError):
            return cls()


# ── Compressed Chunk ───────────────────────────────────────────────

@dataclass
class CompressedChunk:
    chunk_id: str
    start_round: int
    end_round: int
    summary: str = ""
    key_events: list = field(default_factory=list)
    open_loops: list = field(default_factory=list)
    importance: float = 0.5

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "CompressedChunk":
        return cls(
            chunk_id=data.get("chunk_id", ""),
            start_round=data.get("start_round", 0),
            end_round=data.get("end_round", 0),
            summary=data.get("summary", ""),
            key_events=data.get("key_events", []),
            open_loops=data.get("open_loops", []),
            importance=data.get("importance", 0.5),
        )

    @property
    def context_string(self) -> str:
        parts = [f"[{self.start_round}-{self.end_round}轮] {self.summary}"]
        if self.key_events:
            parts.append(f"事件: {'、'.join(self.key_events[:3])}")
        if self.open_loops:
            parts.append(f"线索: {'、'.join(self.open_loops[:2])}")
        return " | ".join(parts)


# ── Session ────────────────────────────────────────────────────────

@dataclass
class NightAction:
    """A single night action in a werewolf game."""
    action_type: str  # kill / check / save / poison
    target: str
    source: str


@dataclass
class WerewolfGameState:
    """Complete state of a werewolf game."""
    role_assignments: Dict[str, str] = field(default_factory=dict)  # player_name -> role
    alive_players: List[str] = field(default_factory=list)
    phase: str = "night"  # night / discussion / voting / judgment / ended
    round_number: int = 1
    night_actions: List[NightAction] = field(default_factory=list)
    votes: Dict[str, str] = field(default_factory=dict)  # voter -> target
    eliminated: List[dict] = field(default_factory=list)  # [{name, reason, round}]
    winner: str = ""  # "wolf" or "villager"
    witch_has_antidote: bool = True
    witch_has_poison: bool = True
    hunter_can_shoot: bool = True
    last_night_victim: str = ""  # who was killed by wolves last night
    last_night_saved: str = ""  # who was saved by witch
    poisoned_by_witch: str = ""  # who was poisoned by witch
    seer_checked: str = ""  # who was checked by seer last night

    def to_dict(self) -> dict:
        return {
            "role_assignments": dict(self.role_assignments),
            "alive_players": list(self.alive_players),
            "phase": self.phase,
            "round_number": self.round_number,
            "night_actions": [{"action_type": a.action_type, "target": a.target, "source": a.source} for a in self.night_actions],
            "votes": dict(self.votes),
            "eliminated": list(self.eliminated),
            "winner": self.winner,
            "witch_has_antidote": self.witch_has_antidote,
            "witch_has_poison": self.witch_has_poison,
            "hunter_can_shoot": self.hunter_can_shoot,
            "last_night_victim": self.last_night_victim,
            "last_night_saved": self.last_night_saved,
            "poisoned_by_witch": self.poisoned_by_witch,
            "seer_checked": self.seer_checked,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "WerewolfGameState":
        na_data = data.get("night_actions", [])
        night_actions = [NightAction(**a) for a in na_data] if isinstance(na_data, list) else []
        return cls(
            role_assignments=data.get("role_assignments", {}),
            alive_players=data.get("alive_players", []),
            phase=data.get("phase", "night"),
            round_number=data.get("round_number", 1),
            night_actions=night_actions,
            votes=data.get("votes", {}),
            eliminated=data.get("eliminated", []),
            winner=data.get("winner", ""),
            witch_has_antidote=data.get("witch_has_antidote", True),
            witch_has_poison=data.get("witch_has_poison", True),
            hunter_can_shoot=data.get("hunter_can_shoot", True),
            last_night_victim=data.get("last_night_victim", ""),
            last_night_saved=data.get("last_night_saved", ""),
            poisoned_by_witch=data.get("poisoned_by_witch", ""),
            seer_checked=data.get("seer_checked", ""),
        )


@dataclass
class Session:
    session_id: str
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())
    messages: List[Message] = field(default_factory=list)
    summaries: List[str] = field(default_factory=list)
    structured_summaries: List[StructuredSummary] = field(default_factory=list)
    compressed_chunks: List[CompressedChunk] = field(default_factory=list)
    round_count: int = 0
    agent_names: List[str] = field(default_factory=list)
    config: dict = field(default_factory=dict)
    current_scene: str = ""
    current_tracks: List[dict] = field(default_factory=list)
    round_log: List[dict] = field(default_factory=list)
    version: str = "v4"

    def add_message(self, msg: Message, importance: int = None) -> None:
        if importance is not None:
            msg.importance = importance
        self.messages.append(msg)
        self.updated_at = datetime.now().isoformat()
        if msg.role in ("agent", "user"):
            self.round_count = max(self.round_count, msg.round_number)

    def add_round_log(self, round_data: dict) -> None:
        self.round_log.append(round_data)

    def get_messages_visible_to(self, agent_name: str) -> List[Message]:
        if not agent_name:
            return self.messages
        return [m for m in self.messages if not m.visible_to or agent_name in m.visible_to]

    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "session_id": self.session_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "round_count": self.round_count,
            "agent_names": self.agent_names,
            "config": self.config,
            "summaries": self.summaries,
            "structured_summaries": [s.to_json() for s in self.structured_summaries],
            "compressed_chunks": [c.to_dict() for c in self.compressed_chunks],
            "messages": [m.to_dict() for m in self.messages],
            "current_scene": self.current_scene,
            "current_tracks": self.current_tracks,
            "round_log": self.round_log,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Session":
        sess = cls(
            session_id=data["session_id"],
            created_at=data.get("created_at", ""),
            updated_at=data.get("updated_at", ""),
            round_count=data.get("round_count", 0),
            agent_names=data.get("agent_names", []),
            config=data.get("config", {}),
            summaries=data.get("summaries", []),
            current_scene=data.get("current_scene", ""),
            current_tracks=data.get("current_tracks", []),
            round_log=data.get("round_log", []),
            version=data.get("version", "v3"),
        )
        sess.messages = [Message.from_dict(m) for m in data.get("messages", [])]

        for s in data.get("structured_summaries", []):
            if isinstance(s, str):
                sess.structured_summaries.append(StructuredSummary.from_json(s))
            elif isinstance(s, dict):
                sess.structured_summaries.append(StructuredSummary(**s))

        for c in data.get("compressed_chunks", []):
            if isinstance(c, dict):
                sess.compressed_chunks.append(CompressedChunk.from_dict(c))

        return sess
