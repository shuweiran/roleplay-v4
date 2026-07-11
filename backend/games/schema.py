from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, Field


class RoleTeam(str, Enum):
    WEREWOLF = "werewolf"
    VILLAGER = "villager"
    NEUTRAL = "neutral"


class PhaseType(str, Enum):
    NIGHT = "night"
    DAY_DISCUSSION = "day_discussion"
    DAY_VOTE = "day_vote"


class RoleDef(BaseModel):
    name: str
    team: RoleTeam
    description: str = ""
    max_count: int = 1
    night_action: str | None = None


class PhaseDef(BaseModel):
    name: str
    order: int
    phase_type: PhaseType
    description: str = ""


class WinCondition(BaseModel):
    team: RoleTeam
    description: str


class GameDefinition(BaseModel):
    name: str
    version: str = "1.0.0"
    description: str = ""
    player_range: tuple[int, int] = (6, 12)
    roles: list[RoleDef]
    phases: list[PhaseDef]
    win_conditions: list[WinCondition]
