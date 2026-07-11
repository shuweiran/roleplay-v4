"""
WerewolfEngine — concrete GameEngine implementation for werewolf game.
"""
from __future__ import annotations

import random
from typing import Any

from backend.games.engine import GameEngine, GameState
from backend.games.schema import GameDefinition, RoleDef, RoleTeam, PhaseType


class WerewolfState(GameState):
    """Extended game state for werewolf-specific data."""
    def __init__(self) -> None:
        super().__init__()
        self.phase_name: str = "night"
        self.round: int = 1
        self.alive_players: set[str] = set()
        self.role_map: dict[str, str] = {}  # player_name -> role_name
        self.night_kill_target: str | None = None
        self.seer_checked: str | None = None
        self.witch_saved: bool = False
        self.witch_has_antidote: bool = True
        self.witch_has_poison: bool = True
        self.witch_poison_target: str | None = None
        self.day_kill_target: str | None = None
        self.votes: dict[str, list[str]] = {}  # target -> [voters]
        self.hunter_triggered: bool = False
        self.last_night_kill: str | None = None
        self.hunter_revenge_target: str | None = None


class WerewolfEngine(GameEngine):
    """Werewolf game engine."""

    def __init__(self, definition: GameDefinition) -> None:
        super().__init__(definition)
        self.state = WerewolfState()

    def assign_roles(self, player_ids: list[str]) -> dict[str, RoleDef]:
        """Assign roles to players based on count."""
        roles = self.definition.roles
        random.shuffle(player_ids)
        assignments: dict[str, RoleDef] = {}
        idx = 0
        for role_def in roles:
            count = min(role_def.max_count, max(1, len(player_ids) // len(roles)))
            for _ in range(count):
                if idx < len(player_ids):
                    player = player_ids[idx]
                    assignments[player] = role_def
                    self.state.role_map[player] = role_def.name
                    self.state.alive_players.add(player)
                    self.state.players[player] = role_def
                    idx += 1
        # Assign any remaining players as villagers
        for player in player_ids[idx:]:
            villager = next(r for r in roles if r.name == "villager")
            assignments[player] = villager
            self.state.role_map[player] = "villager"
            self.state.alive_players.add(player)
            self.state.players[player] = villager
        return assignments

    def get_current_phase(self) -> str:
        return self.state.phase_name

    def execute_phase(self) -> dict[str, Any]:
        """Execute current phase logic. Returns phase result."""
        phase = self.state.phase_name
        if phase == "night":
            return self._process_night()
        elif phase == "day_discussion":
            return self._process_day_discussion()
        elif phase == "day_vote":
            return self._process_vote()
        return {"phase": phase, "status": "unknown"}

    def check_win(self) -> str | None:
        """Check win conditions. Returns team name if someone wins."""
        alive_roles = [self.state.role_map.get(p, "") for p in self.state.alive_players]
        wolf_count = sum(1 for r in alive_roles if r == "wolf")
        non_wolf_count = len(self.state.alive_players) - wolf_count

        if wolf_count == 0:
            return "villager"
        if wolf_count >= non_wolf_count:
            return "werewolf"
        return None

    def process_night_action(self, player: str, action_type: str, target: str | None = None) -> dict[str, Any]:
        """Process a single night action."""
        role = self.state.role_map.get(player)
        result = {"player": player, "action": action_type, "target": target, "success": False}

        if role == "wolf" and action_type == "kill":
            self.state.night_kill_target = target
            self.state.last_night_kill = target
            result["success"] = True

        elif role == "seer" and action_type == "investigate":
            self.state.seer_checked = target
            target_role = self.state.role_map.get(target, "unknown")
            result["success"] = True
            result["discovery"] = target_role

        elif role == "witch" and action_type == "save":
            if self.state.witch_has_antidote and self.state.night_kill_target:
                self.state.witch_saved = True
                self.state.witch_has_antidote = False
                result["success"] = True

        elif role == "witch" and action_type == "poison" and target:
            if self.state.witch_has_poison:
                self.state.witch_poison_target = target
                self.state.witch_has_poison = False
                result["success"] = True

        return result

    def process_vote(self, votes: dict[str, str]) -> dict[str, Any]:
        """Process voting results. votes = {voter: target}"""
        tally: dict[str, list[str]] = {}
        for voter, target in votes.items():
            if voter in self.state.alive_players:
                tally.setdefault(target, []).append(voter)

        self.state.votes = tally
        # Find highest votes
        max_votes = 0
        most_voted: list[str] = []
        for target, voters in tally.items():
            if target in self.state.alive_players:
                count = len(voters)
                if count > max_votes:
                    max_votes = count
                    most_voted = [target]
                elif count == max_votes:
                    most_voted.append(target)

        if len(most_voted) == 1:
            eliminated = most_voted[0]
            self.state.day_kill_target = eliminated
            return {"eliminated": eliminated, "votes": {k: len(v) for k, v in tally.items()}, "tie": False}
        else:
            return {"eliminated": None, "votes": {k: len(v) for k, v in tally.items()}, "tie": True, "runoff": most_voted}

    def eliminate_player(self, player_name: str) -> dict[str, Any]:
        """Remove a player from the game."""
        if player_name in self.state.alive_players:
            self.state.alive_players.remove(player_name)
            role = self.state.role_map.get(player_name, "")
            result = {"eliminated": player_name, "role": role, "hunter_trigger": role == "hunter"}
            if role == "hunter":
                self.state.hunter_triggered = True
            return result
        return {"eliminated": player_name, "role": None, "hunter_trigger": False}

    def advance_phase(self) -> str:
        """Advance to the next phase. Uses Router-compatible phase names."""
        current = self.state.phase_name
        if current == "night":
            self.state.phase_name = "discussion"
        elif current == "discussion":
            self.state.phase_name = "voting"
        elif current == "voting":
            self.state.phase_name = "night"
            self.state.round += 1
        # Reset phase-specific state after night actions are processed
        if current != "night":
            self.state.night_kill_target = None
            self.state.seer_checked = None
            self.state.witch_saved = False
        self.state.day_kill_target = None
        self.state.votes = {}
        return self.state.phase_name

    # Internal helpers
    def _process_night(self) -> dict[str, Any]:
        return {
            "phase": "night",
            "round": self.state.round,
            "alive": list(self.state.alive_players),
            "expected_actions": [
                p for p in self.state.alive_players
                if self.state.players.get(p) and self.state.players[p].night_action
            ]
        }

    def _process_day_discussion(self) -> dict[str, Any]:
        return {
            "phase": "day_discussion",
            "round": self.state.round,
            "alive": list(self.state.alive_players),
            "last_night": self.state.last_night_kill,
        }

    def _process_vote(self) -> dict[str, Any]:
        return {
            "phase": "day_vote",
            "round": self.state.round,
            "alive": list(self.state.alive_players),
        }
