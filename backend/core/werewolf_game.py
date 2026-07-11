"""
Werewolf game logic - extracted from Router for stability.
Contains all werewolf-specific methods used as a mixin by Router.
"""

from __future__ import annotations

import asyncio
import random
import re
import time
import traceback
from datetime import datetime
from typing import AsyncGenerator, Dict, List, Optional

from ..core.persona import Persona
from ..core.agent import Agent
from ..models.domain import Message, NightAction, WerewolfGameState, Track, TrackConfig, IMPORTANCE_NORMAL
from ..games.werewolf_engine import WerewolfEngine
from ..games.schema import RoleDef
from ..games import registry


class WerewolfGameMixin:
    """All werewolf game logic methods. Used as a mixin by Router."""

    def _assign_roles_with_config(self, player_names: list, role_config: dict) -> dict:
        """Assign roles based on user-specified role counts. Works with any role name."""
        import random
        rng = random.SystemRandom()
        rng.shuffle(player_names)
        role_list = []
        for role_key, count in role_config.items():
            for _ in range(count):
                role_list.append(role_key)
        while len(role_list) < len(player_names):
            role_list.append("villager")  # Pad with villagers
        rng.shuffle(role_list)
        assignments = {}
        team = "werewolf" if any("wolf" in r for r in role_config) else "villager"
        for i, name in enumerate(player_names):
            if i < len(role_list):
                r = role_list[i]
                assignments[name] = RoleDef(name=r, team="werewolf" if "wolf" in r else "villager",
                                             description=r, max_count=5)
        return assignments

    def _init_werewolf_game(self, characters: List[Persona], human_player_names: List[str] = None,
                            role_config: dict = None) -> None:
        """Initialize werewolf game state and assign roles.
        human_player_names: names of human-controlled players (not LLM agents).
        role_config: optional dict like {"wolf":2, "villager":3, "seer":1} to override default assignment."""
        self._werewolf_human_players = set(human_player_names or [])
        self._werewolf_discussion_human_spoken = False
        self._werewolf_waiting_for_human = False

        # Ensure human players have Persona objects in the characters list
        from ..core.persona import Persona
        existing_names = {p.name for p in characters}
        for hp in self._werewolf_human_players:
            if hp not in existing_names:
                if hp in self._saved_characters:
                    p = self._saved_characters[hp]
                else:
                    p = Persona(name=hp, persona="真人玩家")
                    self.save_character(p)
                characters.append(p)
                existing_names.add(hp)

        total_players = len(characters)
        # Ensure at least 5 players total
        if total_players < 5:
            print(f"[Werewolf] Warning: only {total_players} players, need at least 5")
            # Auto-fill with default characters from store
            fallback_names = ["苏哲", "林诗", "老王", "小美", "阿强"]
            for name in fallback_names:
                if name not in existing_names and len(characters) < 5:
                    if name in self._saved_characters:
                        p = self._saved_characters[name]
                    else:
                        p = Persona(name=name, persona="普通村民")
                        self.save_character(p)
                    characters.append(p)
                    existing_names.add(name)
                    print(f"[Werewolf] Auto-added player: {name}")

        # Create Agent objects for AI-controlled players only (skip human players)
        for p in characters:
            if p.name in self._werewolf_human_players:
                # Human player: ensure NOT in self.agents (no LLM generation)
                self.agents.pop(p.name, None)
                print(f"[Werewolf] Human player registered: {p.name}")
            elif p.name not in self.agents:
                agent = Agent(
                    p, p.name,
                    llm_client=self._llm,
                    llm_config=self.config.llm,
                    monitor=self.monitor,
                )
                self.agents[p.name] = agent
                print(f"[Werewolf] AI agent created: {p.name}")

        # Initialize game engine
        registry.scan()
        ww_def = registry.get("Werewolf")
        self._ww_engine = WerewolfEngine(ww_def)
        player_names = [p.name for p in characters]
        if role_config:
            role_assignments = self._assign_roles_with_config(player_names, role_config)
            # Sync custom assignments back to engine state (used by check_win etc)
            for name, role_def in role_assignments.items():
                self._ww_engine.state.role_map[name] = role_def.name
            self._ww_engine.state.alive_players = list(role_assignments.keys())
        else:
            role_assignments = self._ww_engine.assign_roles(player_names)
        if not role_assignments:
            print("[Werewolf] Failed to assign roles")
            return

        assignments = {name: role.name for name, role in role_assignments.items()}
        alive = list(assignments.keys())
        # Sync engine phase with Router state
        self._ww_engine.state.phase_name = "night"
        self._ww_engine.state.round = 1
        self._werewolf_state = WerewolfGameState(
            role_assignments=assignments,
            alive_players=alive,
            phase="night",
            round_number=1,
        )
        self._werewolf_role_hints = {}

        wolves = [n for n, r in assignments.items() if r == "wolf"]

        # Send role assignment messages to each agent
        for name, role in assignments.items():
            role_name_cn = {
                "wolf": "狼人", "seer": "预言家", "witch": "女巫",
                "hunter": "猎人", "villager": "平民",
            }.get(role, role)

            hint = f"你的身份是：{role_name_cn}。"

            if role == "wolf":
                other_wolves = [n for n in wolves if n != name]
                if other_wolves:
                    hint += f" 你的狼人同伴是：{'、'.join(other_wolves)}。你们可以在夜间互相认识并商量杀谁。"
                else:
                    hint += " 你是唯一的狼人。"
                hint += " 你的目标是杀死所有非狼人玩家。在夜间请选择目标，格式：【暗杀X】其中X为目标角色名。"
                hint += " 白天请伪装成村民，不要暴露身份。"
            elif role == "seer":
                hint += " 你每晚可以查验一个玩家的真实身份。格式：【查验X】其中X为目标角色名。"
            elif role == "witch":
                hint += " 你有一瓶解药和一瓶毒药。每局只能使用一次。"
                hint += " 当有人被杀时，你可以救他（格式：【救X】）或者在夜间毒杀某人（格式：【毒X】）。"
            elif role == "hunter":
                hint += " 当你被投票出局或被杀时，你可以开枪带走一人。格式：【开枪X】其中X为目标角色名。"
            else:
                hint += " 你没有特殊能力，白天参与讨论和投票即可。"

            hint += "\n请熟记你的身份，在游戏中依此行动。"

            self._werewolf_role_hints[name] = hint

            role_msg = Message(
                role="system", name="系统",
                content=f"【狼人杀角色分配】\n{role_name_cn}身份已分配给你。\n{hint}",
                track_id="main", visible_to=[name],
                importance=IMPORTANCE_NORMAL,
            )
            self.memory.add_message(role_msg)

        # Public game start message — make a COPY of alive list to prevent mutation later
        start_msg = Message(
            role="system", name="系统",
            content=f"【狼人杀游戏开始！】\n"
                    f"玩家：{'、'.join(alive)}\n"
                    f"人数：{len(alive)}人\n"
                    f"身份配置已分配完毕，请查看你的私信确认身份。\n"
                    f"天黑请闭眼……\n\n"
                    f"即将进入第1夜，请狼人选择目标，预言家查验身份，女巫准备行动。",
            track_id="main", visible_to=list(alive),
            importance=IMPORTANCE_NORMAL,
        )
        self.memory.add_message(start_msg)
        print(f"[Werewolf] Game initialized with {len(alive)} players")
        print(f"[Werewolf] Roles: {assignments}")

    async def _emit_werewolf_state(self) -> None:
        """Emit werewolf state events for frontend UI panel."""
        import traceback
        try:
            print("[DEBUG _emit_werewolf_state] Starting...")
            state = self._werewolf_state
            if not state:
                print("[DEBUG _emit_werewolf_state] No state, returning")
                return
            print(f"[DEBUG _emit_werewolf_state] phase={state.phase}, round={state.round_number}, alive={list(state.alive_players)}")
            # Phase + round
            await self._emit("werewolf_phase", {
                "phase": state.phase,
                "round": state.round_number,
            })
            print("[DEBUG _emit_werewolf_state] Phase event sent")
            # Player list
            assignments = state.role_assignments
            alive = list(state.alive_players)
            eliminated = [e for e in state.eliminated]
            players = []
            for name in list(assignments.keys()):
                is_alive = name in alive
                eliminated_entry = next((e for e in eliminated if e.get("name") == name), None)
                role_revealed = eliminated_entry is not None
                role_name_cn = {
                    "wolf": "狼人", "seer": "预言家", "witch": "女巫",
                    "hunter": "猎人", "villager": "平民",
                }.get(assignments.get(name, ""), assignments.get(name, ""))
                players.append({
                    "name": name,
                    "role": role_name_cn,
                    "alive": is_alive,
                    "roleRevealed": role_revealed,
                })
            print(f"[DEBUG _emit_werewolf_state] Emitting {len(players)} players: {[p['name'] for p in players]}")
            await self._emit("werewolf_player_update", {"players": players})
            print("[DEBUG _emit_werewolf_state] Players event sent")
            # Human player's role
            for hp in self._werewolf_human_players:
                role_name_cn = {
                    "wolf": "狼人", "seer": "预言家", "witch": "女巫",
                    "hunter": "猎人", "villager": "平民",
                }.get(assignments.get(hp, ""), assignments.get(hp, ""))
                if hp in self._werewolf_human_players:
                    print(f"[DEBUG _emit_werewolf_state] Emitting my_role for {hp}: {role_name_cn}")
                    await self._emit("werewolf_my_role", {"role": role_name_cn})
        except Exception as e:
            print(f"[DEBUG _emit_werewolf_state] ERROR: {e}")
            traceback.print_exc()

    async def _configure_werewolf_tracks(self) -> TrackConfig:
        """Configure tracks for werewolf game based on current phase."""
        state = self._werewolf_state
        if not state:
            return TrackConfig(tracks=[], round=self.current_round, description="")


        alive = state.alive_players
        roles = state.role_assignments
        phase = state.phase

        if phase == "night":
            tracks = []
            # Track 1: Wolves discuss (merged, only wolves visible)
            wolves = [n for n in alive if roles.get(n) == "wolf"]
            if wolves:
                wolf_actions = {}
                for n in wolves:
                    if n in self._werewolf_human_players:
                        wolf_actions[n] = "silent"  # human acts via API
                    else:
                        wolf_actions[n] = "active"
                track_wolves = Track(
                    id="wolf_night", agents=wolves,
                    agent_actions=wolf_actions,
                    mode="merged", color="#E53935", label="狼人讨论",
                )
                tracks.append(track_wolves)

            # Track 2: Seer isolated
            seers = [n for n in alive if roles.get(n) == "seer"]
            for s in seers:
                seer_action = "silent" if s in self._werewolf_human_players else "active"
                track_seer = Track(
                    id=f"seer_{s}", agents=[s],
                    agent_actions={s: seer_action},
                    mode="isolated", color="#1E88E5", label=f"{s}(预言家)",
                )
                tracks.append(track_seer)

            # Track 3: Witch isolated
            witches = [n for n in alive if roles.get(n) == "witch"]
            for w in witches:
                witch_action = "silent" if w in self._werewolf_human_players else "active"
                track_witch = Track(
                    id=f"witch_{w}", agents=[w],
                    agent_actions={w: witch_action},
                    mode="isolated", color="#8E24AA", label=f"{w}(女巫)",
                )
                tracks.append(track_witch)

            # All other alive players are silent/offline
            others = [n for n in alive if roles.get(n) not in ("wolf", "seer", "witch")]
            if others:
                track_others = Track(
                    id="night_others", agents=others,
                    agent_actions={n: "offline" for n in others},
                    mode="weak", color="#757575", label="休息",
                )
                tracks.append(track_others)

            return TrackConfig(tracks=tracks, round=self.current_round,
                               description=f"第{state.round_number}夜 — 狼人行动、预言家查验、女巫行动")

        elif phase == "discussion":
            # All alive players merged — human players are silent (they speak via API)
            dc = self.config.mode.director_character
            # Ensure human players are represented in the alive list
            all_alive = list(alive)
            for hp in self._werewolf_human_players:
                if hp not in all_alive and hp in state.role_assignments:
                    all_alive.append(hp)
            all_alive = [n for n in all_alive if n != dc]
            agent_actions = {}
            for n in all_alive:
                if n in self._werewolf_human_players:
                    agent_actions[n] = "silent"
                else:
                    agent_actions[n] = "active"
            if dc and dc in alive:
                agent_actions[dc] = "silent"

            track = Track(
                id="day_discussion", agents=list(alive),
                agent_actions=agent_actions,
                mode="merged", color="#FFB300", label=f"第{state.round_number}天讨论",
            )
            return TrackConfig(tracks=[track], round=self.current_round,
                               description=f"第{state.round_number}天 — 白天讨论阶段")

        elif phase == "voting":
            # All alive players merged, voting — human players are silent (they vote via API)
            dc = self.config.mode.director_character
            # Ensure human players are represented in the alive list
            all_alive = list(alive)
            for hp in self._werewolf_human_players:
                if hp not in all_alive and hp in state.role_assignments:
                    all_alive.append(hp)
            all_alive = [n for n in all_alive if n != dc]
            agent_actions = {}
            for n in all_alive:
                if n in self._werewolf_human_players:
                    agent_actions[n] = "silent"
                else:
                    agent_actions[n] = "active"
            if dc and dc in alive:
                agent_actions[dc] = "silent"

            track = Track(
                id="day_vote", agents=list(alive),
                agent_actions=agent_actions,
                mode="merged", color="#F4511E", label=f"第{state.round_number}天投票",
            )
            return TrackConfig(tracks=[track], round=self.current_round,
                               description=f"第{state.round_number}天 — 投票阶段")

        elif phase == "judgment":
            # Hunter final words / revenge
            hunters = [n for n in alive if roles.get(n) == "hunter" and n in state.eliminated[-1:][0].get("name", "")]
            # Actually, if the most recently eliminated is the hunter, give them a chance
            eliminated_name = state.eliminated[-1]["name"] if state.eliminated else ""

            if eliminated_name and roles.get(eliminated_name) == "hunter" and state.hunter_can_shoot:
                track = Track(
                    id="hunter_shot", agents=[eliminated_name],
                    agent_actions={eliminated_name: "active"},
                    mode="isolated", color="#E91E63", label=f"{eliminated_name}(猎人遗言)",
                )
                return TrackConfig(tracks=[track], round=self.current_round,
                                   description=f"猎人{eliminated_name}可以开枪带走一人")
            else:
                # No hunter to shoot, skip to next night or end
                pass

            return TrackConfig(tracks=[], round=self.current_round,
                               description="审判阶段")

        elif phase == "ended":
            return TrackConfig(tracks=[], round=self.current_round,
                               description=f"游戏结束，{state.winner}方胜利")

        # Fallback
        return TrackConfig(tracks=[], round=self.current_round, description="")

    def _find_werewolf_target(self, content: str, patterns: list, alive: list) -> str:
        """Helper: find the first valid target in content matching any of the patterns."""
        import re
        for p in patterns:
            m = re.search(p, content)
            if m:
                candidate = m.group(1).strip()
                # The candidate might be a player name (ASCII or Chinese), check exact match
                if candidate in alive:
                    return candidate
                # Also try to match if candidate starts with a valid name (e.g., "lover!")
                for player in alive:
                    if candidate.startswith(player):
                        return player
        return ""

    def _find_werewolf_smart(self, content: str, patterns: list, alive: list) -> str:
        """Smart target finder: matches patterns, then validates against alive players.
        Also handles edge cases like names followed by punctuation."""
        import re
        for p in patterns:
            m = re.search(p, content)
            if m:
                candidate = m.group(1).strip().rstrip('，。！!？?、.,;:）)》"\'）')
                if candidate in alive:
                    return candidate
                for player in alive:
                    if candidate.startswith(player) or player.startswith(candidate):
                        return player
        return ""

    def _find_first_alive_name_after(self, content: str, keywords: list, alive: list) -> str:
        """Find the first alive player name that appears after any keyword in the content."""
        import re
        # Build a pattern: keyword followed by any text, then a player name
        for kw in keywords:
            for player in sorted(alive, key=len, reverse=True):  # Longest first to avoid partial matches
                # Check if keyword appears near the player name
                pattern = re.escape(kw) + r'.{0,20}' + re.escape(player)
                if re.search(pattern, content):
                    return player
        # Last resort: just find any alive player name in the content
        for player in sorted(alive, key=len, reverse=True):
            if player in content:
                return player
        return ""

    async def _process_werewolf_night(self, all_outputs: List[dict]) -> str:
        """Process night actions: parse agent outputs and determine night results.
        Returns ONLY the public narration (who died). Private messages saved separately."""
        state = self._werewolf_state
        if not state:
            return ""

        roles = state.role_assignments
        alive = state.alive_players

        # Parse outputs for actions
        wolf_kill_target = ""
        seer_check_target = ""
        witch_antidote_target = ""
        witch_poison_target = ""

        # First, check pre-submitted human night actions (via API)
        for na in list(state.night_actions):
            if na.action_type == "kill" and na.target in alive:
                wolf_kill_target = na.target
            elif na.action_type == "check" and na.target in alive:
                seer_check_target = na.target
            elif na.action_type == "save" and na.target in alive:
                witch_antidote_target = na.target
            elif na.action_type == "poison" and na.target in alive:
                witch_poison_target = na.target

        # Then parse LLM agent outputs for non-human players
        for output in all_outputs:
            name = output["agent_name"]
            content = output["content"]
            role = roles.get(name, "")

            if role == "wolf" and name in alive:
                # Wolf kill: find any alive player name mentioned near kill keywords
                patterns = [
                    r'(?:杀|刀|干掉|暗杀|击杀|咬|吃了|解决|动手|目标)[：:\s，、]*(\S{1,10})',
                ]
                wolf_kill_target = self._find_werewolf_smart(content, patterns, alive)
                if not wolf_kill_target:
                    # Fallback: just check if any alive player name appears with kill intent
                    wolf_kill_target = self._find_first_alive_name_after(content, ['杀', '刀', '目标', '干掉', '暗杀', '咬'], alive)

            elif role == "seer" and name in alive:
                patterns = [
                    r'(?:查|验|查验|验证|查看|调查|窥视)[：:\s，、]*(\S{1,10})',
                ]
                seer_check_target = self._find_werewolf_smart(content, patterns, alive)
                if not seer_check_target:
                    seer_check_target = self._find_first_alive_name_after(content, ['查', '验', '查验'], alive)

            elif role == "witch" and name in alive:
                # Witch save patterns
                if state.witch_has_antidote:
                    patterns = [
                        r'(?:救|救活|使用解药|解药)[：:\s，、]*(\S{1,10})',
                    ]
                    witch_antidote_target = self._find_werewolf_smart(content, patterns, alive)
                    # No fallback: witch must explicitly state intent to save

                # Witch poison patterns (require explicit intent, not just "毒")
                if state.witch_has_poison:
                    patterns = [
                        r'(?:我要毒|我想毒|毒杀|毒死|使用毒药|下毒)[：:\s，、]*(\S{1,10})',
                    ]
                    witch_poison_target = self._find_werewolf_smart(content, patterns, alive)
                    # No fallback: witch must explicitly state intent to poison

        # Determine night results — all internal processing is PRIVATE
        night_dead = set()
        private_messages = []  # (content, visible_to) pairs to be saved

        # Save human-submitted actions before clearing (API-submitted, source=player_name)
        human_actions = [
            a for a in state.night_actions
            if a.source in self._werewolf_human_players
        ]

        # Apply human actions directly (they are explicit, override agent parsing)
        for ha in human_actions:
            human_role = roles.get(ha.source, "")
            if human_role == "wolf":
                wolf_kill_target = ha.target
            elif human_role == "seer":
                seer_check_target = ha.target
            elif human_role == "witch":
                if ha.action_type == "save":
                    witch_antidote_target = ha.target
                elif ha.action_type == "poison":
                    witch_poison_target = ha.target

        # Store night actions (reset and rebuild with merged results)
        state.night_actions = []

        # 1. Wolf kill
        if wolf_kill_target and wolf_kill_target in alive:
            state.last_night_victim = wolf_kill_target
            state.night_actions.append(NightAction("kill", wolf_kill_target, "狼人"))

        # 2. Witch save
        if state.last_night_victim:
            if witch_antidote_target == state.last_night_victim:
                state.last_night_saved = state.last_night_victim
                state.witch_has_antidote = False
                state.night_actions.append(NightAction("save", state.last_night_victim, "女巫"))
                # Private message to witch
                private_messages.append((
                    f"你使用解药救活了{state.last_night_victim}。",
                    [n for n, r in roles.items() if r == "witch" and n in alive]
                ))
            else:
                # Victim dies
                night_dead.add(state.last_night_victim)

        # 3. Witch poison
        if witch_poison_target and witch_poison_target in alive:
            state.poisoned_by_witch = witch_poison_target
            night_dead.add(witch_poison_target)
            state.witch_has_poison = False
            state.night_actions.append(NightAction("poison", witch_poison_target, "女巫"))
            # Private message to witch
            private_messages.append((
                f"你使用毒药毒杀了{state.poisoned_by_witch}。",
                [n for n, r in roles.items() if r == "witch" and n in alive]
            ))

        # 4. Seer check — private to seer
        if seer_check_target and seer_check_target in alive:
            state.seer_checked = seer_check_target
            checked_role = roles.get(seer_check_target, "villager")
            checked_role_cn = {"wolf": "狼人", "seer": "预言家", "witch": "女巫",
                               "hunter": "猎人", "villager": "平民"}.get(checked_role, checked_role)
            state.night_actions.append(NightAction("check", seer_check_target, "预言家"))

            seer_names = [n for n, r in roles.items() if r == "seer" and n in alive]
            for s in seer_names:
                seer_msg = Message(
                    role="system", name="系统",
                    content=f"【查验结果】你昨晚查验了{seer_check_target}，他的真实身份是：{checked_role_cn}。",
                    track_id="main", visible_to=[s],
                    importance=IMPORTANCE_NORMAL,
                )
                self.memory.add_message(seer_msg)

        # Send private messages to relevant parties
        for content, visible_list in private_messages:
            for player in visible_list:
                if player in self.agents:
                    priv_msg = Message(
                        role="system", name="系统",
                        content=f"【夜间行动结果】{content}",
                        track_id="main", visible_to=[player],
                        importance=IMPORTANCE_NORMAL,
                    )
                    self.memory.add_message(priv_msg)

        # Apply deaths — sync both Router state and engine state
        dead_players = list(night_dead)
        for dead in dead_players:
            if dead in state.alive_players:
                state.alive_players.remove(dead)
                self._ww_engine.eliminate_player(dead)
                state.eliminated.append({
                    "name": dead,
                    "reason": "night_kill",
                    "round": state.round_number,
                })

        # PUBLIC announcement — says who died and reveals their identity
        if dead_players:
            result = f"【天亮播报】昨晚，{'、'.join(dead_players)}在夜晚中去世了。"
        else:
            result = "【天亮播报】昨晚是平安夜，无人死亡。"

        return result

    async def _process_werewolf_vote(self, all_outputs: List[dict]) -> str:
        """Process voting: parse agent outputs for votes, tally, eliminate.
        Returns a narration of the voting result."""
        state = self._werewolf_state
        if not state:
            return ""

        alive = state.alive_players
        votes = dict(state.votes)

        for output in all_outputs:
            name = output["agent_name"]
            content = output["content"]
            if name in self._werewolf_human_players:
                continue
            if name not in alive:
                continue
            patterns = [
                r'(?:我投|投票|投|我选|选|我投票)[票给]?[：:\s，、]*(\S{1,10})',
            ]
            target = self._find_werewolf_smart(content, patterns, alive)
            if not target:
                target = self._find_first_alive_name_after(content, ['投', '选', '投票'], alive)
            if target:
                votes[name] = target

        merged_votes = dict(state.votes)
        merged_votes.update(votes)
        state.votes = merged_votes

        if not merged_votes:
            return "【投票结果】没有人投票，今日无人被放逐。"

        # Use engine for vote processing
        vote_input = {voter: target for voter, target in merged_votes.items() if voter in alive}
        result = self._ww_engine.process_vote(vote_input)

        vote_detail_lines = [f"{voter} 投给了 {target}" for voter, target in merged_votes.items()]

        if result.get("eliminated"):
            eliminated = result["eliminated"]
            elim_result = self._ww_engine.eliminate_player(eliminated)
            state.alive_players = list(self._ww_engine.state.alive_players)

            state.eliminated.append({
                "name": eliminated,
                "reason": "vote",
                "round": state.round_number,
            })

            is_hunter = state.role_assignments.get(eliminated) == "hunter"
            out = f"【投票结果】\n" + "\n".join(vote_detail_lines)
            out += f"\n\n{eliminated} 被投票出局！"

            if is_hunter and state.hunter_can_shoot:
                out += f"\n{eliminated}是猎人，可以开枪带走一名玩家！"
                state.phase = "judgment"
            else:
                out += f"\n{eliminated} 被投票放逐。"

            return out
        elif len(result.get("runoff", [])) > 1:
            result = f"【投票结果】\n" + "\n".join(vote_detail_lines)
            result += f"\n\n{'、'.join(eliminated_candidates)}票数相同，无人被放逐。"
            return result
        else:
            return "【投票结果】无人被投出。"

    async def _check_werewolf_win(self) -> Optional[str]:
        """Check if either side has won.
        Returns 'wolf', 'villager', or None if game continues."""
        if not self._werewolf_state:
            return None
        winner = self._ww_engine.check_win()
        if winner:
            self._werewolf_state.winner = winner
            self._werewolf_state.phase = "ended"
            await self._emit("werewolf_game_over", {
                "message": f"{'好人' if winner == 'villager' else '狼人'}胜利！游戏共进行了{self._werewolf_state.round_number}轮。",
                "winner": winner,
            })
            return winner
        return None

    def _get_werewolf_task(self, agent_name: str, phase: str) -> str:
        """Get the task prompt for a werewolf agent based on phase and role."""
        state = self._werewolf_state
        if not state:
            return "继续对话"

        roles = state.role_assignments
        role = roles.get(agent_name, "villager")
        alive = state.alive_players

        if phase == "night":
            if role == "wolf":
                other_wolves = [n for n in alive if roles.get(n) == "wolf" and n != agent_name]
                others_note = ""
                if other_wolves:
                    others_note = f"同伴有：{'、'.join(other_wolves)}，你们可以商量目标。"
                return f"【狼人夜间行动】{others_note}\n请在对话中决定今晚要杀害谁，并明确说出目标，格式：杀XXX"
            elif role == "seer":
                return f"【预言家夜间行动】\n今晚你可以查验一名玩家的身份。请明确说出要查验的人，格式：查XXX"
            elif role == "witch":
                hints = []
                if state.witch_has_antidote and state.last_night_victim:
                    hints.append(f"今晚{state.last_night_victim}被狼人攻击了。你可以选择救他（格式：救{state.last_night_victim}）或不救。")
                elif state.witch_has_antidote:
                    hints.append("你还有解药可用。如果今晚有人被杀，你可以选择救他。")
                else:
                    hints.append("你的解药已经用过了。")

                if state.witch_has_poison:
                    hints.append("你还有毒药可用，可以毒杀一名玩家（格式：毒XXX）。")
                else:
                    hints.append("你的毒药已经用过了。")

                return "【女巫夜间行动】\n" + "\n".join(hints)
            else:
                # Unknown role: generate task via LLM
                return self._generic_role_task(agent_name, role, "night")
        elif phase == "discussion":
            last_night = ""
            if state.eliminated:
                last_elim = state.eliminated[-1]
                if last_elim.get("reason") == "night_kill":
                    last_night = f"\n昨晚，{last_elim['name']}在夜晚中死亡了。"
            return f"【第{state.round_number}天讨论】{last_night}\n请大家根据自己的身份和已知信息，自由讨论、推理、质疑或辩解。"

        elif phase == "voting":
            return f"【第{state.round_number}天投票】\n请投票选出你认为是狼人的玩家。格式：我投XXX"

        elif phase == "judgment":
            if role == "hunter" and agent_name in [e["name"] for e in state.eliminated if e.get("reason") == "vote"]:
                return f"【猎人遗言】\n你是猎人，被投票出局了。你可以开枪带走一名玩家。格式：开枪XXX"
            return "【审判阶段】"

        return "继续当前游戏。"

    def _generic_role_task(self, agent_name: str, role: str, phase: str) -> str:
        """Generate task for unknown role - LLM if available, fallback to generic."""
        if hasattr(self, 'arbiter') and self.arbiter:
            try:
                state = self._werewolf_state
                alive = "、".join(state.alive_players) if state else ""
                prompt = f"狼人杀游戏。角色{agent_name}的身份是{role}。当前阶段:{phase}。存活:{alive}。请为此角色写一个10-30字的中文行动提示。"
                result = self.arbiter._llm.call_json(prompt, max_tokens=60)
                text = result.get("narration", "") or result.get("result", "")
                if text:
                    return text[:50]
            except Exception:
                pass
        if phase == "night":
            return f"【{role}夜间行动】\n请根据你的身份决定今晚的行动。"
        return f"【{role}】\n请根据角色身份参与游戏。"

    async def _process_generic_night_actions(self, all_outputs: list) -> list:
        """Parse night actions from LLM agents with unknown roles."""
        state = self._werewolf_state
        results = []
        known_roles = ("wolf", "seer", "witch", "hunter", "villager")
        for output in all_outputs:
            role = state.role_assignments.get(output["agent_name"], "")
            if role in known_roles:
                continue
            if role:
                results.append({
                    "agent_name": output["agent_name"],
                    "role": role,
                    "content": output["content"][:200],
                    "action": "unknown"
                })
        return results

    async def _assign_werewolf_tasks(self) -> List[dict]:
        """Assign werewolf-specific tasks per agent based on phase and role."""
        state = self._werewolf_state
        if not state:
            return []

        phase = state.phase
        alive = state.alive_players
        roles = state.role_assignments
        role_hint = self._werewolf_role_hints

        # Game ended: no tasks
        if phase == "ended":
            return []

        # Build last night's death info
        last_night_info = ""
        if state.eliminated and state.eliminated[-1].get("reason") == "night_kill":
            last_elim = state.eliminated[-1]
            last_night_info = f"昨晚，{last_elim['name']}在夜晚中死亡。"
        elif state.eliminated and state.eliminated[-1].get("reason") == "vote":
            last_elim = state.eliminated[-1]
            last_night_info = f"昨天，{last_elim['name']}被投票出局。"
        else:
            last_night_info = "昨晚是平安夜。"

        public_context = (
            f"【第{state.round_number}天】\n"
            f"存活玩家：{'、'.join(alive)}\n"
            f"{last_night_info}\n"
        )

        tasks = []

        # For judgment phase, include the eliminated hunter who can still shoot
        candidates_for_tasks = list(alive)
        if phase == "judgment":
            last_elim = state.eliminated[-1] if state.eliminated else {}
            if last_elim.get("reason") in ("vote", "night_kill") and roles.get(last_elim.get("name", "")) == "hunter" and state.hunter_can_shoot:
                hunter_name = last_elim["name"]
                if hunter_name not in candidates_for_tasks and hunter_name in self.agents:
                    candidates_for_tasks.append(hunter_name)

        for name in candidates_for_tasks:
            if name not in self.agents:
                continue
            # Skip human player — they act via API, not LLM
            if name in self._werewolf_human_players:
                continue
            role = roles.get(name, "villager")
            hint = role_hint.get(name, "")
            phase_task = self._get_werewolf_task(name, phase)

            if phase == "night":
                # Night: different tasks per role
                if role == "wolf":
                    other_wolves = [n for n in alive if roles.get(n) == "wolf" and n != name]
                    other_note = f"你的狼人同伴：{'、'.join(other_wolves)}。" if other_wolves else "你是唯一的狼人。"
                    task = (
                        f"【狼人杀 - 第{state.round_number}夜 - 狼人行动】\n"
                        f"{public_context}\n"
                        f"{other_note}\n"
                        f"你收到的角色提示：{hint}\n\n"
                        f"请与其他狼人同伴商量今晚要杀害的目标。\n"
                        f"最终必须明确说出你们要杀的人，格式：杀XXX（XXX为角色名）\n"
                        f"注意：你的对话只有狼人同伴能看到，其他人不知道你们的讨论。"
                    )
                elif role == "seer":
                    task = (
                        f"【狼人杀 - 第{state.round_number}夜 - 预言家行动】\n"
                        f"{public_context}\n"
                        f"你收到的角色提示：{hint}\n\n"
                        f"请选择一名玩家查验身份。\n"
                        f"格式：查XXX（XXX为角色名）\n"
                        f"系统会将查验结果私下告诉你。"
                    )
                elif role == "witch":
                    witch_hints = []
                    if state.witch_has_antidote:
                        if state.last_night_victim:
                            witch_hints.append(f"昨晚 {state.last_night_victim} 被杀了，你还有一瓶解药。如果要救他，请回复：救{state.last_night_victim}")
                        else:
                            witch_hints.append("你还有一瓶解药，可以先保留。")
                    else:
                        witch_hints.append("你的解药已经用过了。")
                    if state.witch_has_poison:
                        witch_hints.append("你还有一瓶毒药。通常第一晚不建议盲目使用。如果要毒人，请回复：毒XXX")
                    else:
                        witch_hints.append("你的毒药已经用过了。")

                    witch_info = "\n".join(witch_hints)
                    task = (
                        f"【狼人杀 - 第{state.round_number}夜 - 女巫行动】\n"
                        f"{public_context}\n"
                        f"你收到的角色提示：{hint}\n\n"
                        f"{witch_info}\n"
                        f"请决定你的行动。如果不做任何事，请回复：什么都不做"
                    )
                else:
                    # Villager, hunter at night — offline
                    continue
            elif phase == "discussion":
                task = (
                    f"【狼人杀 - 第{state.round_number}天 - 讨论阶段】\n"
                    f"{public_context}\n"
                    f"你收到的角色提示：{hint}\n\n"
                    f"现在是白天讨论时间。所有存活玩家在一起讨论。\n"
                    f"请根据你已经掌握的信息（你的身份、昨晚的情况等）参与讨论。\n"
                    f"可以质疑别人、为自己辩解、或者引导讨论方向。\n"
                    f"如果你是狼人，请注意伪装。如果你有特殊身份，可以适当透露或隐藏信息。"
                )
            elif phase == "voting":
                task = (
                    f"【狼人杀 - 第{state.round_number}天 - 投票阶段】\n"
                    f"{public_context}\n"
                    f"你收到的角色提示：{hint}\n\n"
                    f"现在是投票时间！请投出你认为是狼人的玩家。\n"
                    f"格式：我投XXX（XXX为角色名）\n"
                    f"注意：必须明确写出你要投票的人，否则投票无效。"
                )
            elif phase == "judgment":
                last_elim = state.eliminated[-1] if state.eliminated else {}
                if role == "hunter" and last_elim.get("name") == name and last_elim.get("reason") == "vote":
                    task = (
                        f"【狼人杀 - 猎人行动】\n"
                        f"你被投票出局了！作为猎人，你可以在出局前开枪带走一人。\n"
                        f"格式：开枪XXX（XXX为你要带走的角色名）"
                    )
                else:
                    continue  # No task for other players in judgment
            else:
                continue

            tasks.append({"agent_name": name, "task": task})

        return tasks

    async def _integrate_werewolf_phase(self, all_outputs: List[dict]) -> tuple:
        """Integrate werewolf phase results. Returns (narration, phase_change)."""
        state = self._werewolf_state
        if not state:
            return "", ""
        phase = state.phase

        if phase == "night":
            night_roles = ("wolf", "seer", "witch")
            known_prompts = {
                "wolf": "【狼人行动】今晚杀谁？回复 杀XXX",
                "seer": "【预言家行动】查验谁？回复 查验XXX",
                "witch": "【女巫行动】救人或毒人？回复 救XXX / 毒XXX / 不救",
            }
            already_submitted = {na.source for na in state.night_actions}
            human_need = [hp for hp in self._werewolf_human_players
                         if hp in state.alive_players
                         and hp not in already_submitted]
            if human_need:
                for hp in human_need:
                    role = state.role_assignments.get(hp, "")
                    prompt = known_prompts.get(role, "")
                    if not prompt:
                        # Unknown role: generate prompt generically
                        prompt = f"【{role}行动】你是{role}，请根据你的身份决定行动。回复你的行动内容。"
                    if prompt:
                        self.memory.add_message(Message(role="system", name="系统", content=prompt, track_id="main", visible_to=[hp], importance=IMPORTANCE_NORMAL))
                        await self._emit("agent_output", {"agent_name":hp,"content":prompt,"track_id":f"night_{hp}","track_label":"夜晚行动","track_mode":"isolated","visible_to":[hp]})
                self._werewolf_waiting_for_human = True
                await self._emit("werewolf_wait_human", {"phase":"night","message":"等待真人完成夜晚行动","round":state.round_number})
                await self._emit_werewolf_state()
                return "夜晚行动中，等待真人...", "night→wait_human"

            narration = await self._process_werewolf_night(all_outputs)
            winner = await self._check_werewolf_win()
            if winner:
                narration += f"\n\n{self._build_werewolf_ending(winner)}"
                await self._emit_werewolf_state()
                return narration, f"night→ended({winner}胜)"
            self._ww_engine.advance_phase()
            state.phase = self._ww_engine.state.phase_name
            self._werewolf_discussion_human_spoken = False
            self._werewolf_waiting_for_human = False
            narration += f"\n\n【天亮了】第{state.round_number}天。开始讨论。"
            await self._emit_werewolf_state()
            return narration, f"night→discussion"

        elif phase == "discussion":
            if self._werewolf_human_players and not self._werewolf_discussion_human_spoken:
                self._werewolf_waiting_for_human = True
                await self._emit("werewolf_wait_human", {"phase":"discussion","message":"请真人玩家发言","round":state.round_number})
                return "AI已发言完毕，请真人发言。", "discussion→wait_human"
            self._werewolf_discussion_human_spoken = False
            self._werewolf_waiting_for_human = False
            self._ww_engine.advance_phase()
            state.phase = self._ww_engine.state.phase_name
            narration = f"讨论结束，进入投票阶段。"
            await self._emit_werewolf_state()
            return narration, "discussion→voting"

        elif phase == "voting":
            narration = await self._process_werewolf_vote(all_outputs)
            if state.phase == "judgment":
                return narration, "voting→judgment"
            winner = await self._check_werewolf_win()
            if winner:
                narration += f"\n\n{self._build_werewolf_ending(winner)}"
                await self._emit_werewolf_state()
                return narration, f"voting→ended({winner}胜)"
            self._ww_engine.advance_phase()
            state.phase = self._ww_engine.state.phase_name
            state.round_number = self._ww_engine.state.round
            state.night_actions = []
            state.votes = {}
            narration += "\n\n天黑请闭眼..."
            await self._emit_werewolf_state()
            return narration, f"voting→night"

        elif phase == "judgment":
            narration = await self._process_werewolf_judgment(all_outputs)
            self._ww_engine.advance_phase()
            state.phase = self._ww_engine.state.phase_name
            state.round_number = self._ww_engine.state.round
            state.night_actions = []
            state.votes = {}
            await self._emit_werewolf_state()
            return narration, f"judgment→night"

        return "", ""

    async def _llm_gen_narration(self, base: str, outputs: List[dict], state, transition: str) -> str:
        """Generate narration via LLM if available, fall back to base."""
        return base  # Skip LLM for now - use hardcoded narration which is reliable

    async def _llm_gen_prompt(self, player: str, role: str, phase: str, state) -> str:
        """Generate prompt via LLM or fallback to hardcoded."""
        return self._default_night_prompt(role, state)  # Use hardcoded for reliability

    def _default_night_prompt(self, role: str, state) -> str:
        """Fallback hardcoded night prompts when LLM is unavailable."""
        prompts = {
            "wolf": "【狼人行动】今晚你要杀谁？回复 杀XXX（XXX为角色名）",
            "seer": "【预言家行动】你要查验谁？回复 查XXX（XXX为角色名）",
            "witch": "【女巫行动】你有一瓶解药和一瓶毒药。要救人回复 救XXX，要毒人回复 毒XXX，都不做回复 不救",
        }
        return prompts.get(role, "")

    async def _process_werewolf_judgment(self, all_outputs: List[dict]) -> str:
        """Process hunter's revenge kill."""
        state = self._werewolf_state
        if not state:
            return ""

        eliminated_name = state.eliminated[-1]["name"] if state.eliminated else ""
        if not eliminated_name:
            return "【审判】无人需要审判。"

        # Parse hunter shot
        hunter_shot_target = ""
        for output in all_outputs:
            name = output["agent_name"]
            content = output["content"]
            if name == eliminated_name:
                patterns = [
                    r'(?:开枪|带走|击杀|打死|干掉|解决)[：:\s，、]*(\S{1,10})',
                ]
                hunter_shot_target = self._find_werewolf_smart(content, patterns, state.alive_players)
                if not hunter_shot_target:
                    hunter_shot_target = self._find_first_alive_name_after(content, ['开枪', '带走', '击杀', '打死', '干掉'], state.alive_players)

        if hunter_shot_target:
            state.alive_players.remove(hunter_shot_target)
            state.eliminated.append({
                "name": hunter_shot_target,
                "reason": "hunter_shot",
                "round": state.round_number,
            })
            state.hunter_can_shoot = False
            return f"【猎人开枪】{eliminated_name}作为猎人，开枪带走了{hunter_shot_target}！"
        else:
            return f"【猎人遗言】{eliminated_name}没有开枪。"

    def _get_werewolf_public_state(self) -> dict:
        """Return public werewolf state (without role assignments — those are private)."""
        if not self._werewolf_state:
            return {}
        state = self._werewolf_state
        return {
            "phase": state.phase,
            "round_number": state.round_number,
            "alive_players": list(state.alive_players),
            "eliminated": [
                {"name": e["name"], "reason": e.get("reason", ""), "round": e.get("round", 0)}
                for e in state.eliminated
            ],
            "winner": state.winner,
        }

    def _build_werewolf_ending(self, winner: str) -> str:
        """Build the game ending narration."""
        state = self._werewolf_state
        if not state:
            return ""

        if winner == "wolf":
            wolves = [n for n, r in state.role_assignments.items() if r == "wolf"]
            return (
                f"\n\n========= 游戏结束 =========\n"
                f"【狼人胜利！】\n"
                f"狼人阵营（{'、'.join(wolves)}）成功消灭了所有村民！\n"
                f"游戏共进行了{state.round_number}轮。\n"
                f"=============================="
            )
        else:
            return (
                f"\n\n========= 游戏结束 =========\n"
                f"【好人胜利！】\n"
                f"所有狼人都被消灭了，村庄恢复了和平！\n"
                f"游戏共进行了{state.round_number}轮。\n"
                f"=============================="
            )

    def _role_cn(self, role: str) -> str:
        """Map role name to Chinese display name."""
        return {"wolf":"狼人","seer":"预言家","witch":"女巫","hunter":"猎人","villager":"村民"}.get(role, role)
    # ================================================================
