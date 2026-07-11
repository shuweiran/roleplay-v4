"""
ScriptRuntime — phase-based state machine for scripted game modes.

Implements the "LLM provides reasoning, state machine provides control"
principle. Each script defines standard phases with trigger conditions.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional


class TransitionTrigger(str, Enum):
    """Conditions that trigger a phase transition."""
    MANUAL = "manual"
    ALL_ACTED = "all_acted"
    ROUNDS_EXHAUSTED = "rounds_exhausted"


class ScriptPhase(str, Enum):
    READING = "reading"
    SEARCH = "search"
    PRIVATE_CHAT = "private_chat"
    PUBLIC_CHAT = "public_chat"
    VOTING = "voting"
    REVEAL = "reveal"


@dataclass
class ScriptMeta:
    """Metadata for a single script phase."""
    phase: ScriptPhase
    description: str = ""
    mode: str = "isolated"
    members: List[str] = field(default_factory=list)
    label: str = ""
    ttl_rounds: int = 1
    metadata: Dict[str, Any] = field(default_factory=dict)
    trigger: TransitionTrigger = TransitionTrigger.MANUAL
    track_templates: List[Dict[str, Any]] = field(default_factory=list)
    allow_public_chat: bool = False
    allow_private_chat: bool = False
    allow_voting: bool = False
    reveal_all_context: bool = False


STANDARD_SCRIPT_PHASES: List[ScriptMeta] = [
    ScriptMeta(
        phase=ScriptPhase.READING,
        description="角色读本，了解各自身份与任务",
        mode="isolated",
        label="读本-隔离",
        ttl_rounds=1,
    ),
    ScriptMeta(
        phase=ScriptPhase.SEARCH,
        description="搜查证据，调查线索",
        mode="isolated",
        label="搜证-独立",
        ttl_rounds=2,
        trigger=TransitionTrigger.ALL_ACTED,
    ),
    ScriptMeta(
        phase=ScriptPhase.PRIVATE_CHAT,
        description="私聊阶段，角色两两私下交流",
        mode="merged",
        label="私聊",
        ttl_rounds=2,
        allow_private_chat=True,
    ),
    ScriptMeta(
        phase=ScriptPhase.PUBLIC_CHAT,
        description="公聊阶段，全体公开讨论线索",
        mode="merged",
        label="公聊",
        ttl_rounds=2,
        allow_public_chat=True,
    ),
    ScriptMeta(
        phase=ScriptPhase.VOTING,
        description="投票阶段，指认凶手",
        mode="isolated",
        label="投票",
        ttl_rounds=1,
        allow_voting=True,
        trigger=TransitionTrigger.ALL_ACTED,
    ),
    ScriptMeta(
        phase=ScriptPhase.REVEAL,
        description="复盘揭晓，公布真相",
        mode="merged",
        label="复盘",
        ttl_rounds=1,
        reveal_all_context=True,
        allow_public_chat=True,
    ),
]


class PhaseManager:
    """Manages phase transitions for script-based game modes."""

    def __init__(self, phases: Optional[List[ScriptMeta]] = None) -> None:
        self.phases: List[ScriptMeta] = phases or STANDARD_SCRIPT_PHASES
        self.current_index: int = 0
        self.round_count: int = 0
        self.acted_players: set = set()

    @property
    def current_phase(self) -> Optional[ScriptMeta]:
        if 0 <= self.current_index < len(self.phases):
            return self.phases[self.current_index]
        return None

    @property
    def is_last_phase(self) -> bool:
        return self.current_index >= len(self.phases) - 1

    @property
    def is_game_over(self) -> bool:
        return self.current_index >= len(self.phases)

    def mark_acted(self, player_id: str) -> None:
        self.acted_players.add(player_id)

    def advance(self) -> bool:
        """Advance to the next phase if conditions are met."""
        phase = self.current_phase
        if phase is None:
            return False

        if phase.trigger == TransitionTrigger.MANUAL:
            return False

        if phase.trigger == TransitionTrigger.ALL_ACTED:
            if len(self.acted_players) < max(len(phase.members), 1):
                return False

        if phase.trigger == TransitionTrigger.ROUNDS_EXHAUSTED:
            if self.round_count < phase.ttl_rounds:
                return False

        self.current_index += 1
        self.round_count = 0
        self.acted_players.clear()
        return True

    def force_advance(self) -> bool:
        """Forcefully advance to the next phase."""
        self.current_index += 1
        self.round_count = 0
        self.acted_players.clear()
        return not self.is_game_over

    def reset(self) -> None:
        self.current_index = 0
        self.round_count = 0
        self.acted_players.clear()

    def get_state(self) -> Dict[str, Any]:
        phase = self.current_phase
        return {
            "phase": phase.phase.value if phase else None,
            "phase_index": self.current_index,
            "total_phases": len(self.phases),
            "round_count": self.round_count,
            "acted_players": list(self.acted_players),
            "is_game_over": self.is_game_over,
        }
