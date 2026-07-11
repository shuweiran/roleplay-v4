"""
FastAPI dependency injection.

All shared services (LLMClient, stores, session_manager, Router)
are stored on app.state during lifespan startup and accessed via
these dependency functions.
"""

from __future__ import annotations

from typing import Dict, Optional

from fastapi import HTTPException, Request

from ..config import AppConfig
from ..core.router import Router
from ..services.llm_client import LLMClient
from ..services.persistence import CharacterStore, SceneStore, AtomicFileStorage
from ..services.session_manager import SessionManager
from ..services.namespace import namespace_path


def get_config(request: Request) -> AppConfig:
    return request.app.state.config


def get_llm_client(request: Request) -> LLMClient:
    return request.app.state.llm_client


def get_namespace(request: Request) -> str:
    """Get namespace from JWT in request header.
    Falls back to request.state (set by auth middleware, if present),
    then to GLOBAL_NS.
    """
    from ..services.namespace import GLOBAL_NS
    # Try middleware-set state first
    ns = getattr(request.state, 'namespace', None)
    if ns:
        return ns
    # Fallback: parse JWT directly from Authorization header
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        from ..middleware.auth import verify_token
        payload = verify_token(auth[7:])
        if payload:
            return payload.get("namespace", GLOBAL_NS)
    return GLOBAL_NS


def get_character_store(request: Request) -> CharacterStore:
    """Get namespace-aware character store."""
    ns = get_namespace(request)
    key = f'_ns_char_{ns}'
    cache: Dict = request.app.state
    if hasattr(cache, key):
        return getattr(cache, key)
    store = CharacterStore(namespace_path(ns, 'characters'), AtomicFileStorage())
    setattr(cache, key, store)
    return store


def get_scene_store(request: Request) -> SceneStore:
    """Get namespace-aware scene store."""
    ns = get_namespace(request)
    key = f'_ns_scene_{ns}'
    cache: Dict = request.app.state
    if hasattr(cache, key):
        return getattr(cache, key)
    store = SceneStore(namespace_path(ns, 'scenes'), AtomicFileStorage())
    setattr(cache, key, store)
    return store


def get_session_manager(request: Request) -> SessionManager:
    """Get namespace-aware session manager."""
    ns = get_namespace(request)
    key = f'_ns_sess_{ns}'
    cache: Dict = request.app.state
    if hasattr(cache, key):
        return getattr(cache, key)
    store = SessionManager(namespace_path(ns, 'sessions'), AtomicFileStorage())
    setattr(cache, key, store)
    return store


def get_router(request: Request) -> Router:
    """Get the current router. Creates one if not initialized.
    Automatically registers SSE broadcast callback on first access.
    """
    router = getattr(request.app.state, "router", None)
    if router is None:
        raise HTTPException(status_code=400, detail="系统未初始化，请先创建角色或加载配置。")

    # Register SSE broadcast if available and not already registered
    broadcast_fn = getattr(request.app.state, "sse_broadcast", None)
    if broadcast_fn and broadcast_fn not in router._event_callbacks:
        router._event_callbacks.append(broadcast_fn)

    # Ensure router's stores match current namespace
    ns = get_namespace(request)
    if getattr(router, '_ns', None) != ns:
        router._ns = ns
        char_store = get_character_store(request)
        scene_store = get_scene_store(request)
        session_mgr = get_session_manager(request)
        router._char_store = char_store
        router._scene_store = scene_store
        router._session_manager = session_mgr
        # Reload cache from namespace-specific stores
        router._saved_characters = {}
        for d in char_store.list_full():
            from ..core.persona import Persona
            p = Persona.from_dict(d)
            router._saved_characters[p.name] = p
        router._saved_scenes = {}
        for d in scene_store.list_all():
            router._saved_scenes[d['scene_id']] = d
        
        # If namespace is empty, seed with preset characters and scenes
        if not router._saved_characters and not router._saved_scenes:
            print(f"[Router] Seeding empty namespace: {ns}")
            import os, json
            back_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'backend')
            # Load preset profiles
            profile_path = os.path.join(back_dir, 'profiles', '经典人格.json')
            if os.path.exists(profile_path):
                from ..core.persona import load_personas_from_file
                for p in load_personas_from_file(profile_path):
                    if p.name not in router._saved_characters:
                        router.save_character(p)
            # Load preset scenes
            scene_path = os.path.join(back_dir, 'scenes', '经典场景.json')
            if os.path.exists(scene_path):
                with open(scene_path, 'r', encoding='utf-8') as f:
                    for sc in json.load(f):
                        sid = sc.get('scene_id', '')
                        if sid not in router._saved_scenes:
                            router.save_scene(sid, sc.get('name', ''), sc.get('description', ''), sc.get('initial_agent_names', []))
            # Reload after seeding
            router._saved_characters = {}
            for d in char_store.list_full():
                from ..core.persona import Persona
                p = Persona.from_dict(d)
                router._saved_characters[p.name] = p
            router._saved_scenes = {}
            for d in scene_store.list_all():
                router._saved_scenes[d['scene_id']] = d
        
        print(f"[Router] Switched to namespace: {ns} ({len(router._saved_characters)} chars, {len(router._saved_scenes)} scenes)")

    # Also ensure namespace on router's memory session manager
    if hasattr(router, 'memory') and router.memory:
        router.memory._sm = get_session_manager(request)

    return router
