"""Config routes — API key management from frontend."""
from fastapi import APIRouter, Request
from pydantic import BaseModel
from ..config import save_api_key, load_api_key

router = APIRouter(prefix="/api/config", tags=["config"])


class ApiKeyRequest(BaseModel):
    api_key: str
    api_base: str = ""
    model: str = ""


@router.get("/apikey")
async def get_api_key(request: Request):
    """Get current API key config (masked)."""
    config = request.app.state.config
    key = config.llm.api_key
    masked = key[:8] + "..." + key[-4:] if len(key) > 12 else "***"
    return {
        "api_key": masked,
        "api_base": config.llm.api_base,
        "model": config.llm.model,
        "has_key": bool(config.llm.api_key and config.llm.api_key != "***")
    }


@router.post("/apikey")
async def set_api_key(req: ApiKeyRequest, request: Request):
    """Save new API key and update runtime config."""
    save_api_key(req.api_key, req.api_base or "", req.model or "")
    # Update runtime config
    config = request.app.state.config
    config.llm.api_key = req.api_key
    if req.api_base:
        config.llm.api_base = req.api_base
    if req.model:
        config.llm.model = req.model
    # Recreate LLM client with new key
    from ..services.llm_client import LLMClient
    from ..core.monitor import Monitor
    monitor = request.app.state.monitor
    request.app.state.llm_client = LLMClient(config.llm, monitor, config.monitor)
    return {"status": "ok", "message": "API key updated successfully"}
