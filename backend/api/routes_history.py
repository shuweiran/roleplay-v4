"""History routes with server-side filtering."""

import os
from fastapi import APIRouter, HTTPException, Query, Request

from ..core.persona import Persona
from .dependencies import get_router, get_session_manager

router = APIRouter(prefix="/api", tags=["history"])


@router.get("/history/sessions")
async def list_sessions(request: Request):
    """List all saved sessions with metadata."""
    session_mgr = get_session_manager(request)
    sessions_dir = session_mgr._dir
    if not os.path.isdir(sessions_dir):
        return {"sessions": []}
    files = [f for f in os.listdir(sessions_dir) if f.endswith(".json") and not f.endswith("_archive.json")]
    files.sort(reverse=True)
    sessions = []
    for fname in files[:50]:  # max 50 sessions
        path = os.path.join(sessions_dir, fname)
        try:
            session = session_mgr.load(fname.replace(".json", ""))
            if session:
                # Derive scene title from messages
                scene_title = ''
                for m in session.messages[:5]:
                    content = getattr(m, 'content', '') or ''
                    if '【场景】' in content:
                        # Extract first meaningful line after 【场景】
                        after = content.split('【场景】', 1)[-1].strip()
                        # Take first line or up to first 

                        first_line = after.split('\n')[0].strip()
                        # Remove trailing location description after full-width colon
                        if '：' in first_line:
                            first_line = first_line.split('：')[0].strip()
                        scene_title = first_line[:40]
                        break
                if not scene_title and session.agent_names:
                    scene_title = '、'.join(session.agent_names[:3])
                    if len(session.agent_names) > 3:
                        scene_title += '…'
                
                sessions.append({
                    "session_id": session.session_id,
                    "created_at": getattr(session, 'created_at', ''),
                    "updated_at": getattr(session, 'updated_at', ''),
                    "round_count": session.round_count,
                    "message_count": len(session.messages),
                    "agent_names": session.agent_names,
                    "scene_title": scene_title,
                })
        except Exception as e:
            print(f"[History] Failed to load session {fname}: {e}")
    return {"sessions": sessions}


@router.get("/history/sessions/{session_id}")
async def get_session_messages(
    request: Request,
    session_id: str,
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    """Get messages for a specific session."""
    session_mgr = get_session_manager(request)
    session = session_mgr.load(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    messages = [m.to_dict() for m in session.messages]
    paginated = messages[offset:offset + limit]
    return {
        "session_id": session.session_id,
        "messages": paginated,
        "total": len(messages),
        "round_logs": getattr(session, 'round_log', [])[-20:],
    }


@router.post("/history/load/{session_id}")
async def load_session(request: Request, session_id: str):
    """Load a saved session into the current router."""
    session_mgr = get_session_manager(request)
    session_data = session_mgr.load(session_id)
    if not session_data:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    
    router = get_router(request)
    
    # Save current session before loading new one
    if router.memory and router.memory.session:
        try:
            session_mgr.save(router.memory.session)
        except Exception as e:
            print(f"[History] Failed to save current session: {e}")
    
    # Load session into memory
    router.memory.load_session_data(session_data)
    router.session_id = session_data.session_id
    router.current_round = session_data.round_count
    # Reset mode to 'free' to prevent player_name filter in history
    router.config.mode.mode = 'free'
    router.config.mode.director_character = ''
    
    # Rebuild agents from session agent_names
    router.agents = {}
    for name in session_data.agent_names:
        if name in router._saved_characters:
            p = router._saved_characters[name]
        else:
            p = Persona(name=name, persona=f"{name}，一个角色")
            router.save_character(p)
        from ..core.agent import Agent
        from .dependencies import get_llm_client
        router.agents[name] = Agent(
            p, name,
            llm_client=get_llm_client(request),
            llm_config=router.config.llm,
            monitor=router.monitor,
        )
    
    return {
        "status": "ok",
        "session_id": session_data.session_id,
        "round": session_data.round_count,
        "agents": list(router.agents.keys()),
        "message_count": len(session_data.messages),
    }


@router.get("/history")
async def get_history(
    request: Request,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    character: str = Query(default=""),
    round_num: int = Query(default=0, ge=0, alias="round"),
    player_name: str = Query(default="", description="Filter by player visibility (werewolf mode)"),
):
    """Get conversation history with optional filters (server-side).

    Supports ?character=, ?round=N, ?limit=, ?offset=, ?player_name=.
    player_name filters messages visible to a specific player (werewolf isolation).
    """
    router = get_router(request)
    messages = router.get_conversation_history()
    round_logs = router.get_round_logs()

    filtered = []
    
    # Check if player is dead in werewolf mode → spectator mode (see all)
    is_spectator = False
    werewolf_state = getattr(router, '_werewolf_state', None)
    if player_name and werewolf_state:
        eliminated_names = [e.get('name', '') for e in (werewolf_state.eliminated or [])]
        if player_name in eliminated_names:
            is_spectator = True
    
    for m in messages:
        d = m.to_dict()
        if character and d.get("name") != character:
            continue
        if round_num > 0 and d.get("round_number", 0) != round_num:
            continue
        # Player visibility filter (werewolf isolation)
        # Dead players are spectators — they see everything
        if player_name and not is_spectator:
            visible_to = d.get("visible_to", [])
            if visible_to and player_name not in visible_to:
                continue
        filtered.append(d)

    paginated = filtered[offset:offset + limit]
    return {
        "messages": paginated,
        "total": len(filtered),
        "round_logs": round_logs[-20:],
    }
