"""
Track Request routes — 角色自主轨道变更申请
角色在对话中通过 LLM 自主判断提交申请，主控在后台静默审批。
不显示在前端，不同步到对话上下文。
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..core.track_request import (
    request_manager,
    TRACK_STRENGTH,
)

router = APIRouter(prefix="/api/track", tags=["track"])


class TrackChangeRequestModel(BaseModel):
    """角色提交轨道变更申请"""
    agent_name: str
    target_agent: str = ""
    current_mode: str = "isolated"
    target_mode: str = "merged"
    reason: str = ""


@router.post("/request")
async def submit_track_request(req: TrackChangeRequestModel, request: Request):
    """角色提交轨道变更申请（由 AI 角色在对话中自主触发）"""
    if not req.agent_name.strip():
        raise HTTPException(status_code=400, detail="角色名不能为空")
    if req.current_mode not in TRACK_STRENGTH:
        raise HTTPException(status_code=400, detail=f"无效的当前轨道模式: {req.current_mode}")
    if req.target_mode not in TRACK_STRENGTH:
        raise HTTPException(status_code=400, detail=f"无效的目标轨道模式: {req.target_mode}")

    result = request_manager.submit_request(
        agent_name=req.agent_name,
        target_agent=req.target_agent,
        current_mode=req.current_mode,
        target_mode=req.target_mode,
        reason=req.reason,
    )

    return {
        "status": "ok",
        "request": result.to_dict(),
        "auto_approved": result.status.value == "auto_approved",
        "message": "断链申请已自动处理" if result.status.value == "auto_approved" else "申请已提交，将在下一轮由主控审批",
    }


@router.get("/requests")
async def list_requests():
    """查看所有申请记录"""
    pending = [r.to_dict() for r in request_manager.get_pending_requests()]
    resolved = [r.to_dict() for r in request_manager.get_resolved_requests(limit=10)]
    return {
        "pending": pending,
        "resolved": resolved,
        "pending_count": len(pending),
    }
