"""
JWT auth middleware for API protection.
Simple implementation: checks Bearer token in Authorization header.
"""

import os
import secrets
from datetime import datetime, timedelta
from typing import Optional

from fastapi import HTTPException, Request
from jose import JWTError, jwt

# Simple key — rotate in production
SECRET_KEY = os.environ.get("JWT_SECRET", secrets.token_hex(32))
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 7


def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def verify_token(token: str) -> Optional[dict]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except JWTError:
        return None


def get_current_user(request: Request) -> Optional[str]:
    """Extract user_id from Authorization header. Returns None if no auth."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[7:]
    payload = verify_token(token)
    if payload is None:
        return None
    return payload.get("sub")  # user_id


def get_current_namespace(request: Request) -> str:
    """Extract namespace from JWT. Returns 'global' for missing/invalid."""
    from ..services.namespace import GLOBAL_NS
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return GLOBAL_NS
    token = auth[7:]
    payload = verify_token(token)
    if payload is None:
        return GLOBAL_NS
    return payload.get("namespace", GLOBAL_NS)


# List of paths that don't require auth
PUBLIC_PATHS = {
    "/api/auth/verify",
    "/api/auth/login",
    "/api/state",  # temporary for testing
    "/",
    "/assets",
}


async def auth_middleware(request: Request, call_next):
    """FastAPI middleware: check JWT for protected paths."""
    path = request.url.path

    # Skip public paths
    if any(path.startswith(p) for p in PUBLIC_PATHS):
        return await call_next(request)

    # Check auth
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else ""
    payload = verify_token(token) if token else None
    if payload is None:
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=401,
            content={"detail": "未授权，请先使用邀请码登录"},
        )

    # Attach user and namespace to request state
    from ..services.namespace import GLOBAL_NS
    ns = payload.get("namespace", GLOBAL_NS)
    request.state.user_id = payload.get("sub")
    request.state.namespace = ns
    print(f'[Auth] Set namespace={ns} for path={path}')
    return await call_next(request)
