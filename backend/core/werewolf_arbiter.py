"""
Werewolf LLM Arbiter — LLM leads, code validates.

Architecture:  LLM decides → Code validates → Code executes → LLM narrates
"""

from __future__ import annotations
import json
from typing import Dict, List, Optional


GM_SYSTEM = """你是狼人杀游戏主持人。你必须用JSON回复。
你可以调用的函数：
- process_night(actions) 处理夜晚: actions=[{"role":"wolf","target":"名"}], 返回{killed:[],saved:""}
- start_discussion() 开始白天讨论
- start_voting() 开始投票
- end_game(winner) 结束游戏 winner="villager"或"wolf"

游戏规则：
- 狼人每晚必须杀一人
- 女巫有一瓶解药和一瓶毒药
- 预言家每晚查验一人
- 村民被杀或被投票出局揭示身份
- 狼人全灭=好人胜, 狼人数>=活人数=狼人胜"""

GM_PROMPT = """当前游戏:
  轮次{round} 阶段{phase_cn}
  存活:{alive}
  出局:{dead}
  人类玩家:{humans}
  本轮角色行动:
{actions}
  角色发言:
{summary}

你需要决定下一步。回复JSON:
{{
  "decision": "process_night|start_discussion|start_voting|end_game|wait_human",
  "narration": "公告(50-120字)",
  "guidance": "引导(20-50字)",
  "details": {{按函数参数}}
}}"""


class WerewolfArbiter:
    def __init__(self, router):
        self.router = router

    @property
    def _llm(self):
        if hasattr(self.router, 'arbiter') and self.router.arbiter:
            return self.router.arbiter._llm
        return None

    def _phase_cn(self, p: str) -> str:
        return {"night":"夜间","discussion":"白天讨论","voting":"投票","ended":"结束"}.get(p, p)

    async def decide(self, all_outputs: list, night_actions: list = None) -> dict:
        """LLM decides the next game action. Returns decision JSON."""
        if not self._llm:
            return {"decision": self._code_default()}

        state = self.router._werewolf_state
        if not state:
            return {"decision": "end_game", "narration": "无游戏状态"}

        alive = "、".join(state.alive_players)
        dead = "、".join(e.get("name","") for e in state.eliminated) if state.eliminated else "无"
        humans = "、".join(self.router._werewolf_human_players) or "无"
        actions_str = "\n".join(f"  {na.source}({state.role_assignments.get(na.source,'?')}) -> {na.action_type} {na.target}"
                                for na in (night_actions or state.night_actions))
        summary = "\n".join(f"  [{o['agent_name']}({state.role_assignments.get(o['agent_name'],'?')})]: {o['content'][:60]}"
                           for o in (all_outputs or [])[:8]) or "(无)"

        prompt = GM_SYSTEM + "\n" + GM_PROMPT.format(
            round=state.round_number, phase_cn=self._phase_cn(state.phase),
            alive=alive, dead=dead, humans=humans,
            actions=actions_str or "(无)", summary=summary,
        )
        try:
            return await self._llm.call_json(prompt, max_tokens=500)
        except Exception:
            return {"decision": self._code_default(), "narration": ""}

    def _code_default(self) -> str:
        """Fallback: code determines next phase."""
        phase = self.router._werewolf_state.phase
        if phase == "night":
            submitted = {na.source for na in self.router._werewolf_state.night_actions}
            need = [h for h in self.router._werewolf_human_players
                    if h in self.router._werewolf_state.alive_players
                    and self.router._werewolf_state.role_assignments.get(h) in ("wolf","seer","witch")
                    and h not in submitted]
            return "wait_human" if need else "process_night"
        if phase == "discussion":
            return "wait_human" if (self.router._werewolf_human_players and
                                    not self.router._werewolf_discussion_human_spoken) else "start_voting"
        if phase == "voting":
            return "process_voting"
        return "end_game"

    def validate(self, decision: dict) -> bool:
        """Code validates LLM decision against game rules."""
        state = self.router._werewolf_state
        dec = decision.get("decision", "")
        if dec == "process_night" and state.phase != "night":
            return False
        if dec == "start_voting" and state.phase not in ("discussion",):
            return False
        if dec == "end_game":
            winner = self.router._ww_engine.check_win() if self.router._ww_engine else None
            details = decision.get("details", {})
            if winner and details.get("winner") != winner:
                decision["details"]["winner"] = winner  # Fix hallucination
        return True
