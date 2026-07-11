"""
TrackManager — lifecycle management for TrackInstances.

Extends the existing Track model with:
- TTL (time-to-live) — tracks auto-expire after N rounds
- Group tracks — N-person merged tracks (avoiding N×N pairwise)
- Phase-based batch cleanup
- Isolation locks — per-agent deny-all cross-track linking
- Event emission on track create/close
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set


@dataclass
class TrackInstance:
    """A track with lifecycle metadata, extending the basic Track concept."""

    id: str
    mode: str  # merged / weak / isolated
    members: List[str] = field(default_factory=list)
    agent_actions: Dict[str, str] = field(default_factory=dict)  # active/silent/offline
    owner: str = ""                     # for private tracks, the initiator
    label: str = ""
    color: str = "#4CAF50"
    ttl_rounds: int = -1                # -1 = no expiry, >0 = expire after N rounds
    ttl_seconds: float = -1.0           # -1 = no expiry
    created_at: float = field(default_factory=time.monotonic)
    created_round: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)  # e.g. phase, room, faction
    messages: List[dict] = field(default_factory=list)       # local message buffer
    _closed: bool = False

    @property
    def active_agents(self) -> List[str]:
        return [n for n, a in self.agent_actions.items() if a == "active"]

    @property
    def silent_agents(self) -> List[str]:
        return [n for n, a in self.agent_actions.items() if a == "silent"]

    def is_expired(self, current_round: int = 0) -> bool:
        if self._closed:
            return True
        if self.ttl_rounds > 0 and current_round - self.created_round >= self.ttl_rounds:
            return True
        if self.ttl_seconds > 0 and time.monotonic() - self.created_at >= self.ttl_seconds:
            return True
        return False

    @property
    def is_group(self) -> bool:
        return len(self.members) > 2 and self.mode == "merged"

    def close(self):
        self._closed = True

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "mode": self.mode,
            "members": self.members,
            "agent_actions": self.agent_actions,
            "owner": self.owner,
            "label": self.label,
            "color": self.color,
            "ttl_rounds": self.ttl_rounds,
            "created_round": self.created_round,
            "is_group": self.is_group,
            "expired": self._closed,
            "metadata": self.metadata,
        }

    @staticmethod
    def from_track(track, owner: str = "", ttl_rounds: int = -1, metadata: dict = None) -> "TrackInstance":
        """Convert existing Track object to TrackInstance."""
        return TrackInstance(
            id=track.id,
            mode=track.mode if hasattr(track, "mode") else "merged",
            members=list(track.agents) if hasattr(track, "agents") else [],
            agent_actions=dict(track.agent_actions) if hasattr(track, "agent_actions") else {},
            owner=owner,
            label=track.label if hasattr(track, "label") else "",
            color=track.color if hasattr(track, "color") else "#4CAF50",
            ttl_rounds=ttl_rounds,
            metadata=metadata or {},
        )


class TrackManager:
    """Manages the lifecycle of TrackInstance objects.

    Tracks are created per phase, can auto-expire, and are batch-cleaned
    on phase transitions. Group tracks support N-party communication.
    """

    def __init__(self, emit_callback: Optional[Callable] = None):
        self._tracks: Dict[str, TrackInstance] = {}
        self._closed_ids: Set[str] = set()
        self._agent_isolation_locks: Set[str] = set()  # agents who deny all cross-track links
        self._emit = emit_callback or (lambda *a, **kw: None)
        self._auto_cleanup_enabled: bool = True

    # ── Track CRUD ──────────────────────────────────────────

    def create(
        self, mode: str, members: List[str], *,
        owner: str = "", label: str = "", track_id: str = "",
        ttl_rounds: int = -1, ttl_seconds: float = -1,
        agent_actions: Dict[str, str] = None, metadata: dict = None,
        current_round: int = 0,
    ) -> TrackInstance:
        """Create a new TrackInstance."""
        tid = track_id or f"track_{len(self._tracks)}_{int(time.monotonic() * 1000)}"
        if agent_actions is None:
            agent_actions = {n: "active" for n in members}
        else:
            for n in members:
                if n not in agent_actions:
                    agent_actions[n] = "active"

        inst = TrackInstance(
            id=tid, mode=mode, members=members,
            agent_actions=agent_actions, owner=owner,
            label=label or f"轨道{len(self._tracks)+1}",
            ttl_rounds=ttl_rounds, ttl_seconds=ttl_seconds,
            created_round=current_round,
            metadata=metadata or {},
        )
        self._tracks[tid] = inst
        self._emit("track_created", inst.to_dict())
        return inst

    def create_group(
        self, members: List[str], *,
        owner: str = "", label: str = "",
        ttl_rounds: int = -1, current_round: int = 0,
    ) -> TrackInstance:
        """Create a group merged track for N parties (avoids N×N pairwise)."""
        return self.create(
            mode="merged", members=members, owner=owner,
            label=label or f"群组-{len(members)}人",
            ttl_rounds=ttl_rounds, current_round=current_round,
            metadata={"type": "group"},
        )

    def create_private(
        self, agent_a: str, agent_b: str, *,
        owner: str = "", ttl_rounds: int = 3, current_round: int = 0,
    ) -> Optional[TrackInstance]:
        """Create a private 1-on-1 track (if neither party has isolation lock)."""
        if agent_a in self._agent_isolation_locks or agent_b in self._agent_isolation_locks:
            return None
        return self.create(
            mode="merged", members=[agent_a, agent_b], owner=owner,
            label=f"{agent_a}↔{agent_b}", ttl_rounds=ttl_rounds,
            current_round=current_round, metadata={"type": "private"},
        )

    def get(self, track_id: str) -> Optional[TrackInstance]:
        return self._tracks.get(track_id)

    def close(self, track_id: str) -> bool:
        """Close a track immediately."""
        inst = self._tracks.pop(track_id, None)
        if inst:
            inst.close()
            self._closed_ids.add(track_id)
            self._emit("track_closed", inst.to_dict())
            return True
        return False

    def list_active(self, current_round: int = 0) -> List[TrackInstance]:
        """Return all non-expired tracks."""
        if self._auto_cleanup_enabled:
            self.cleanup_expired(current_round)
        return [t for t in self._tracks.values() if not t._closed]

    def list_by_phase(self, phase_name: str) -> List[TrackInstance]:
        """Return tracks belonging to a specific phase."""
        return [t for t in self._tracks.values()
                if not t._closed and t.metadata.get("phase") == phase_name]

    def list_by_agent(self, agent_name: str) -> List[TrackInstance]:
        """Return tracks containing the given agent."""
        return [t for t in self._tracks.values()
                if not t._closed and agent_name in t.members]

    # ── Lifecycle ───────────────────────────────────────────

    def cleanup_expired(self, current_round: int = 0) -> List[str]:
        """Remove all expired tracks. Returns list of closed track IDs."""
        expired = []
        for tid, inst in list(self._tracks.items()):
            if inst.is_expired(current_round):
                inst.close()
                self._closed_ids.add(tid)
                self._emit("track_closed", inst.to_dict())
                expired.append(tid)
        for tid in expired:
            self._tracks.pop(tid, None)
        return expired

    def cleanup_phase(self, phase_name: str, current_round: int = 0) -> int:
        """Close all tracks belonging to a specific phase. Returns count closed."""
        count = 0
        for tid, inst in list(self._tracks.items()):
            if inst.metadata.get("phase") == phase_name and not inst._closed:
                self.close(tid)
                count += 1
        self.cleanup_expired(current_round)
        return count

    def cleanup_all(self) -> int:
        """Close all tracks. Returns count closed."""
        count = 0
        for tid in list(self._tracks.keys()):
            if self.close(tid):
                count += 1
        return count

    # ── Isolation locks ─────────────────────────────────────

    def set_isolation(self, agent_name: str, locked: bool = True):
        """Set or clear isolation lock for an agent."""
        if locked:
            self._agent_isolation_locks.add(agent_name)
        else:
            self._agent_isolation_locks.discard(agent_name)

    def is_isolated(self, agent_name: str) -> bool:
        return agent_name in self._agent_isolation_locks

    # ── Stats ────────────────────────────────────────────────

    @property
    def active_count(self) -> int:
        return len([t for t in self._tracks.values() if not t._closed])

    @property
    def group_count(self) -> int:
        return len([t for t in self._tracks.values() if t.is_group and not t._closed])

    def stats(self) -> dict:
        return {
            "active_tracks": self.active_count,
            "group_tracks": self.group_count,
            "total_created": len(self._tracks) + len(self._closed_ids),
            "total_closed": len(self._closed_ids),
            "isolated_agents": list(self._agent_isolation_locks),
        }
