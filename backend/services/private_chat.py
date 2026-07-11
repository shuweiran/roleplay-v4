"""Private chat management — players can request 1v1 chats through the director."""
from dataclasses import dataclass, field
from typing import Optional

@dataclass
class PrivateChatRequest:
    player: str
    target: str
    message: str
    approved: bool = False
    reason: str = ""
    track_id: str = ""

@dataclass
class PrivateChatManager:
    active_chats: dict = field(default_factory=dict)
    
    def request_chat(self, player: str, target: str, message: str, game_phase: str) -> PrivateChatRequest:
        req = PrivateChatRequest(player=player, target=target, message=message)
        # Director rules: no private chat during voting or night
        if game_phase in ("voting", "judgment", "ended"):
            req.approved = False
            req.reason = f"当前阶段（{game_phase}）不允许私聊"
            return req
        req.approved = True
        req.track_id = f"private_{player}_{target}"
        req.reason = "允许私聊，请你们在私密空间中交谈"
        return req
    
    def end_chat(self, track_id: str):
        self.active_chats.pop(track_id, None)
