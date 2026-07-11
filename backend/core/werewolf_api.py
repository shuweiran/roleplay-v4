"""
Werewolf game logic API - deterministic functions callable by LLM.

These functions encapsulate all game rules. The LLM arbiter calls them
via function-calling pattern to determine game outcomes, then generates
natural language narration around the results.

All functions are stateless - they receive game state and return results.
The Router (host) applies changes to live state after receiving results.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any


# ── Data types ────────────────────────────────────────────────────

@dataclass
class NightResult:
    """Result of processing a night phase."""
    killed: List[str] = field(default_factory=list)
    saved: str = ""
    poisoned: str = ""
    checked: str = ""
    checked_is_wolf: bool = False
    narration: str = ""


@dataclass
class VoteResult:
    """Result of processing a vote."""
    exiled: str = ""
    tally: Dict[str, int] = field(default_factory=dict)
    narration: str = ""


@dataclass
class WinResult:
    """Result of win condition check."""
    winner: str = ""       # "villager" / "wolf" / ""
    message: str = ""


# ── Game state accessors ───────────────────────────────────────────

def build_game_context(router) -> dict:
    """Build a JSON-serializable game context for the LLM."""
    state = router._werewolf_state
    if not state:
        return {"error": "No game in progress"}
    return {
        "phase": state.phase,
        "round": state.round_number,
        "alive_players": list(state.alive_players),
        "eliminated": [{"name": e["name"], "reason": e.get("reason",""), "role": state.role_assignments.get(e["name"],"")} for e in state.eliminated],
        "witch_has_antidote": state.witch_has_antidote,
        "witch_has_poison": state.witch_has_poison,
        "human_players": list(router._werewolf_human_players),
        "night_actions": [{"source": na.source, "action": na.action_type, "target": na.target} for na in state.night_actions],
        "votes": dict(state.votes),
    }


# ── Game rule functions ────────────────────────────────────────────

def process_night(router, night_actions: List[dict]) -> NightResult:
    """
    Process night actions and determine who died.
    
    Args:
        router: Router instance with _werewolf_state
        night_actions: [{"source":"name","action":"kill/check/save/poison","target":"target"}]
    
    Returns: NightResult with killed list and narration details
    """
    state = router._werewolf_state
    if not state:
        return NightResult(narration="No game in progress")
    
    alive = set(state.alive_players)
    roles = state.role_assignments
    
    wolf_target = ""
    seer_target = ""
    save_target = ""
    poison_target = ""
    
    for na in night_actions:
        if na["target"] not in alive:
            continue
        if na["action"] == "kill":
            wolf_target = na["target"]
        elif na["action"] == "check":
            seer_target = na["target"]
        elif na["action"] == "save":
            save_target = na["target"]
        elif na["action"] == "poison":
            poison_target = na["target"]
    
    killed = []
    result = NightResult()
    
    # Process kills and saves
    if wolf_target and wolf_target in alive:
        if save_target and save_target == wolf_target and state.witch_has_antidote:
            result.saved = wolf_target
            state.witch_has_antidote = False
        else:
            killed.append(wolf_target)
    
    # Process poison
    if poison_target and poison_target in alive and state.witch_has_poison:
        killed.append(poison_target)
        state.witch_has_poison = False
    
    # Process seer check
    if seer_target and seer_target in alive:
        result.checked = seer_target
        result.checked_is_wolf = roles.get(seer_target) == "wolf"
    
    # Clean up and store (don't modify real alive list here - host does it)
    state.night_actions = list(night_actions) if hasattr(state, 'night_actions') else []
    
    result.killed = killed
    if killed:
        result.narration = f"昨晚死亡: {', '.join(killed)}"
    else:
        result.narration = "昨晚是平安夜，无人死亡。"
    
    return result


def process_vote(router, votes: Dict[str, str], alive_players: List[str]) -> VoteResult:
    """
    Process voting results and determine who was exiled.
    
    Args:
        router: Router instance
        votes: {voter_name: target_name}
        alive_players: list of alive player names
    
    Returns: VoteResult with exiled player and tally
    """
    state = router._werewolf_state
    if not state:
        return VoteResult(narration="No game in progress")
    
    # Tally votes
    tally = {}
    for voter, target in votes.items():
        if voter in alive_players and target in alive_players:
            tally[target] = tally.get(target, 0) + 1
    
    result = VoteResult()
    result.tally = tally
    
    if not tally:
        result.narration = "无人投票，今天没有放逐。"
        return result
    
    max_votes = max(tally.values())
    top = [name for name, count in tally.items() if count == max_votes]
    
    if len(top) == 1:
        result.exiled = top[0]
        role = state.role_assignments.get(top[0], "?")
        result.narration = f"{top[0]} 被投票放逐，身份：{role}"
    else:
        result.narration = f"{'、'.join(top)} 票数相同({max_votes}票)，无人被放逐。"
    
    return result


def check_win(router) -> WinResult:
    """
    Check if the game has ended.
    
    Returns: WinResult with winner and message
    """
    state = router._werewolf_state
    if not state:
        return WinResult()
    
    alive = state.alive_players
    roles = state.role_assignments
    
    wolf_count = sum(1 for name in alive if roles.get(name) == "wolf")
    non_wolf = len(alive) - wolf_count
    
    if wolf_count == 0:
        return WinResult(winner="villager", message="好人胜利！所有狼人都被消灭了。")
    if wolf_count >= non_wolf:
        return WinResult(winner="wolf", message="狼人胜利！狼人数量已不少于好人。")
    
    return WinResult()


def get_available_actions(router, player_name: str) -> list:
    """
    Get available actions for a specific player based on their role and game phase.
    """
    state = router._werewolf_state
    if not state or player_name not in state.alive_players:
        return []
    
    role = state.role_assignments.get(player_name, "")
    phase = state.phase
    
    if phase == "night":
        if role == "wolf":
            return ["kill"]
        elif role == "seer":
            return ["check"]
        elif role == "witch":
            actions = []
            if state.witch_has_antidote:
                actions.append("save")
            if state.witch_has_poison:
                actions.append("poison")
            return actions
    elif phase in ("discussion", "voting"):
        return ["speak", "vote"]
    
    return []


# ── LLM Function Descriptions (for prompt injection) ───────────────

WEREWOLF_FUNCTIONS = """
你可以调用以下函数来控制游戏：

1. process_night(night_actions)
   处理夜晚行动。night_actions 是列表，每项格式: {"source":"角色名","action":"kill|check|save|poison","target":"目标"}
   返回: {killed: [死者], saved: 被救者, poisoned: 被毒者, checked: 被查者, narration: 旁白}

2. process_vote(votes)
   处理投票。votes 是字典: {投票者: 目标}
   返回: {exiled: 被放逐者, tally: 计票, narration: 旁白}

3. check_win()
   检查胜负。
   返回: {winner: "villager"|"wolf"|"", message: 结果消息}

4. get_state()
   获取当前游戏状态。

请用JSON回复，包含：
{
  "action": "函数名",
  "params": {参数},
  "narration": "你的主持旁白（50-100字）"
}
如果不需要调用函数，action设为空字符串。
"""
