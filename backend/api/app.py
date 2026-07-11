"""
FastAPI application factory with lifespan-managed shared resources.

v4 improvement over v3: Single shared LLMClient created at startup,
injected into all Agent/Arbiter instances via Router.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from ..config import AppConfig
from ..middleware.auth import auth_middleware
from ..services.llm_client import LLMClient
from ..services.persistence import AtomicFileStorage, CharacterStore, SceneStore
from ..services.session_manager import SessionManager
from ..core.monitor import Monitor

from .routes_characters import router as characters_router
from .routes_scenes import router as scenes_router
from .routes_round import router as round_router
from .routes_session import router as session_router
from .routes_sse import broadcast_event, router as sse_router
from .routes_history import router as history_router
from .routes_auth import router as auth_router
from .routes_room import router as room_router
from .routes_voice import router as voice_router
from .routes_config import router as config_router
from .routes_track import router as track_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Create shared resources at startup, clean up at shutdown."""
    config: AppConfig = app.state.config

    # Shared infrastructure
    monitor = Monitor(budget=config.monitor.budget_usd)
    llm_client = LLMClient(config.llm, monitor, config.monitor)
    storage = AtomicFileStorage()

    data_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
    char_store = CharacterStore(os.path.join(data_dir, "characters"), storage)
    scene_store = SceneStore(os.path.join(data_dir, "scenes"), storage)
    session_manager = SessionManager(os.path.join(data_dir, "sessions"), storage)

    # Store on app.state
    app.state.llm_client = llm_client
    app.state.char_store = char_store
    app.state.scene_store = scene_store
    app.state.session_manager = session_manager
    app.state.monitor = monitor
    app.state.router = None  # Created on first init
    app.state.sse_broadcast = broadcast_event  # SSE hook for Router

    yield

    # Shutdown: clean up HTTP connections
    await llm_client.close()


def create_app(config: AppConfig = None) -> FastAPI:
    """Create the FastAPI application with all routes registered."""
    config = config or AppConfig()

    app = FastAPI(
        title="Roleplay v4",
        version="4.0.0",
        description="Multi-Agent Roleplay System with Track-Based Routing",
        lifespan=lifespan,
    )
    app.state.config = config

    # CORS
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Auth middleware 鈥?inline @app.middleware (FastAPI 0.136 + Starlette 1.0 compatible)
    PUBLIC_PATHS = {"/api/auth/verify", "/api/auth/login", "/api/state", "/", "/assets"}
    
    @app.middleware("http")
    async def auth_mw(request: Request, call_next):
        path = request.url.path
        if any(path.startswith(p) for p in PUBLIC_PATHS):
            return await call_next(request)
        auth = request.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        from ..middleware.auth import verify_token
        payload = verify_token(token) if token else None
        if payload is None:
            from fastapi.responses import JSONResponse
            return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
        from ..services.namespace import GLOBAL_NS
        request.state.user_id = payload.get("sub")
        request.state.namespace = payload.get("namespace", GLOBAL_NS)
        return await call_next(request)

    # Register API routes
    app.include_router(characters_router)
    app.include_router(scenes_router)
    app.include_router(round_router)
    app.include_router(session_router)
    app.include_router(sse_router)
    app.include_router(history_router)
    app.include_router(auth_router)
    app.include_router(room_router)
    app.include_router(voice_router)
    app.include_router(config_router)
    app.include_router(track_router)

    # Static files / SPA
    roleplay_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    dist_dir = Path(roleplay_dir) / config.frontend.dist_dir
    if dist_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(dist_dir / "assets")), name="assets")

    static_dir = os.path.join(os.path.dirname(__file__), "static")
    if os.path.isdir(static_dir):
        app.mount("/static", StaticFiles(directory=static_dir), name="static")

    # Serve frontend in dev or prod mode
    @app.get("/")
    async def root():
        """Serve the frontend SPA."""
        roleplay_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        # Try Vite dist first (production)
        dist_index = Path(roleplay_dir) / config.frontend.dist_dir / "index.html"
        if dist_index.exists():
            return HTMLResponse(dist_index.read_text(encoding="utf-8"))

        # Try static/index.html
        index_path = Path(roleplay_dir) / "web" / "static" / "index.html"
        if index_path.exists():
            return HTMLResponse(index_path.read_text(encoding="utf-8"))

        return {"message": "Roleplay v4 API 鈥?Frontend not found. Run Vite dev server or build the frontend."}

    return app

