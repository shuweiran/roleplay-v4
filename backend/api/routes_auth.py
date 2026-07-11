"""
Auth routes — invite code verification and token management.
"""

import os

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..middleware.auth import create_access_token, verify_token
from ..services.invite_service import verify_code, use_code, generate_codes, list_codes, deactivate_code
from ..services.namespace import namespace_from_code, ensure_namespace

router = APIRouter(prefix="/api/auth", tags=["auth"])

ADMIN_KEY = os.environ.get("ROLEPLAY_ADMIN_KEY", "admin-secret-change-me")


def _require_admin(request: Request):
    """Verify admin access via Bearer token or X-Admin-Key header."""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        payload = verify_token(auth[7:])
        if payload:
            return payload.get("sub")
    admin_key = request.headers.get("X-Admin-Key", "")
    if admin_key and admin_key == ADMIN_KEY:
        return "admin"
    raise HTTPException(status_code=403, detail="需要管理员权限。请提供 X-Admin-Key 或有效的 Bearer token。")


class VerifyRequest(BaseModel):
    code: str


class VerifyResponse(BaseModel):
    token: str
    user_id: str
    message: str


class GenerateRequest(BaseModel):
    count: int = 5
    max_uses: int = 1
    expires_days: int = 30
    note: str = ""


@router.post("/verify", response_model=VerifyResponse)
async def verify_invite(req: VerifyRequest):
    """Verify an invite code and return a JWT token."""
    result = verify_code(req.code)
    if result is None:
        raise HTTPException(status_code=403, detail="邀请码无效或已过期")

    user_id = result["user_id"]
    code = result["code"]

    # Look up the code's note for namespace isolation
    from ..services import invite_service
    invite_note = ""
    for c in invite_service.list_codes():
        if c["code"] == code:
            invite_note = c.get("note", "")
            break

    namespace = namespace_from_code(code, invite_note)
    ensure_namespace(namespace)

    # Mark code as used
    use_code(code, user_id)

    # Create JWT with namespace
    token = create_access_token({"sub": user_id, "namespace": namespace})

    return VerifyResponse(
        token=token,
        user_id=user_id,
        message="验证成功",
    )


@router.get("/me")
async def get_me(request: Request):
    """Get current user info from token."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未登录")
    payload = verify_token(auth[7:])
    if payload is None:
        raise HTTPException(status_code=401, detail="Token 无效或已过期")
    return {"user_id": payload.get("sub"), "exp": payload.get("exp")}


# Admin endpoints — for the host to manage invite codes
@router.post("/admin/generate")
async def admin_generate(req: GenerateRequest, _admin: str = Depends(_require_admin)):
    """Generate invite codes (host only)."""
    codes = generate_codes(
        count=req.count,
        max_uses=req.max_uses,
        expires_days=req.expires_days,
        note=req.note,
    )
    return {"codes": codes, "count": len(codes)}


@router.get("/admin/list")
async def admin_list(_admin: str = Depends(_require_admin)):
    """List all invite codes."""
    return {"codes": list_codes()}


@router.post("/admin/deactivate")
async def admin_deactivate(code: str, _admin: str = Depends(_require_admin)):
    """Deactivate an invite code."""
    if deactivate_code(code):
        return {"status": "ok", "code": code}
    raise HTTPException(status_code=404, detail="邀请码不存在")
