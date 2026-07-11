"""Config routes — API key & model management from frontend."""

from fastapi import APIRouter, Request
from pydantic import BaseModel
from ..config import save_api_key, load_api_key, AppConfig

router = APIRouter(prefix="/api/config", tags=["config"])

# ── Model recommendations ──────────────────────────────────────
MODEL_RECOMMENDATIONS = [
    {
        "id": "deepseek-chat",
        "name": "DeepSeek V3",
        "provider": "DeepSeek",
        "base_url": "https://api.deepseek.com",
        "description": "适合日常角色扮演对话，速度快、成本低",
        "strengths": ["快速响应", "性价比高", "中文支持好"],
        "suitable_for": ["自由模式", "主角模式", "导演模式"]
    },
    {
        "id": "deepseek-reasoner",
        "name": "DeepSeek R1",
        "provider": "DeepSeek",
        "base_url": "https://api.deepseek.com",
        "description": "擅长复杂推理和逻辑判断，适合策略性游戏",
        "strengths": ["逻辑推理强", "策略决策", "复杂剧情"],
        "suitable_for": ["狼人杀模式", "多线模式", "剧本杀模式"]
    },
    {
        "id": "claude-sonnet-4-20250514",
        "name": "Claude Sonnet 4",
        "provider": "Anthropic",
        "base_url": "https://api.anthropic.com",
        "description": "角色扮演表现优秀，情感丰富、文笔细腻",
        "strengths": ["情感表达", "文笔优美", "角色一致性"],
        "suitable_for": ["自由模式", "导演模式", "主角模式"]
    },
    {
        "id": "claude-haiku-3-5-20241022",
        "name": "Claude Haiku 3.5",
        "provider": "Anthropic",
        "base_url": "https://api.anthropic.com",
        "description": "轻量快速，适合简单对话场景，成本低",
        "strengths": ["极速响应", "低成本", "轻量对话"],
        "suitable_for": ["快速测试", "简单角色扮演"]
    },
    {
        "id": "gpt-4o",
        "name": "GPT-4o",
        "provider": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "description": "全能型模型，各方面表现均衡，支持多模态",
        "strengths": ["全面均衡", "多模态", "稳定性好"],
        "suitable_for": ["自由模式", "狼人杀模式", "导演模式"]
    },
    {
        "id": "gpt-4o-mini",
        "name": "GPT-4o Mini",
        "provider": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "description": "轻量化模型，成本低，适合高频对话",
        "strengths": ["低成本", "高并发", "快速响应"],
        "suitable_for": ["日常对话", "简单场景"]
    }
]


class ApiKeyRequest(BaseModel):
    api_key: str
    api_base: str = ""
    model: str = ""
    language: str = "zh"
    track_activity: str = "auto"


@router.get("/apikey")
async def get_api_key(request: Request):
    """Get current API key config (masked)."""
    config = request.app.state.config
    key = config.llm.api_key or ""
    masked = key[:8] + "..." + key[-4:] if len(key) > 12 else ("***" if not key else key[:4]+"...")
    return {
        "api_key": masked,
        "api_base": config.llm.api_base,
        "model": config.llm.model,
        "has_key": bool(config.llm.api_key and config.llm.api_key != "***"),
        "language": getattr(config.mode, 'language', 'zh'),
        "track_activity": getattr(config.mode, 'track_activity', 'auto'),
    }


@router.post("/apikey")
async def set_api_key(req: ApiKeyRequest, request: Request):
    """Save new API key and update runtime config."""
    save_api_key(req.api_key, req.api_base or "", req.model or "")
    config: AppConfig = request.app.state.config
    config.llm.api_key = req.api_key
    if req.api_base:
        config.llm.api_base = req.api_base
    if req.model:
        config.llm.model = req.model
    if req.language:
        config.mode.language = req.language
    if req.track_activity:
        config.mode.track_activity = req.track_activity
    # Recreate LLM client
    from ..services.llm_client import LLMClient
    monitor = getattr(request.app.state, "monitor", None)
    if monitor is None:
        from ..core.monitor import Monitor
        monitor = Monitor(config.monitor)
        request.app.state.monitor = monitor
    request.app.state.llm_client = LLMClient(config.llm, monitor, config.monitor)
    return {"status": "ok", "message": "API Key 已保存并生效"}


class LanguageRequest(BaseModel):
    language: str = "zh"


@router.get("/language")
async def get_language(request: Request):
    """Get current language setting."""
    lang = getattr(request.app.state.config.mode, 'language', 'zh')
    return {"language": lang}


@router.post("/language")
async def set_language(req: LanguageRequest, request: Request):
    """Set language for TTS voice selection and UI."""
    request.app.state.config.mode.language = req.language
    return {"status": "ok", "language": req.language}


@router.get("/models")
async def get_model_recommendations():
    """Get model recommendations with descriptions."""
    return {"models": MODEL_RECOMMENDATIONS}


class VoiceConfigRequest(BaseModel):
    voice_enabled: bool = False


@router.get("/voice")
async def get_voice_config(request: Request):
    r = getattr(request.app.state, "router", None)
    enabled = getattr(r, "voice_enabled", False) if r else False
    return {"voice_enabled": enabled}


@router.post("/voice")
async def set_voice_config(req: VoiceConfigRequest, request: Request):
    r = getattr(request.app.state, "router", None)
    if r:
        r.voice_enabled = req.voice_enabled
    return {"status": "ok", "voice_enabled": req.voice_enabled}
