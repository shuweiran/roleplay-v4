"""Scene CRUD routes."""

from fastapi import APIRouter, HTTPException, Request

from ..config import AppConfig
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


@router.post("/scenes/{scene_id}/start")
async def start_scene(scene_id: str, agents: str = "", me: str = "", request: Request = None):
    agent_names = [n.strip() for n in agents.split(",") if n.strip()]
    if not agent_names:
        raise HTTPException(status_code=400, detail="请至少选择一个角色")

    old_router = get_router(request)
    dc = me.strip() if me else ""
    personas = []
    for name in agent_names:
        if name == dc:
            from ..core.persona import Persona
            personas.append(Persona(name=name, persona=f"扮演{name}。用第一人称说话。", voice=""))
        elif name not in old_router._saved_characters:
            # Extra debug: check what config looks like
            import sys
            cfg_m = request.app.state.config.mode if hasattr(request.app.state, 'config') else None
            cfg_dc2 = cfg_m.director_character if cfg_m else 'NO_CONFIG'
            cfg_m2 = cfg_m.mode if cfg_m else 'NO_MODE'
            raise HTTPException(
                status_code=404,
                detail=f"角色 '{name}' 不存在 (dc='{dc}', has_cfg={has_cfg}, agents={agent_names}, config_dc='{cfg_dc2}', mode='{cfg_m2}')"
            )
        else:
            personas.append(old_router._saved_characters[name])

    llm_client = get_llm_client(request)
    char_store = get_character_store(request)
    scene_store = get_scene_store(request)
    session_mgr = get_session_manager(request)

    config = AppConfig()
    if old_router and old_router.config:
        config.mode.mode = old_router.config.mode.mode
        config.mode.protagonist = old_router.config.mode.protagonist
        config.mode.director_character = old_router.config.mode.director_character
        # Override with me query param if provided (handles rename)
        if me:
            config.mode.director_character = me
        # Session isolation: clear director if me card not in this session
        if config.mode.director_character and config.mode.director_character not in agent_names:
            config.mode.director_character = ''
            if config.mode.mode == 'director':
                config.mode.mode = 'free'
    new_router = CoreRouter(
        config=config, llm_client=llm_client,
        character_store=char_store, scene_store=scene_store,
        session_manager=session_mgr)
    if old_router:
        new_router.voice_enabled = getattr(old_router, 'voice_enabled', True)

    for p in personas:
        if p.name != dc:
            new_router.save_character(p)

    await new_router.init_with_characters(personas, scene_id=scene_id)
    # Auto-create scene if it doesn't exist (e.g. werewolf_default)
    if not new_router.enter_scene(scene_id):
        # Scene doesn't exist yet — create a minimal one
        scene_name = "狼人杀经典局" if "werewolf" in scene_id else scene_id
        scene_desc = "狼人杀标准规则：角色分配、昼夜交替、投票出局、胜利判定。"
        scene_data = {"scene_id": scene_id, "name": scene_name,
                     "description": scene_desc, "initial_agent_names": agent_names}
        scene_store.save(scene_id, scene_data)
        new_router.save_scene(scene_id, scene_name, scene_desc, agent_names)
        new_router.enter_scene(scene_id)
    request.app.state.router = new_router

    return {"status": "ok", "session_id": new_router.session_id,
            "agents": list(new_router.agents.keys()), "scene": scene_id}
