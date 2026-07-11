"""
Invite code service — generate, validate, and track invite codes.
Stores codes in a JSON file for simplicity (MVP).
"""

import json
import os
import secrets
import string
from datetime import datetime, timedelta
from typing import Dict, List, Optional


INVITES_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "invites.json")


def _load() -> Dict:
    if not os.path.exists(INVITES_FILE):
        return {"codes": []}
    with open(INVITES_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def _save(data: Dict) -> None:
    os.makedirs(os.path.dirname(INVITES_FILE), exist_ok=True)
    with open(INVITES_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def generate_codes(count: int = 5, *, max_uses: int = 1, expires_days: int = 30, note: str = "") -> List[str]:
    """Generate N invite codes."""
    data = _load()
    codes = []
    for _ in range(count):
        code = ''.join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(8))
        expires = (datetime.utcnow() + timedelta(days=expires_days)).isoformat()
        entry = {
            "code": code,
            "created": datetime.utcnow().isoformat(),
            "expires": expires,
            "max_uses": max_uses,
            "used_count": 0,
            "used_by": [],
            "note": note,
            "active": True,
        }
        data["codes"].append(entry)
        codes.append(code)
    _save(data)
    return codes


def verify_code(code: str) -> Optional[Dict]:
    """Verify an invite code. Returns the user identity if valid, None otherwise."""
    data = _load()
    for entry in data["codes"]:
        if entry["code"] == code:
            if not entry.get("active", True):
                return None
            if entry["used_count"] >= entry["max_uses"]:
                return None
            expires = datetime.fromisoformat(entry["expires"])
            if datetime.utcnow() > expires:
                return None
            # Generate a simple user identity
            user_id = f"user_{secrets.token_hex(8)}"
            return {"user_id": user_id, "code": code}
    return None


def use_code(code: str, user_id: str) -> bool:
    """Mark a code as used by a user."""
    data = _load()
    for entry in data["codes"]:
        if entry["code"] == code:
            entry["used_count"] += 1
            entry["used_by"].append({
                "user_id": user_id,
                "time": datetime.utcnow().isoformat(),
            })
            _save(data)
            return True
    return False


def list_codes() -> List[Dict]:
    """List all invite codes."""
    data = _load()
    return data["codes"]


def deactivate_code(code: str) -> bool:
    """Deactivate an invite code."""
    data = _load()
    for entry in data["codes"]:
        if entry["code"] == code:
            entry["active"] = False
            _save(data)
            return True
    return False
