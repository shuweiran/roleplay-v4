"""Scene CRUD routes."""

from fastapi import APIRouter, HTTPException, Request

from ..config import AppConfig
from ..core.agent import Agent
from ..core.persona import Persona
from ..core.router import Router as CoreRouter
from ..models.schemas import SceneGenerateRequest, SceneRequest
from .dependencies import get_character_store, get_llm_client, get_router, get_scene_store, get_session_manager

router = APIRouter(prefix="/api", tags=["scenes"])


@router.get("/scenes")
async def list_scenes(request: Request):
    return {"scenes": get_router(request).get_scenes()}


@router.post("/scenes")
async def create_scene(req: SceneRequest, request: Request):
    try:
        data = get_router(request).save_scene(
            scene_id=req.scene_id, name=req.name,
            description=req.description, agent_names=req.agent_names)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "ok", "scene": data}


@router.put("/scenes/{scene_id}")
async def update_scene(scene_id: str, req: SceneRequest, request: Request):
    try:
        data = get_router(request).save_scene(
            scene_id=scene_id, name=req.name,
            description=req.description, agent_names=req.agent_names)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "ok", "scene": data}


@router.delete("/scenes/{scene_id}")
async def delete_scene(scene_id: str, request: Request):
    if not get_router(request).delete_scene(scene_id):
        raise HTTPException(status_code=404, detail=f"场景 '{scene_id}' 不存在")
    return {"status": "ok"}


@router.post("/scenes/generate")
async def generate_scene(req: SceneGenerateRequest, request: Request):
    result = await get_router(request).auto_generate_scene(keywords=req.keywords or "")
    if "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])
    return {"status": "ok", "scene": result}


@router.post("/scenes/{scene_id}/enter")
async def enter_scene(scene_id: str, request: Request):
    if not get_router(request).enter_scene(scene_id):
        raise HTTPException(status_code=404, detail=f"场景 '{scene_id}' 不存在")
    return {"status": "ok", "scene_id": scene_id}


def _persona_from_payload(name: str, payload: dict) -> Persona:
    return Persona(
        name=name,
        persona=str(payload.get("persona") or payload.get("personality") or payload.get("intro") or ""),
        voice=str(payload.get("voice") or payload.get("talk_style") or payload.get("talkStyle") or ""),
        background=str(payload.get("background") or ""),
    )


@router.post("/scenes/{scene_id}/start")
async def start_scene(scene_id: str, agents: str = "", me: str = "", request: Request = None):
    """Create an isolated scene session.

    Backward compatibility keeps `agents`/`me` query params, while the JSON body
    is now authoritative for full character data and optional director preflight.
    Previous code silently discarded this body and replaced the human player's
    rich Persona with only "扮演{name}".
    """
    body = {}
    try:
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
    except Exception:
        body = {}

    body_agents = body.get("agents") if isinstance(body.get("agents"), list) else []
    agent_names = [n.strip() for n in agents.split(",") if n.strip()]
    if not agent_names:
        agent_names = [str(n).strip() for n in body_agents if str(n).strip()]
    if not agent_names:
        raise HTTPException(status_code=400, detail="请至少选择一个角色")

    dc = (me or str(body.get("me") or "")).strip()
    character_rows = body.get("characters") if isinstance(body.get("characters"), list) else []
    character_details = {
        str(row.get("name") or "").strip(): row
        for row in character_rows
        if isinstance(row, dict) and str(row.get("name") or "").strip()
    }

    # Optional pre-entry controller handshake.  If supplied it MUST be confirmed.
    preflight_id = str(body.get("preflight_id") or "").strip()
    director_session = None
    if preflight_id:
        director_sessions = getattr(request.app.state, "director_sessions", {})
        director_session = director_sessions.get(preflight_id)
        if director_session is None:
            raise HTTPException(status_code=404, detail="主控预备会话不存在或已失效")
        if not director_session.confirmed:
            raise HTTPException(status_code=409, detail="进场配置尚未与主控确认")
        if director_session.scene_id != scene_id:
            raise HTTPException(status_code=409, detail="主控预备会话与当前场景不匹配")
        if dc and director_session.player_name != dc:
            raise HTTPException(status_code=409, detail="主控确认的玩家身份与当前玩家角色不一致")

    old_router = get_router(request)
    personas = []
    for name in agent_names:
        detail = character_details.get(name)
        if detail:
            personas.append(_persona_from_payload(name, detail))
        elif director_session and name in director_session.cast:
            personas.append(_persona_from_payload(name, director_session.cast[name]))
        elif name in old_router._saved_characters:
            personas.append(old_router._saved_characters[name])
        elif name == dc:
            # Compatibility fallback only; normal new UI always provides full data.
            personas.append(Persona(name=name, persona=f"扮演{name}。用第一人称说话。", voice=""))
        else:
            cfg_m = request.app.state.config.mode if hasattr(request.app.state, "config") else None
            cfg_dc2 = cfg_m.director_character if cfg_m else "NO_CONFIG"
            cfg_m2 = cfg_m.mode if cfg_m else "NO_MODE"
            raise HTTPException(
                status_code=404,
                detail=f"角色 '{name}' 不存在 (dc='{dc}', agents={agent_names}, config_dc='{cfg_dc2}', mode='{cfg_m2}')",
            )

    llm_client = get_llm_client(request)
    char_store = get_character_store(request)
    scene_store = get_scene_store(request)
    session_mgr = get_session_manager(request)

    config = AppConfig()
    if old_router and old_router.config:
        config.mode.mode = old_router.config.mode.mode
        config.mode.protagonist = old_router.config.mode.protagonist
        config.mode.director_character = old_router.config.mode.director_character
        # Override with explicit player identity (handles rename and scene isolation).
        if dc:
            config.mode.director_character = dc
        if config.mode.director_character and config.mode.director_character not in agent_names:
            config.mode.director_character = ""
            if config.mode.mode == "director":
                config.mode.mode = "free"

    new_router = CoreRouter(
        config=config,
        llm_client=llm_client,
        character_store=char_store,
        scene_store=scene_store,
        session_manager=session_mgr,
    )
    if old_router:
        new_router.voice_enabled = getattr(old_router, "voice_enabled", True)

    # Keep the full Persona registry even for the human character.  NPCs removed
    # from the active roster can later be reconstructed without identity loss.
    for p in personas:
        new_router._saved_characters[p.name] = p
        if p.name != dc:
            new_router.save_character(p)

    await new_router.init_with_characters(personas, scene_id=scene_id)

    # Auto-create scene if it doesn't exist (e.g. generated/general scenes).
    if not new_router.enter_scene(scene_id):
        scene_name = "狼人杀经典局" if "werewolf" in scene_id else scene_id
        if director_session and director_session.scene_description.strip():
            scene_desc = director_session.scene_description.strip()
        else:
            scene_desc = (
                "狼人杀标准规则：角色分配、昼夜交替、投票出局、胜利判定。"
                if "werewolf" in scene_id else str(body.get("scene_description") or scene_id)
            )
        scene_data = {
            "scene_id": scene_id,
            "name": scene_name,
            "description": scene_desc,
            "initial_agent_names": agent_names,
        }
        scene_store.save(scene_id, scene_data)
        new_router.save_scene(scene_id, scene_name, scene_desc, agent_names)
        new_router.enter_scene(scene_id)

    if director_session:
        new_router._director_session = director_session
        base_scene = director_session.scene_description.strip() or new_router.scene_description
        new_router._director_base_scene_description = base_scene
        new_router.scene_description = (
            f"{base_scene}\n\n【主控权威状态】\n{director_session.state_summary()}"
        ).strip()

        # onstage is authoritative. Offstage characters remain registered but
        # cannot be seen by Arbiter because they are absent from Router.agents.
        allowed = set(director_session.onstage)
        for name in list(new_router.agents.keys()):
            if name not in allowed and name != dc:
                del new_router.agents[name]

        # Add a verified state marker to shared memory, not a fabricated action.
        try:
            from ..models.domain import Message
            marker = Message(
                role="system",
                name="主控",
                content=f"【进场配置已确认】\n{director_session.state_summary()}",
                track_id="main",
                visible_to=list(new_router.agents.keys()),
            )
            new_router.memory.add_message(marker)
        except Exception:
            pass

    request.app.state.router = new_router

    return {
        "status": "ok",
        "session_id": new_router.session_id,
        "agents": list(new_router.agents.keys()),
        "scene": scene_id,
        "director_state": director_session.to_dict() if director_session else None,
    }
