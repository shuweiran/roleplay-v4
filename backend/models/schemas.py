"""
Pydantic request/response models for Roleplay v4 API.

All models include validation (min_length, max_length, Field constraints).
These replace the scattered inline models in v3's web/server.py.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# 鈹€鈹€ Character 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

class CharacterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=50, pattern=r'^[^<>:"/\\|?*\x00-\x1f]+$', description="Character name")
    persona: str = Field(default="", max_length=5000, description="Personality description")
    voice: str = Field(default="", max_length=2000, description="Speaking style")
    background: str = Field(default="", max_length=2000, description="Backstory")


class CharacterUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=50)
    persona: Optional[str] = Field(default=None, max_length=5000)
    voice: Optional[str] = Field(default=None, max_length=2000)
    background: Optional[str] = Field(default=None, max_length=2000)


class BatchCharacterRequest(BaseModel):
    characters: List[CharacterRequest] = Field(max_length=50)


class CharacterGenerateRequest(BaseModel):
    keywords: str = Field(default="", max_length=200)


class CharacterResponse(BaseModel):
    name: str
    persona: str
    voice: str
    background: str


class CharacterListResponse(BaseModel):
    characters: List[CharacterResponse] = []


# 鈹€鈹€ Scene 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

class SceneRequest(BaseModel):
    scene_id: str = Field(min_length=1, max_length=100, pattern=r'^[^<>:"/\\|?*\x00-\x1f]+$')
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=2000)
    agent_names: List[str] = Field(default_factory=list, max_length=50)


class SceneGenerateRequest(BaseModel):
    keywords: str = Field(default="", max_length=200)


class SceneResponse(BaseModel):
    scene_id: str
    name: str
    description: str
    initial_agent_names: List[str] = []


class SceneListResponse(BaseModel):
    scenes: List[SceneResponse] = []


# 鈹€鈹€ Session / Init 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

class InitRequest(BaseModel):
    persona_file: str = ""
    session_id: str = ""
    resume: bool = False
    scene_id: str = ""


class AgentRequest(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    persona: str = ""
    voice: str = ""
    background: str = ""


# 鈹€鈹€ Round 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

class RoundRequest(BaseModel):
    turns: int = Field(default=1, ge=1, le=20)


class RollbackRequest(BaseModel):
    round: int = Field(ge=0)


# 鈹€鈹€ Send / User Input 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

class SendRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    as_user: bool = True
    player_name: str = Field(default="", max_length=50, description="鍦╳erewolf妯″紡涓嬩綔涓鸿瑙掕壊鍙戣█")


# 鈹€鈹€ Mode 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

class ModeRequest(BaseModel):
    mode: str = Field(default="free", pattern="^(free|protagonist|multi_track|director|werewolf|script|rules)$")
    protagonist: str = ""
    director_character: str = ""
    advanced_tracks: List[str] = Field(default_factory=list)


# 鈹€鈹€ Werewolf 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

class GamePhase(str, Enum):
    NIGHT = "night"
    DISCUSSION = "discussion"
    VOTING = "voting"
    JUDGMENT = "judgment"
    ENDED = "ended"


class WerewolfRole(str, Enum):
    WOLF = "wolf"
    SEER = "seer"
    WITCH = "witch"
    HUNTER = "hunter"
    VILLAGER = "villager"


class NightActionRequest(BaseModel):
    action_type: str = Field(default="kill", pattern="^(kill|check|save|poison)$",
                              description="night action type: kill/check/save/poison")
    target: str = Field(min_length=1, max_length=50, description="target character name")
    player_name: str = Field(default="me", max_length=50, description="player name")
    session_id: str = Field(default="", max_length=200, description="浼氳瘽ID")


class NightActionResponse(BaseModel):
    status: str
    message: str


class VoteRequest(BaseModel):
    target: str = Field(min_length=1, max_length=50, description="target")
    player_name: str = Field(default="me", max_length=50, description="player")
    session_id: str = Field(default="", max_length=200, description="浼氳瘽ID")


class VoteResponse(BaseModel):
    status: str
    message: str


class WerewolfEliminatedInfo(BaseModel):
    name: str
    reason: str
    round: int


class WerewolfStatusResponse(BaseModel):
    phase: str = "night"
    round_number: int = 1
    alive_players: List[str] = Field(default_factory=list)
    eliminated_players: List[WerewolfEliminatedInfo] = Field(default_factory=list)
    your_role: Optional[str] = None
    winner: str = ""
    roles: Dict[str, str] = Field(default_factory=dict)


# 鈹€鈹€ Private Chat 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

class PrivateChatRequest(BaseModel):
    player_name: str = Field(min_length=1, max_length=50, description="璇锋眰绉佽亰鐨勭帺瀹跺悕")
    target: str = Field(min_length=1, max_length=50, description="see field name"),
    message: str = Field(default="", max_length=500, description="绉佽亰璇锋眰娑堟伅锛堝彲閫夛級")


class PrivateChatReply(BaseModel):
    player_name: str = Field(min_length=1, max_length=50, description="璇锋眰绉佽亰鐨勭帺瀹跺悕")
    target: str = Field(min_length=1, max_length=50, description="see field name"),
    allowed: bool = Field(default=False, description="鏄惁鍏佽绉佽亰")
    reason: str = Field(default="", max_length=500, description="鍏佽鎴栨嫆缁濈殑鐞嗙敱")


class PrivateChatSendRequest(BaseModel):
    track_id: str = Field(min_length=1, max_length=100, description="绉佽亰杞ㄩ亾ID")
    player_name: str = Field(min_length=1, max_length=50, description="鍙戦€佽€呭悕")
    text: str = Field(min_length=1, max_length=5000, description="绉佽亰鍐呭")


# 鈹€鈹€ Goals 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

class GoalsRequest(BaseModel):
    goals: List[str] = Field(default_factory=list, max_length=20)


# 鈹€鈹€ History 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

class HistoryMessageResponse(BaseModel):
    role: str
    name: str
    content: str
    timestamp: str
    track_id: str = "main"
    round_number: int = 0
    scene_name: Optional[str] = None


class HistoryResponse(BaseModel):
    messages: List[HistoryMessageResponse] = []
    round_logs: List[dict] = []


# 鈹€鈹€ Script System 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

class ScriptCharacterConfig(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    persona: str = Field(default="", max_length=5000)
    goal: str = Field(default="", max_length=2000)
    background: str = Field(default="", max_length=5000)
    secrets: List[str] = Field(default_factory=list)


class ScriptRelationship(BaseModel):
    from_char: str = Field(min_length=1, max_length=50)
    to: str = Field(min_length=1, max_length=50)
    relation: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=1000)


class ScriptScene(BaseModel):
    scene_id: str = Field(default="", max_length=100)
    name: str = Field(default="", max_length=100)
    description: str = Field(default="", max_length=2000)
    characters_involved: List[str] = Field(default_factory=list)
    order: int = Field(default=0)


class ScriptConfig(BaseModel):
    title: str = Field(min_length=1, max_length=200, description="鍓ф湰鍚嶇О")
    description: str = Field(default="", max_length=5000, description="see field name"),
    era: str = Field(default="", max_length=200, description="鏃朵唬鑳屾櫙")
    location: str = Field(default="", max_length=200, description="涓昏鍦扮偣")


class ScriptLoadRequest(BaseModel):
    script_path: str = Field(default="", max_length=500, description="鍓ф湰鏂囦欢璺緞")
    script_data: Optional[Dict[str, Any]] = Field(default=None, description="鐩存帴浼犲叆鍓ф湰鏁版嵁")
    human_players: List[str] = Field(default_factory=list, max_length=20, description="Characters controlled by real players")


class ScriptLoadResponse(BaseModel):
    status: str
    title: str = ""
    character_count: int = 0
    scene_count: int = 0
    characters: List[str] = Field(default_factory=list)


class ScriptGenerateRequest(BaseModel):
    prompt: str = Field(..., max_length=2000, description="see field name"),
    character_count: int = Field(default=6, ge=3, le=15, description="瑙掕壊鏁伴噺")
    include_search: bool = Field(default=False, description="see field name"),
    session_id: str = ""
    round: int = 0
    phase: str = "idle"
    round_phase: str = "idle"
    agents: List[str] = []
    scene: Optional[str] = None
    scene_description: str = ""
    track_config: Optional[dict] = None
    track_history: List[dict] = []
    compressed_chunks: int = 0
    mode: str = "free"
    protagonist: str = ""
    director_character: str = ""
    goals: List[str] = []


class RouterStateResponse(BaseModel):
    session_id: str = ""
    round: int = 0
    phase: str = "idle"
    round_phase: str = "idle"
    agents: List[str] = []
    scene: Optional[str] = None
    mode: str = "free"
    protagonist: str = ""
    director_character: str = ""
    goals: List[str] = []

class StateResponse(BaseModel):
    initialized: bool = False
    router: RouterStateResponse = Field(default_factory=RouterStateResponse)
    characters: List[CharacterResponse] = []
    scenes: List[SceneResponse] = []


