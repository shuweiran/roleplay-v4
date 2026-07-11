"""
Memory management for the roleplay system (v4).

Three-tier memory:
1. Short-term: weighted window of recent conversation
2. Working memory: ongoing context
3. Long-term: periodic summary compression

v4.2 sharding: Public / Private / Faction / Temporary memory partitions.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from ..models.domain import (
    IMPORTANCE_LORE_TRIGGER,
    IMPORTANCE_NORMAL,
    IMPORTANCE_REPETITIVE,
    IMPORTANCE_USER_INTERRUPT,
    Message,
    Session,
    StructuredSummary,
)
from ..services.session_manager import SessionManager


# ── Memory shard types ───────────────────────────────────────

class MemoryShard:
    """A partition of memory accessible to a specific visibility group."""

    def __init__(self, name: str, visibility: str = "all"):
        self.name = name
        self.visibility = visibility  # "all" | "agent:<name>" | "faction:<name>" | "temp:<phase>"
        self.messages: List[Message] = []
        self.summaries: List[str] = []

    def add(self, msg: Message):
        self.messages.append(msg)

    def add_summary(self, text: str):
        self.summaries.append(text)

    def get_context(self, max_len: int = 20) -> str:
        recent = self.messages[-max_len:]
        parts = [f"[{m.name}] {m.content[:120]}" for m in recent]
        return "\n".join(parts)

    def clear(self):
        self.messages.clear()
        self.summaries.clear()


class ShardedMemory:
    """Manages memory shards for public/private/faction/temporary partitions."""

    def __init__(self):
        self._shards: Dict[str, MemoryShard] = {}
        self._ensure("public", "all")

    def _ensure(self, key: str, visibility: str = "all") -> MemoryShard:
        if key not in self._shards:
            self._shards[key] = MemoryShard(key, visibility)
        return self._shards[key]

    # ── Write ───────────────────────────────────────────────

    def add_public(self, msg: Message):
        self._ensure("public").add(msg)

    def add_private(self, agent_name: str, msg: Message):
        key = f"private:{agent_name}"
        self._ensure(key, f"agent:{agent_name}").add(msg)

    def add_faction(self, faction_name: str, msg: Message):
        key = f"faction:{faction_name}"
        self._ensure(key, f"faction:{faction_name}").add(msg)

    def add_temporary(self, phase_name: str, msg: Message):
        key = f"temp:{phase_name}"
        self._ensure(key, f"temp:{phase_name}").add(msg)

    # ── Read ─────────────────────────────────────────────────

    def get_for_agent(self, agent_name: str, faction: str = "", max_len: int = 20) -> str:
        """Build context string for an agent from all visible shards."""
        parts = []

        # Public shard
        pub = self._shards.get("public")
        if pub:
            ctx = pub.get_context(max_len)
            if ctx:
                parts.append(f"【公共记忆】\n{ctx}")

        # Private shard for this agent
        priv = self._shards.get(f"private:{agent_name}")
        if priv:
            ctx = priv.get_context(max_len)
            if ctx:
                parts.append(f"【{agent_name}的私有记忆】\n{ctx}")

        # Faction shard
        if faction:
            fac = self._shards.get(f"faction:{faction}")
            if fac:
                ctx = fac.get_context(max_len)
                if ctx:
                    parts.append(f"【阵营记忆 — {faction}】\n{ctx}")

        return "\n\n".join(parts) if parts else ""

    def get_public(self, max_len: int = 20) -> str:
        pub = self._shards.get("public")
        return pub.get_context(max_len) if pub else ""

    def get_private(self, agent_name: str, max_len: int = 20) -> str:
        priv = self._shards.get(f"private:{agent_name}")
        return priv.get_context(max_len) if priv else ""

    def get_faction(self, faction_name: str, max_len: int = 20) -> str:
        fac = self._shards.get(f"faction:{faction_name}")
        return fac.get_context(max_len) if fac else ""

    def get_temporary(self, phase_name: str, max_len: int = 20) -> str:
        temp = self._shards.get(f"temp:{phase_name}")
        return temp.get_context(max_len) if temp else ""

    # ── Lifecycle ────────────────────────────────────────────

    def clear_phase(self, phase_name: str):
        """Clear all temporary shards for a phase."""
        key = f"temp:{phase_name}"
        shard = self._shards.pop(key, None)
        if shard:
            shard.clear()

    def clear_private(self, agent_name: str):
        key = f"private:{agent_name}"
        shard = self._shards.pop(key, None)
        if shard:
            shard.clear()

    def clear_all_temporary(self):
        keys = [k for k in self._shards if k.startswith("temp:")]
        for k in keys:
            self._shards.pop(k).clear()

    def clear_all(self):
        self._shards.clear()
        self._ensure("public")


class MemoryStore:
    """Manages short-term, long-term memory and session persistence.

    v4.2: Added ShardedMemory for public/private/faction/temporary partitions.
    """

    def __init__(
        self,
        session_manager: SessionManager,
        short_term_rounds: int = 20,
    ):
        self._sm = session_manager
        self.short_term_rounds = short_term_rounds
        self.session: Optional[Session] = None
        self._compressor = None  # Set by Router
        self.shards: ShardedMemory = ShardedMemory()

    @property
    def compressor(self):
        return self._compressor

    @compressor.setter
    def compressor(self, value):
        self._compressor = value

    def create_session(self, session_id: str, agent_names: List[str], config: dict = None) -> Session:
        self.session = self._sm.create(session_id, agent_names, config)
        return self.session

    def add_message(self, msg: Message, importance: int = None) -> None:
        if self.session is None:
            raise RuntimeError("No active session. Call create_session first.")
        if importance is None:
            importance = IMPORTANCE_USER_INTERRUPT if msg.role == "user" else IMPORTANCE_NORMAL
        self.session.add_message(msg, importance=importance)
        # Auto-save on round boundaries
        self._sm.autosave(self.session)
        # Prune if over limit
        self._sm.prune(self.session)

    def save_session(self, filepath: str = None) -> str:
        if self.session is None:
            raise RuntimeError("No active session to save.")
        return self._sm.save(self.session)

    def load_session(self, filepath: str) -> Session:
        session_id = filepath.replace("\\", "/").split("/")[-1].replace(".json", "")
        session = self._sm.load(session_id)
        if session:
            self.session = session
            return session
        # Fallback: load from filepath directly
        import json
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.session = Session.from_dict(data)
        return self.session

    def load_session_data(self, session: Session) -> None:
        """Load a Session object directly (from session manager)."""
        self.session = session

    def get_latest_session_path(self) -> Optional[str]:
        return self._sm.get_latest()

    # ── Context building ──────────────────────────────────────────

    def get_agent_context(self, agent_name: str, max_messages: int = 30) -> List[Message]:
        """Return messages visible to an agent (track isolation filtering)."""
        if self.session is None:
            return []
        visible = self.session.get_messages_visible_to(agent_name)
        important = [m for m in visible if m.importance >= 8]
        normal = [m for m in visible if 5 <= m.importance < 8][-max_messages:]
        seen_ids = {id(m) for m in important}
        all_kept = list(important)
        for m in normal:
            if id(m) not in seen_ids:
                all_kept.append(m)
                seen_ids.add(id(m))
        result = sorted(all_kept, key=lambda m: visible.index(m))
        return result[-max_messages:]

    def get_compressed_context(self, max_chunks: int = 5, max_recent: int = 3) -> str:
        """Build context using compressor."""
        if self.session is None:
            return ""
        if not self._compressor:
            return self.get_summary_context()
        chunks = self.session.compressed_chunks
        recent = self.get_short_term_context(max_rounds=3)
        recent_dicts = [{"role": m.role, "name": m.name, "content": m.content} for m in recent]
        return self._compressor.get_compressed_context(
            chunks=chunks, recent_raw=recent_dicts,
            max_chunks=max_chunks, max_recent=max_recent,
        )

    def get_short_term_context(self, max_rounds: int = None) -> List[Message]:
        if self.session is None:
            return []
        max_r = max_rounds or self.short_term_rounds
        max_msgs = max_r * 2 + 4
        return self.session.messages[-max_msgs:] if self.session.messages else []

    def get_summary_context(self, use_structured: bool = True) -> str:
        if self.session is None:
            return ""
        if self.session.compressed_chunks:
            chunks = self.session.compressed_chunks[-5:]
            parts = [c.context_string for c in chunks]
            return "【剧情概况】\n" + "\n".join(parts)
        if use_structured and self.session.structured_summaries:
            short = self.session.structured_summaries[-1].to_short_string()
            return f"【剧情概况】{short}" if short else ""
        if not self.session.summaries:
            return ""
        parts = ["【之前的对话摘要】"]
        for i, s in enumerate(self.session.summaries, 1):
            parts.append(f"第{i}段: {s}")
        return "\n".join(parts)

    def set_current_tracks(self, tracks: list) -> None:
        if self.session is not None:
            self.session.current_tracks = tracks

    def get_current_tracks(self) -> list:
        return self.session.current_tracks if self.session else []

    def increment_round(self) -> int:
        if self.session is not None:
            self.session.round_count += 1
        return self.session.round_count if self.session else 0

    @staticmethod
    def is_low_information(msg: Message, prev_msg: Message = None) -> bool:
        if len(msg.content) < 30:
            return True
        if prev_msg and msg.content == prev_msg.content:
            return True
        if prev_msg and len(msg.content) < 50:
            w1 = set(msg.content[:50])
            w2 = set(prev_msg.content[:50])
            union = len(w1 | w2)
            if union > 0 and len(w1 & w2) / union > 0.8:
                return True
        return False
