"""Session routes — state, init, send, stop, mode, goals, agents."""

import asyncio

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..core.persona import Persona
from ..core.router import Router
from ..models.schemas import (
    AgentRequest, GoalsRequest, InitRequest, ModeRequest, SendRequest,
    NightActionRequest, VoteRequest, WerewolfStatusResponse, WerewolfEliminatedInfo,
    PrivateChatRequest, PrivateChatReply, PrivateChatSendRequest,
    ScriptGenerateRequest, ScriptLoadRequest, ScriptLoadResponse,
)
from .dependencies import get_character_store, get_llm_client, get_router, get_scene_store, get_session_manager

router = APIRouter(prefix="/api", tags=["session"])

@router.get("/state")
async def get_state(request: Request):
    r = getattr(request.app.state, "router", None)
    if r is None:
        llm_client = get_llm_client(request)
        char_store = get_character_store(request)
        scene_store = get_scene_store(request)
        session_mgr = get_session_manager(request)
        r = Router(config=request.app.state.config, llm_client=llm_client,
                    character_store=char_store, scene_store=scene_store,
                    session_manager=session_mgr)
        request.app.state.router = r
        saved = char_store.list_full()
        if saved:
            personas = [Persona.from_dict(d) for d in saved[:2]]
            for p in personas:
                r.save_character(p)
            await r.init_with_characters(personas)
        else:
            p1 = Persona(name="苏哲", persona="理性冷静的哲学家")
            p2 = Persona(name="林诗", persona="敏感浪漫的诗人")
            r.save_character(p1); r.save_character(p2)
            await r.init_with_characters([p1, p2])

    return {"initialized": True, "router": r.get_state(),
            "characters": r.get_characters(), "scenes": r.get_scenes()}

@router.post("/init")
async def initialize(req: InitRequest, request: Request):
    r = getattr(request.app.state, "router", None)
    llm_client = get_llm_client(request)
    if r is None:
        r = Router(config=request.app.state.config, llm_client=llm_client,
                    character_store=get_character_store(request),
                    scene_store=get_scene_store(request),
                    session_manager=get_session_manager(request))
        request.app.state.router = r

    if req.persona_file:
        import os
        profiles_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "profiles")
        filepath = os.path.join(profiles_dir, req.persona_file)
        if not os.path.exists(filepath):
            raise HTTPException(status_code=404, detail=f"File not found: {req.persona_file}")
        from ..core.persona import load_personas_from_file
        characters = load_personas_from_file(filepath)
    else:
        saved = get_character_store(request).list_full()
        characters = [Persona.from_dict(d) for d in saved[:2]] if saved else [
            Persona(name="苏哲", persona="理性冷静的哲学家"),
            Persona(name="林诗", persona="敏感浪漫的诗人")]

    for p in characters:
        r.save_character(p)
    await r.init_with_characters(characters, scene_id=req.scene_id or None,
                                  session_id=req.session_id or "", resume=req.resume)
    return {"status": "ok", "session_id": r.session_id,
            "agents": list(r.agents.keys()), "scene": r.current_scene}

@router.post("/send")
async def send_message(req: SendRequest, request: Request):
    r = get_router(request)
    active_task = getattr(request.app.state, "active_conversation_task", None)
    if r.phase.value == "running" or (active_task and not active_task.done()):
        raise HTTPException(status_code=409, detail="对话正在运行中")
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="消息不能为空")

    player_name = req.player_name  # for werewolf mode: human player speaks as this character

    async def process():
        try:
            async for event in r.handle_user_input(text, player_name=player_name):
                await r._emit(event.event_type, event.data)
        finally:
            if getattr(request.app.state, "active_conversation_task", None) is asyncio.current_task():
                request.app.state.active_conversation_task = None

    task = asyncio.create_task(process())
    request.app.state.active_conversation_task = task
    return {"status": "ok", "message": text, "round": r.current_round}

@router.post("/stop")
async def stop_conversation(request: Request):
    get_router(request).stop()
    active_task = getattr(request.app.state, "active_conversation_task", None)
    if active_task and not active_task.done():
        active_task.cancel()
    request.app.state.active_conversation_task = None
    return {"status": "ok"}

@router.post("/auto")
async def start_auto(turns: int = 3, request: Request = None):
    r = get_router(request)
    active_task = getattr(request.app.state, "active_conversation_task", None)
    if r.phase.value == "running" or (active_task and not active_task.done()):
        raise HTTPException(status_code=409, detail="对话正在运行中")

    async def process():
        try:
            async for event in r.run_auto_rounds(turns=turns):
                await r._emit(event.event_type, event.data)
        except Exception as e:
            import traceback
            print(f'[AUTO_ERROR] Exception in auto rounds: {e}')
            traceback.print_exc()
        finally:
            if getattr(request.app.state, "active_conversation_task", None) is asyncio.current_task():
                request.app.state.active_conversation_task = None

    task = asyncio.create_task(process())
    request.app.state.active_conversation_task = task
    return {"status": "ok", "turns": turns}

@router.post("/mode")
async def set_mode(req: ModeRequest, request: Request):
    config = request.app.state.config
    old_mode = config.mode.mode

    r = getattr(request.app.state, "router", None)
    if r and old_mode != req.mode:
        r._switch_mode(req.mode)

    config.mode.mode = req.mode
    config.mode.protagonist = req.protagonist
    config.mode.director_character = req.director_character
    config.mode.advanced_tracks = req.advanced_tracks

    if req.mode == "werewolf" and not req.director_character:
        config.mode.director_character = "系统"

    return {"status": "ok", "mode": config.mode.mode, "protagonist": config.mode.protagonist,
            "director_character": config.mode.director_character}

@router.get("/mode")
async def get_mode(request: Request):
    config = request.app.state.config
    return {"mode": config.mode.mode, "protagonist": config.mode.protagonist,
            "director_character": config.mode.director_character}

@router.post("/goals")
async def set_goals(req: GoalsRequest, request: Request):
    get_router(request).set_goals(req.goals)
    return {"status": "ok", "goals": req.goals}

@router.get("/goals")
async def get_goals(request: Request):
    return {"goals": get_router(request).get_goals()}

@router.post("/agents")
async def add_agent(req: AgentRequest, request: Request):
    r = get_router(request)
    if req.name not in r._saved_characters:
        raise HTTPException(status_code=404, detail=f"角色 '{req.name}' 不存在")
    from ..core.agent import Agent
    r.agents[req.name] = Agent(r._saved_characters[req.name], req.name,
                                r.config.llm, llm_client=get_llm_client(request))
    return {"status": "ok"}

@router.delete("/agents/{name}")
async def remove_agent(name: str, request: Request):
    r = get_router(request)
    if name not in r.agents:
        raise HTTPException(status_code=404, detail=f"代理 '{name}' 不在会话中")
    del r.agents[name]
    return {"status": "ok"}

# ── Werewolf API endpoints ───────────────────────────────────────────

@router.post("/werewolf/night_action")
async def werewolf_night_action(req: NightActionRequest, request: Request):
    """Submit a night action for a human player."""
    r = get_router(request)
    if not r._werewolf_state:
        raise HTTPException(status_code=400, detail="狼人杀游戏未初始化")
    if r._werewolf_state.phase != "night":
        raise HTTPException(status_code=400, detail="当前不是夜间阶段")

    player_name = req.player_name
    if player_name not in r._werewolf_human_players:
        raise HTTPException(status_code=400, detail=f"玩家 '{player_name}' 不是真人玩家")

    role = r._werewolf_state.role_assignments.get(player_name, "")
    valid_actions = {
        "wolf": ["kill"],
        "seer": ["check"],
        "witch": ["save", "poison"],
    }
    allowed = valid_actions.get(role, [])
    if req.action_type not in allowed:
        raise HTTPException(status_code=400,
            detail=f"你的身份是{role}，只能执行 {'/'.join(allowed)} 类型的夜间行动")

    from ..models.domain import NightAction
    action = NightAction(
        action_type=req.action_type,
        target=req.target,
        source=player_name,
    )
    r._werewolf_state.night_actions.append(action)
    return {"status": "ok", "message": f"{player_name}的行动已记录：{req.action_type} → {req.target}"}

@router.post("/werewolf/vote")
async def werewolf_vote(req: VoteRequest, request: Request):
    """Submit a vote for a human player."""
    r = get_router(request)
    if not r._werewolf_state:
        raise HTTPException(status_code=400, detail="狼人杀游戏未初始化")
    if r._werewolf_state.phase not in ("voting", "judgment"):
        raise HTTPException(status_code=400, detail="当前不是投票阶段")

    player_name = req.player_name
    if player_name not in r._werewolf_human_players:
        raise HTTPException(status_code=400, detail=f"玩家 '{player_name}' 不是真人玩家")

    r._werewolf_state.votes[player_name] = req.target
    return {"status": "ok", "message": f"{player_name} 投票已记录 → {req.target}"}

@router.get("/werewolf/status")
async def werewolf_status(request: Request, player_name: str = ""):
    """Get the current werewolf game status.
    If player_name is provided, includes their role and role_hint (private).
    Otherwise returns public info only (no roles).
    """
    r = get_router(request)
    if not r._werewolf_state:
        return WerewolfStatusResponse(
            phase="not_started",
            alive_players=[],
            eliminated_players=[],
        )

    state = r._werewolf_state
    eliminated_list = [
        WerewolfEliminatedInfo(
            name=e["name"],
            reason=e.get("reason", "unknown"),
            round=e.get("round", 0),
        ) for e in state.eliminated
    ]

    your_role = None
    your_role_hint = None
    if player_name and player_name in state.role_assignments:
        your_role = state.role_assignments[player_name]
        your_role_hint = r._werewolf_role_hints.get(player_name, "")

    return WerewolfStatusResponse(
        phase=state.phase,
        round_number=state.round_number,
        alive_players=state.alive_players,
        eliminated_players=eliminated_list,
        winner=state.winner,
        your_role=your_role,
        roles={"hint": your_role_hint} if your_role_hint else {},
    )

@router.post("/werewolf/init")
async def werewolf_init(request: Request, player_name: str = "me", human_players: str = ""):
    """Initialize werewolf game. Accepts any role=count as query params."""
    r = get_router(request)

    # Parse human players
    human_names = [h.strip() for h in human_players.split(",") if h.strip()] if human_players else []
    if player_name and player_name not in human_names:
        human_names.append(player_name)
    if not human_names and player_name:
        human_names = [player_name]

    if len(r.agents) < 5:
        from ..core.persona import Persona
        from ..core.agent import Agent
        fallback_names = ["苏哲", "林诗", "老王", "小美", "阿强"]
        existing = set(r.agents.keys())
        if player_name:
            existing.add(player_name)
        for name in fallback_names:
            if name not in existing and len(r.agents) < 5:
                if name in r._saved_characters:
                    p = r._saved_characters[name]
                else:
                    p = Persona(name=name, persona="普通村民")
                    r.save_character(p)
                agent = Agent(
                    p, p.name,
                    llm_client=get_llm_client(request),
                    llm_config=r.config.llm,
                    monitor=r.monitor,
                )
                r.agents[p.name] = agent

    characters = [agent.persona for agent in r.agents.values()]
    existing_char_names = {c.name for c in characters}
    unique_new_humans = [h for h in human_names if h not in existing_char_names]
    total = len(characters) + len(unique_new_humans)
    if total < 5:
        raise HTTPException(status_code=400, detail=f"至少需要5个角色，当前只有{total}个")

    request.app.state.config.mode.mode = "werewolf"
    if not request.app.state.config.mode.director_character:
        request.app.state.config.mode.director_character = "系统"

    # Build role config from ALL query params (any role=count works)
    role_config = {}
    for key, values in request.query_params.multi_items():
        if key in ("player_name", "human_players"):
            continue
        try:
            count = int(values)
            if count > 0:
                role_config[key] = count
        except ValueError:
            pass

    r._init_werewolf_game(characters, human_player_names=human_names, role_config=role_config or None)

    return {
        "status": "ok",
        "players": list(r._werewolf_state.role_assignments.keys()),
        "player_count": len(r._werewolf_state.role_assignments),
    }

@router.post("/werewolf/setup")
async def werewolf_setup(request: Request, player_name: str = "me", human_players: str = ""):
    """Setup werewolf mode: switch mode, add human player, and initialize game."""
    config = request.app.state.config
    config.mode.mode = "werewolf"
    if not config.mode.director_character:
        config.mode.director_character = "系统"

    human_names = [h.strip() for h in human_players.split(",") if h.strip()] if human_players else []
    if player_name and player_name not in human_names:
        human_names.append(player_name)
    if not human_names and player_name:
        human_names = [player_name]

    r = get_router(request)
    characters = [agent.persona for agent in r.agents.values()]
    existing_names = {c.name for c in characters}
    new_humans = [h for h in human_names if h not in existing_names]
    total = len(characters) + len(new_humans)

    if total < 5:
        raise HTTPException(status_code=400, detail=f"至少需要5个角色（含真人玩家），当前{total}个")

    r._init_werewolf_game(characters, human_player_names=human_names)
    return {
        "status": "ok",
        "mode": "werewolf",
        "players": list(r._werewolf_state.role_assignments.keys()),
        "player_count": len(r._werewolf_state.role_assignments),
    }

# ── Private Chat API endpoints ────────────────────────────────────────

@router.post("/director/chat")
async def director_private_chat(req: PrivateChatRequest, request: Request):
    """Request a private chat with another character through the director."""
    r = get_router(request)
    result = await r.handle_private_chat_request(
        player_name=req.player_name,
        target=req.target,
        message=req.message,
    )
    return result

@router.post("/director/reply")
async def director_private_reply(req: PrivateChatReply, request: Request):
    """Director replies to a private chat request (allow or deny)."""
    r = get_router(request)
    if req.allowed:
        track_id, _ = r._create_private_track(
            req.player_name, req.target,
            request.app.state.config.mode.director_character,
        )
        return {"status": "ok", "allowed": True, "track_id": track_id, "reason": req.reason}
    else:
        return {"status": "ok", "allowed": False, "reason": req.reason}

@router.post("/private/send")
async def private_chat_send(req: PrivateChatSendRequest, request: Request):
    """Send a message in a private chat track."""
    r = get_router(request)
    result = await r.send_private_message(
        track_id=req.track_id,
        player_name=req.player_name,
        text=req.text,
    )
    return result

@router.delete("/private/{track_id}")
async def private_chat_end(track_id: str, request: Request):
    """End a private chat track."""
    r = get_router(request)
    ok = r.destroy_private_track(track_id)
    if not ok:
        raise HTTPException(status_code=404, detail="私聊轨道不存在")
    return {"status": "ok", "track_id": track_id}

@router.get("/private/tracks")
async def private_chat_list(request: Request, player_name: str = ""):
    """List active private chat tracks, optionally filtered by player."""
    r = get_router(request)
    tracks = r.get_private_tracks(player_name=player_name)
    return {"tracks": tracks}

# ── Script System API ───────────────────────────────────────────────

@router.post("/script/load")
async def script_load(req: ScriptLoadRequest, request: Request):
    """Load a script and initialize the game."""
    import json
    import os

    r = get_router(request)

    # Load script data from file or inline
    if req.script_data:
        script_data = req.script_data
    elif req.script_path:
        path = req.script_path
        if not os.path.isabs(path):
            path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "scripts", path)
        if not os.path.exists(path):
            raise HTTPException(status_code=404, detail=f"剧本文件不存在: {req.script_path}")
        with open(path, "r", encoding="utf-8") as f:
            ext = os.path.splitext(path)[1].lower()
            if ext in (".yaml", ".yml"):
                import yaml
                script_data = yaml.safe_load(f)
            elif ext == ".json":
                script_data = json.load(f)
            else:
                raise HTTPException(status_code=400, detail=f"不支持的剧本文件格式: {ext}")
    else:
        raise HTTPException(status_code=400, detail="请提供 script_path 或 script_data")

    result = await r.load_script(script_data, human_player_names=req.human_players)
    return result

@router.post("/voice/transcribe")
async def voice_transcribe(request: Request):
    """Transcribe audio to text using local Whisper model."""
    from ..services.whisper_service import transcribe_audio
    
    form = await request.form()
    audio_file = form.get("audio")
    if not audio_file:
        raise HTTPException(status_code=400, detail="请上传音频文件")
    
    audio_bytes = await audio_file.read()
    text = await transcribe_audio(audio_bytes)
    
    return {"text": text, "status": "ok"}


# Global voice_enabled flag (stored on app.state for persistence)
_VOICE_ENABLED = True


@router.get("/voice/toggle")
async def get_voice_toggle(request: Request):
    global _VOICE_ENABLED
    return {"voice_enabled": getattr(request.app.state, '_voice_enabled', True)}


class VoiceToggleRequest(BaseModel):
    voice_enabled: bool = True


@router.post("/voice/toggle")
async def set_voice_toggle(req: VoiceToggleRequest, request: Request):
    request.app.state._voice_enabled = req.voice_enabled
    if hasattr(request.app.state, 'router') and request.app.state.router:
        request.app.state.router.voice_enabled = req.voice_enabled
    return {"status": "ok", "voice_enabled": req.voice_enabled}


@router.post("/script/generate")
async def script_generate(req: ScriptGenerateRequest, request: Request):
    """Use AI to generate a complete script based on natural language description."""
    from ..services.whisper_service import transcribe_audio
    from ..core.agent import Agent
    
    r = getattr(request.app.state, "router", None)
    if r is None:
        raise HTTPException(status_code=503, detail="系统未初始化")
    
    llm = get_llm_client(request)
    
    prompt_text = req.prompt
    char_count = req.character_count
    
    # Step 1: If requested, search the web for reference material
    search_context = ""
    if req.include_search:
        from ..services.web_search import web_search, web_fetch_content
        try:
            # Extract key search terms from the prompt
            search_queries = [prompt_text]
            # Search multiple angles
            all_results = []
            for sq in search_queries:
                results = await web_search(sq, max_results=3)
                for r in results:
                    if r["snippet"] and r["snippet"] != "未找到相关搜索结果":
                        all_results.append(r)
            
            if all_results:
                search_context = "\n\n=== 联网搜索参考素材 ===\n"
                for r in all_results[:5]:
                    search_context += f"- {r['title']}: {r['snippet'][:300]}\n"
                    # Fetch details from first result if it looks promising
                    if r["url"] and len(all_results) <= 3:
                        try:
                            content = await web_fetch_content(r["url"], max_chars=1000)
                            if len(content) > 100:
                                search_context += f"  详情：{content[:500]}\n"
                        except:
                            pass
        except Exception as e:
            search_context = f"\n\n[搜索参考失败: {e}]\n"
    
    json_template = '''{{
  "title": "剧本标题",
  "description": "剧本简介",
  "settings": "时代/地点",
  "background_story": "完整背景故事",
  "characters": [{{"name": "角色名", "persona": "角色性格", "goal": "角色目标", "background": "角色背景", "secret": "隐藏秘密"}}],
  "relationships": [{{"from": "角色A", "to": "角色B", "relation": "关系", "description": "关系详情"}}],
  "scenes": [{{"name": "场景名", "location": "地点", "description": "场景描述", "clues": []}}],
  "ending_conditions": "游戏结束条件"
}}'''
    
    gen_prompt = (
        f"你是一个剧本杀创作助手。请根据以下需求生成一个完整的剧本JSON。\n\n"
        f"需求：{prompt_text}\n"
        f"角色数量：{char_count}人\n"
        f"{search_context}\n\n"
        f"请严格按照以下JSON格式返回，不要包含任何其他内容：\n"
        f"{json_template}\n\n"
        f"确保角色名称是中文名，角色背景丰富且有动机。线索要能指向真相但也需要推理。"
    )
    
    # Use LLM to generate
    try:
        response = await r._llm.chat(
            messages=[{"role": "user", "content": gen_prompt}],
            max_tokens=4096, temperature=0.8, stream=False,
        )
        import json
        script_data = json.loads(response.strip())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI 生成失败: {e}")
    
    return {
        "status": "ok",
        "script": script_data,
        "message": f"剧本《{script_data.get('title', '未命名')}》生成成功！共{len(script_data.get('characters', []))}个角色，{len(script_data.get('scenes', []))}个场景。"
    }

