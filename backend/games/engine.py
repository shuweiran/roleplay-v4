from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from .schema import GameDefinition, RoleDef


class GameState:
    def __init__(self) -> None:
        self.players: dict[str, RoleDef | None] = {}
        self.phase_index: int = 0
        self.game_over: bool = False
        self.winner: str | None = None

    def assign_role(self, player_id: str, role: RoleDef) -> None:
        self.players[player_id] = role


class GameEngine(ABC):
    def __init__(self, definition: GameDefinition) -> None:
        self.definition = definition
        self.state = GameState()

    @abstractmethod
    def assign_roles(self, player_ids: list[str]) -> dict[str, RoleDef]:
        ...

    @abstractmethod
    def get_current_phase(self) -> str:
        ...

    @abstractmethod
    def execute_phase(self) -> dict[str, Any]:
        ...

    @abstractmethod
    def check_win(self) -> str | None:
        ...

    @property
    def current_phase_index(self) -> int:
        return self.state.phase_index
