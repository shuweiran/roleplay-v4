"""Lightweight in-memory multiplayer rooms for local play."""

from __future__ import annotations

import asyncio
import random
import string
from datetime import datetime
from typing import Dict, List

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/rooms", tags=["rooms"])


class RoomJoinRequest(BaseModel):
    player_name: str = Field(min_length=1, max_length=50)
    mode: str = Field(default="rules", max_length=30)


class RoomAssignRequest(BaseModel):
    characters: List[str] = Field(default_factory=list, max_length=30)


_rooms: Dict[str, dict] = {}


def _code() -> str:
    alphabet = string.ascii_uppercase + string.digits
    while True:
        code = "".join(random.choice(alphabet) for _ in range(4))
        if code not in _rooms:
            return code


def _public(room: dict) -> dict:
    return {
        "code": room["code"],
        "mode": room.get("mode", "rules"),
        "host": room.get("host", ""),
        "players": list(room.get("players", [])),
        "assignments": dict(room.get("assignments", {})),
        "created_at": room.get("created_at", ""),
        "updated_at": room.get("updated_at", ""),
    }


@router.post("")
async def create_room(req: RoomJoinRequest):
    code = _code()
    now = datetime.utcnow().isoformat()
    room = {
        "code": code,
        "mode": req.mode,
        "host": req.player_name,
        "players": [req.player_name],
        "assignments": {},
        "created_at": now,
        "updated_at": now,
    }
    _rooms[code] = room
    return {"status": "ok", "room": _public(room)}


@router.get("/{code}")
async def get_room(code: str):
    room = _rooms.get(code.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    return {"room": _public(room)}


@router.post("/{code}/join")
async def join_room(code: str, req: RoomJoinRequest, request: Request):
    room = _rooms.get(code.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if req.player_name not in room["players"]:
        room["players"].append(req.player_name)
    room["updated_at"] = datetime.utcnow().isoformat()
    return {"status": "ok", "room": _public(room)}


@router.post("/{code}/leave")
async def leave_room(code: str, req: RoomJoinRequest, request: Request):
    room = _rooms.get(code.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    room["players"] = [p for p in room["players"] if p != req.player_name]
    room["assignments"].pop(req.player_name, None)
    if room["host"] == req.player_name:
        room["host"] = room["players"][0] if room["players"] else ""
    room["updated_at"] = datetime.utcnow().isoformat()
    if not room["players"]:
        _rooms.pop(code.upper(), None)
        return {"status": "ok", "room": None}
    return {"status": "ok", "room": _public(room)}


@router.post("/{code}/assign")
async def assign_room_characters(code: str, req: RoomAssignRequest):
    room = _rooms.get(code.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    chars = [c for c in req.characters if c]
    if not chars:
        raise HTTPException(status_code=400, detail="No characters to assign")
    assignments = {}
    for index, player in enumerate(room["players"]):
        assignments[player] = chars[index % len(chars)]
    room["assignments"] = assignments
    room["updated_at"] = datetime.utcnow().isoformat()
    return {"status": "ok", "room": _public(room)}
