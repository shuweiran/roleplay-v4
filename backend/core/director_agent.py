"""Authoritative director agent for preflight and runtime stage control.

The LLM may interpret intent, but it never owns world state.  Every claimed
change is first validated and committed to :class:`DirectorSession`; runtime
code then synchronises that state into the Router.  This prevents the classic
"DM said it happened, scheduler still disagrees" failure mode.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple


MAX_DIRECTOR_MESSAGES = 60


@dataclass
class DirectorMessage:
    role: str
    content: str
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> dict:
        return {"role": self.role, "content": self.content, "created_at": self.created_at}


@dataclass
class DirectorSession:
    """Durable control-plane state for one roleplay scene."""

    preflight_id: str
    scene_id: str
    scene_description: str
    player: Dict[str, Any]
    cast: Dict[str, Dict[str, Any]]
    relationships: List[str] = field(default_factory=list)
    entry_order: List[str] = field(default_factory=list)
    onstage: List[str] = field(default_factory=list)
    offstage: List[str] = field(default_factory=list)
    scene_notes: List[str] = field(default_factory=list)
    confirmed: bool = False
    messages: List[DirectorMessage] = field(default_factory=list)

    @property
    def player_name(self) -> str:
        return str(self.player.get("name") or "").strip()

    @property
    def cast_names(self) -> List[str]:
        return list(self.cast.keys())

    def normalize(self) -> None:
        names = self.cast_names
        if self.player_name and self.player_name not in names:
            self.cast[self.player_name] = dict(self.player)
            names = self.cast_names

        def valid_unique(items: List[str]) -> List[str]:
            out: List[str] = []
            for raw in items:
                name = str(raw).strip()
                if name in names and name not in out:
                    out.append(name)
            return out

        self.entry_order = valid_unique(self.entry_order)
        for name in names:
            if name not in self.entry_order:
                self.entry_order.append(name)

        self.onstage = valid_unique(self.onstage)
        # The human-controlled identity must remain available to the input path.
        if self.player_name and self.player_name not in self.onstage:
            self.onstage.insert(0, self.player_name)

        self.offstage = [n for n in names if n not in self.onstage]

    def add_message(self, role: str, content: str) -> None:
        self.messages.append(DirectorMessage(role=role, content=content.strip()))
        if len(self.messages) > MAX_DIRECTOR_MESSAGES:
            self.messages = self.messages[-MAX_DIRECTOR_MESSAGES:]

    def set_stage(self, character: str, present: bool) -> Tuple[bool, str]:
        name = str(character).strip()
        if name not in self.cast:
            return False, f"未知角色：{name}"
        if name == self.player_name and not present:
            return False, "不能通过主控面板让玩家自身离场；请先结束/切换玩家身份"

        if present:
            if name not in self.onstage:
                self.onstage.append(name)
        else:
            self.onstage = [n for n in self.onstage if n != name]
        self.normalize()
        return True, f"{name}{'进场' if present else '离场'}"

    def set_entry_order(self, order: List[str]) -> Tuple[bool, str]:
        cleaned: List[str] = []
        for raw in order:
            name = str(raw).strip()
            if name not in self.cast:
                return False, f"出场顺序包含未知角色：{name}"
            if name not in cleaned:
                cleaned.append(name)
        if not cleaned:
            return False, "出场顺序不能为空"
        self.entry_order = cleaned
        self.normalize()
        return True, "已更新出场顺序"

    def set_relation(self, source: str, target: str, relation: str) -> Tuple[bool, str]:
        source = str(source).strip()
        target = str(target).strip()
        relation = str(relation).strip()
        if source not in self.cast or target not in self.cast:
            return False, "关系修改包含未知角色"
        if not relation:
            return False, "关系描述不能为空"
        prefix = f"{source}→{target}:"
        self.relationships = [r for r in self.relationships if not str(r).startswith(prefix)]
        self.relationships.append(f"{prefix} {relation}")
        return True, f"已更新 {source} 与 {target} 的关系"

    def add_scene_note(self, note: str) -> Tuple[bool, str]:
        note = str(note).strip()
        if not note:
            return False, "场景补充不能为空"
        if note not in self.scene_notes:
            self.scene_notes.append(note)
            self.scene_notes = self.scene_notes[-20:]
        return True, "已记录场景补充"

    def identity_summary(self) -> str:
        p = self.player
        detail = str(p.get("persona") or p.get("personality") or p.get("intro") or "").strip()
        background = str(p.get("background") or "").strip()
        bits = [f"玩家扮演：{self.player_name or '未指定'}"]
        if detail:
            bits.append(f"身份/人格：{detail[:280]}")
        if background:
            bits.append(f"背景：{background[:240]}")
        return "\n".join(bits)

    def state_summary(self) -> str:
        self.normalize()
        rel = "；".join(self.relationships) if self.relationships else "未补充"
        notes = "；".join(self.scene_notes) if self.scene_notes else "无"
        return (
            f"{self.identity_summary()}\n"
            f"当前在场：{'、'.join(self.onstage) if self.onstage else '无'}\n"
            f"当前离场：{'、'.join(self.offstage) if self.offstage else '无'}\n"
            f"计划出场顺序：{' → '.join(self.entry_order) if self.entry_order else '未设置'}\n"
            f"角色关系：{rel}\n"
            f"补充约束：{notes}"
        )

    def runtime_context(self) -> str:
        return (
            f"{self.scene_description.strip()}\n\n"
            "【主控权威状态】\n"
            f"{self.state_summary()}\n"
            "规则：在场/离场是服务端权威状态；离场角色不得被调度、旁听或发言。"
        ).strip()

    def to_dict(self, include_history: bool = False) -> dict:
        self.normalize()
        data = {
            "preflight_id": self.preflight_id,
            "scene_id": self.scene_id,
            "scene_description": self.scene_description,
            "player": self.player,
            "cast": list(self.cast.values()),
            "relationships": self.relationships,
            "entry_order": self.entry_order,
            "onstage": self.onstage,
            "offstage": self.offstage,
            "scene_notes": self.scene_notes,
            "confirmed": self.confirmed,
        }
        if include_history:
            data["messages"] = [m.to_dict() for m in self.messages]
        return data


DIRECTOR_SYSTEM_PROMPT = """你是角色扮演系统的“主控 Agent”，不是普通旁白生成器。

你的职责边界：
1. 你负责理解玩家身份、角色关系、当前场景、出场顺序、谁在场/谁离场，并维护这些控制信息。
2. 你可以提出并申请“角色进场/离场、出场顺序、关系说明、场景补充”操作；真正执行由服务端状态机完成。
3. 你不能替角色决定台词、思想、感情或自主行动；不能改写已经发生的事实。
4. 绝对不能把“准备执行/建议执行”说成“已经执行”。只有 operations 被服务端接受后，系统才会用确定性文本确认已执行。
5. roster（角色登记表）不等于 onstage（当前在场角色）。回答谁在场时只能依据权威状态。
6. 剧本开始前，要与玩家确认：玩家扮演身份、关系、首场在场角色、出场顺序、剧本/场景补充。玩家明确确认后才能开始。
7. 对话要连续承接。稳定事实以权威状态为准；最近对话仅用于理解指代和意图。

你只能输出 JSON：
{
  "reply": "给玩家的自然回复；不要虚构已执行结果",
  "operations": [
    {"type":"set_stage","character":"角色名","present":true},
    {"type":"set_entry_order","order":["角色A","角色B"]},
    {"type":"set_relation","source":"角色A","target":"角色B","relation":"关系说明"},
    {"type":"add_scene_note","text":"场景/剧本补充"}
  ],
  "confirm": false
}
confirm 只有当玩家明确说“确认/就这样/开始/进入场景”等同意当前配置时才能为 true。
"""


class DirectorAgent:
    """Intent interpreter whose mutations are validated by DirectorSession."""

    def __init__(self, llm_client: Any = None):
        self._llm = llm_client

    @staticmethod
    def new_session(
        *,
        scene_id: str,
        scene_description: str,
        player: Dict[str, Any],
        characters: List[Dict[str, Any]],
        relationships: Optional[List[str]] = None,
        entry_order: Optional[List[str]] = None,
        onstage: Optional[List[str]] = None,
    ) -> DirectorSession:
        cast: Dict[str, Dict[str, Any]] = {}
        for raw in characters or []:
            name = str(raw.get("name") or "").strip()
            if name:
                cast[name] = dict(raw)
        player_name = str((player or {}).get("name") or "").strip()
        if player_name:
            cast[player_name] = {**cast.get(player_name, {}), **dict(player)}

        names = list(cast.keys())
        session = DirectorSession(
            preflight_id=f"director_{uuid.uuid4().hex[:12]}",
            scene_id=scene_id,
            scene_description=scene_description,
            player=dict(player or {}),
            cast=cast,
            relationships=[str(x) for x in (relationships or []) if str(x).strip()],
            entry_order=list(entry_order or names),
            onstage=list(onstage or names),
        )
        session.normalize()
        greeting = (
            "进场前先确认本局控制信息。\n"
            f"{session.state_summary()}\n\n"
            "你可以直接告诉我谁先在场、谁暂时离场、之后按什么顺序进场，"
            "以及你和各角色的关系。确认无误后说“确认进入场景”。"
        )
        session.add_message("assistant", greeting)
        return session

    async def chat(self, session: DirectorSession, text: str) -> dict:
        text = str(text or "").strip()
        if not text:
            return {"reply": "消息不能为空。", "operations": [], "state": session.to_dict()}
        session.add_message("user", text)

        parsed = await self._interpret(session, text)
        operations = parsed.get("operations") if isinstance(parsed, dict) else []
        if not isinstance(operations, list):
            operations = []

        applied: List[str] = []
        rejected: List[str] = []
        for op in operations[:12]:
            if not isinstance(op, dict):
                continue
            ok, message = self._apply_operation(session, op)
            (applied if ok else rejected).append(message)

        if bool(parsed.get("confirm")):
            session.confirmed = True
            applied.append("已确认进场配置")

        session.normalize()
        if applied or rejected:
            parts: List[str] = []
            if applied:
                parts.append("已写入权威状态：" + "；".join(applied))
            if rejected:
                parts.append("未执行：" + "；".join(rejected))
            parts.append(session.state_summary())
            reply = "\n".join(parts)
        else:
            reply = str(parsed.get("reply") or "").strip() or self._fallback_reply(session, text)

        session.add_message("assistant", reply)
        return {
            "reply": reply,
            "operations": operations,
            "applied": applied,
            "rejected": rejected,
            "state": session.to_dict(),
        }

    async def _interpret(self, session: DirectorSession, text: str) -> dict:
        if self._llm:
            history = "\n".join(
                f"{m.role}: {m.content}" for m in session.messages[-24:]
            )
            prompt = (
                f"【权威状态】\n{session.state_summary()}\n\n"
                f"【可用角色】{session.cast_names}\n\n"
                f"【最近对话】\n{history}\n\n"
                f"【本轮玩家消息】\n{text}"
            )
            try:
                data = await self._llm.call_json(
                    prompt,
                    system_prompt=DIRECTOR_SYSTEM_PROMPT,
                    max_tokens=700,
                    temperature=0.1,
                    timeout=30.0,
                )
                if isinstance(data, dict) and (data.get("reply") is not None or data.get("operations") is not None):
                    return data
            except Exception:
                pass
        return self._fallback_parse(session, text)

    def _apply_operation(self, session: DirectorSession, op: Dict[str, Any]) -> Tuple[bool, str]:
        kind = str(op.get("type") or "").strip()
        if kind == "set_stage":
            return session.set_stage(str(op.get("character") or ""), bool(op.get("present")))
        if kind == "set_entry_order":
            order = op.get("order") if isinstance(op.get("order"), list) else []
            return session.set_entry_order(order)
        if kind == "set_relation":
            return session.set_relation(
                str(op.get("source") or ""),
                str(op.get("target") or ""),
                str(op.get("relation") or ""),
            )
        if kind == "add_scene_note":
            return session.add_scene_note(str(op.get("text") or ""))
        return False, f"不支持的主控操作：{kind or '空操作'}"

    def _fallback_parse(self, session: DirectorSession, text: str) -> dict:
        operations: List[dict] = []
        for name in sorted(session.cast_names, key=len, reverse=True):
            if name == session.player_name:
                continue
            escaped = re.escape(name)
            if re.search(escaped + r".{0,10}(?:离场|退出场景|先退出|暂时退出|不要出场)", text):
                operations.append({"type": "set_stage", "character": name, "present": False})
            elif re.search(escaped + r".{0,10}(?:进场|进入场景|拉进来|回来|重新出场)", text):
                operations.append({"type": "set_stage", "character": name, "present": True})

        confirm = bool(re.search(r"(?:确认进入|确认开始|就这样|按这个来|开始吧|进入场景|正式开始)", text))
        return {
            "reply": self._fallback_reply(session, text),
            "operations": operations,
            "confirm": confirm,
        }

    @staticmethod
    def _fallback_reply(session: DirectorSession, text: str) -> str:
        if any(k in text for k in ("谁在场", "现在谁", "当前场景", "啥意思", "怎么做")):
            return session.state_summary()
        return (
            "我会把你说的内容当作主控配置讨论，不会把未执行的操作说成已经执行。\n"
            + session.state_summary()
        )
