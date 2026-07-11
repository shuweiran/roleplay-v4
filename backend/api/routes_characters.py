"""Character CRUD routes."""

from fastapi import APIRouter, HTTPException, Request

from ..core.agent import Agent
from ..core.persona import Persona
from ..models.schemas import (
    BatchCharacterRequest,
    CharacterGenerateRequest,
    CharacterRequest,
    CharacterResponse,
    CharacterUpdateRequest,
)
from .dependencies import get_llm_client, get_router

router = APIRouter(prefix="/api", tags=["characters"])


@router.get("/characters")
async def list_characters(request: Request):
    router = get_router(request)
    return {"characters": router.get_characters()}


@router.post("/characters")
async def create_character(req: CharacterRequest, request: Request):
    router = get_router(request)
    persona = Persona(name=req.name, persona=req.persona, voice=req.voice, background=req.background)
    try:
        char_id = router.save_character(persona)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "ok", "character_id": char_id, "character": persona.to_dict()}


@router.put("/characters/{name}")
async def update_character(name: str, req: CharacterUpdateRequest, request: Request):
    """Atomically update a character (write new, then delete old). Fixes data-loss bug from v3."""
    router = get_router(request)
    if name not in router._saved_characters:
        raise HTTPException(status_code=404, detail=f"角色 '{name}' 不存在")

    old_persona = router._saved_characters[name]
    new_name = req.name or name
    was_active = name in router.agents
    was_protagonist = router.config.mode.protagonist == name
    persona = Persona(
        name=new_name,
        persona=req.persona if req.persona is not None else old_persona.persona,
        voice=req.voice if req.voice is not None else old_persona.voice,
        background=req.background if req.background is not None else old_persona.background,
    )
    try:
        router.save_character(persona)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if new_name != name:
        router.delete_character(name)
    if was_active:
        router.agents[new_name] = Agent(
            persona, new_name, llm_client=get_llm_client(request),
            llm_config=router.config.llm, monitor=router.monitor
        )
    if was_protagonist:
        router.config.mode.protagonist = new_name
    return {"status": "ok", "character": persona.to_dict()}


@router.delete("/characters/{name}")
async def delete_character(name: str, request: Request):
    router = get_router(request)
    success = router.delete_character(name)
    if not success:
        raise HTTPException(status_code=404, detail=f"角色 '{name}' 不存在")
    return {"status": "ok", "message": f"角色 '{name}' 已删除"}


@router.post("/characters/batch")
async def create_characters_batch(req: BatchCharacterRequest, request: Request):
    router = get_router(request)
    saved, errors = [], []
    for ch in req.characters:
        try:
            persona = Persona(name=ch.name, persona=ch.persona, voice=ch.voice, background=ch.background)
            char_id = router.save_character(persona)
            saved.append({"name": ch.name, "character_id": char_id})
        except Exception as e:
            errors.append({"name": ch.name, "error": str(e)})
    return {"status": "ok", "saved": saved, "errors": errors, "total": len(saved)}


@router.post("/characters/generate")
async def generate_character(req: CharacterGenerateRequest, request: Request):
    router = get_router(request)
    result = await router.auto_generate_character(keywords=req.keywords or "")
    if "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])
    return {"status": "ok", "character": result}
