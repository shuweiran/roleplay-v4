"""Director-agent API: pre-entry negotiation and authoritative stage control."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..core.director_agent import DirectorAgent, DirectorSession
from ..core.agent import Agent
from .dependencies import get_llm_client, get_router


router = APIRouter(prefix="/api/director", tags=["director"])


class DirectorCharacter(BaseModel):
    name: str
    persona: str = ""
    personality: str = ""
    voice: str = ""
    talk_style: str = ""
    background: str = ""
    intro: str = ""


class DirectorPreflightRequest(BaseModel):
    scene_id: str
    scene_description: str = ""
    player: DirectorCharacter
    characters: List[DirectorCharacter] = Field(default_factory=list)
    relationships: List[str] = Field(default_factory=list)
    entry_order: List[str] = Field(default_factory=list)
    onstage: List[str] = Field(default_factory=list)


class DirectorChatRequest(BaseModel):
    text: str


def _sessions(request: Request) -> Dict[str, DirectorSession]:
    sessions = getattr(request.app.state, "director_sessions", None)
    if sessions is None:
        sessions = {}
        request.app.state.director_sessions = sessions
    return sessions


def _agent(request: Request) -> DirectorAgent:
    return DirectorAgent(get_llm_client(request))


def _model_dict(model: BaseModel) -> dict:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


def _explicit_entry_confirmation(text: str) -> bool:
    """Only player-level confirmation may unlock scene creation.

    A phrase such as “让兔子进入场景” is a stage mutation, not permission to
    start the whole game.  This guard sits outside the LLM/fallback parser so a
    model mistake cannot accidentally bypass the preflight gate.
    """
    text = str(text or "").strip()
    return bool(re.search(
        r"(?:确认(?:进入|开始|进场)|就这样(?:吧)?|按这个来|开始吧|正式开始|可以开始|可以进场|进入游戏)",
        text,
    ))


def _sync_runtime_stage(request: Request, session: DirectorSession) -> None:
    """Make DirectorSession.onstage the authoritative scheduler roster.

    Offstage characters stay in the durable persona registry but are absent from
    Router.agents, so neither Arbiter nor round execution can schedule them.
    Re-entry reconstructs the Agent from the original full Persona.
    """
    r = get_router(request)
    attached = getattr(r, "_director_session", None)
    if attached is None or attached.preflight_id != session.preflight_id:
        return

    allowed = set(session.onstage)
    player_name = session.player_name

    for name in list(r.agents.keys()):
        if name not in allowed and name != player_name:
            del r.agents[name]

    for name in session.onstage:
        if name == player_name or name in r.agents:
            continue
        persona = r._saved_characters.get(name)
        if persona is None:
            continue
        r.agents[name] = Agent(
            persona,
            name,
            llm_client=get_llm_client(request),
            llm_config=r.config.llm,
            monitor=r.monitor,
        )

    base_scene = getattr(r, "_director_base_scene_description", "") or session.scene_description
    r.scene_description = f"{base_scene}\n\n【主控权威状态】\n{session.state_summary()}".strip()


def _runtime_state(request: Request, session: DirectorSession) -> dict:
    r = get_router(request)
    data = session.to_dict(include_history=True)
    data["active_agents"] = list(r.agents.keys())
    return data


@router.post("/preflight")
async def create_preflight(req: DirectorPreflightRequest, request: Request):
    chars = [_model_dict(c) for c in req.characters]
    player = _model_dict(req.player)
    names = [str(c.get("name") or "").strip() for c in chars]
    if not player.get("name"):
        raise HTTPException(status_code=400, detail="玩家身份不能为空")
    if player["name"] not in names:
        chars.append(player)

    session = DirectorAgent.new_session(
        scene_id=req.scene_id,
        scene_description=req.scene_description,
        player=player,
        characters=chars,
        relationships=req.relationships,
        entry_order=req.entry_order or [c.get("name", "") for c in chars],
        onstage=req.onstage or [c.get("name", "") for c in chars],
    )
    _sessions(request)[session.preflight_id] = session
    greeting = session.messages[-1].content if session.messages else session.state_summary()
    return {
        "status": "ok",
        "preflight_id": session.preflight_id,
        "reply": greeting,
        "state": session.to_dict(include_history=True),
    }


@router.get("/preflight/{preflight_id}")
async def get_preflight(preflight_id: str, request: Request):
    session = _sessions(request).get(preflight_id)
    if session is None:
        raise HTTPException(status_code=404, detail="主控预备会话不存在或已失效")
    return {"status": "ok", "state": session.to_dict(include_history=True)}


@router.post("/preflight/{preflight_id}/chat")
async def preflight_chat(preflight_id: str, req: DirectorChatRequest, request: Request):
    session = _sessions(request).get(preflight_id)
    if session is None:
        raise HTTPException(status_code=404, detail="主控预备会话不存在或已失效")

    was_confirmed = session.confirmed
    result = await _agent(request).chat(session, req.text)

    # Defense in depth: only explicit player confirmation may open the gate.
    if not was_confirmed and session.confirmed and not _explicit_entry_confirmation(req.text):
        session.confirmed = False
        result["applied"] = [x for x in result.get("applied", []) if x != "已确认进场配置"]
        result["state"] = session.to_dict()
        result["reply"] = (
            "已处理角色/场景配置，但尚未确认正式进场。\n"
            f"{session.state_summary()}\n"
            "确认无误后请说“确认进入场景”或点击“确认并进入”。"
        )
        # Replace the just-added assistant history item with the guarded reply.
        if session.messages and session.messages[-1].role == "assistant":
            session.messages[-1].content = result["reply"]

    return {"status": "ok", **result}


@router.post("/chat")
async def runtime_director_chat(req: DirectorChatRequest, request: Request):
    """Talk to the same director after entering the scene.

    Mutations are applied to DirectorSession first, then synchronised into the
    scheduler roster. The HTTP response is returned only after that sync.
    """
    r = get_router(request)
    session: Optional[DirectorSession] = getattr(r, "_director_session", None)
    if session is None:
        raise HTTPException(status_code=409, detail="当前场景没有绑定主控 Agent；请从进场确认流程启动")

    result = await _agent(request).chat(session, req.text)
    _sync_runtime_stage(request, session)

    try:
        from ..models.domain import Message
        marker = Message(
            role="system",
            name="主控",
            content=f"【主控已验证状态】\n{session.state_summary()}",
            track_id="main",
            visible_to=list(r.agents.keys()),
        )
        r.memory.add_message(marker)
    except Exception:
        pass

    return {
        "status": "ok",
        **result,
        "state": _runtime_state(request, session),
    }


@router.get("/state")
async def runtime_director_state(request: Request):
    r = get_router(request)
    session: Optional[DirectorSession] = getattr(r, "_director_session", None)
    if session is None:
        raise HTTPException(status_code=404, detail="当前场景没有绑定主控 Agent")
    return {"status": "ok", "state": _runtime_state(request, session)}
