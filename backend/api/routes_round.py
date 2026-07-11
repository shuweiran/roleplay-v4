"""Round management routes."""

from fastapi import APIRouter, HTTPException, Request

from ..models.schemas import RollbackRequest, RoundRequest
from .dependencies import get_router

router = APIRouter(prefix="/api", tags=["round"])


@router.post("/round/start")
async def start_round(req: RoundRequest, request: Request):
    r = get_router(request)
    if r.phase.value == "running":
        raise HTTPException(status_code=409, detail="对话正在运行中")
    turns = min(max(1, req.turns), 20)
    outputs = []
    events_gen = r.run_round() if turns == 1 else r.run_auto_rounds(turns=turns)
    async for event in events_gen:
        await r._emit(event.event_type, event.data)
        if event.event_type == "round_complete":
            outputs.append(event.data)
    return {"status": "ok", "turns": turns, "events": len(outputs)}


@router.post("/round/rollback")
async def rollback_round(req: RollbackRequest, request: Request):
    r = get_router(request)
    if not r.rollback_to_round(req.round):
        raise HTTPException(status_code=400, detail=f"无法回退到第 {req.round} 轮")
    return {"status": "ok", "current_round": r.current_round}


@router.get("/round/status")
async def get_round_status(request: Request):
    r = get_router(request)
    return {
        "round": r.current_round,
        "track_config": r.current_track_config.to_dict() if r.current_track_config else None,
        "track_history": r.track_history[-10:] if r.track_history else [],
        "round_phase": r.round_phase.value if r.round_phase else "idle",
        "agents": list(r.agents.keys()),
        "scene": r.current_scene,
    }
