"""
Session lifecycle management: create, load, save, auto-save, prune, archive.

Fixes the critical v3 bug where _autosave was literally `pass`.
Now auto-saves every 3 rounds and prunes sessions at 200 messages.
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from typing import List, Optional

from ..models.domain import Message, Session
from .persistence import AtomicFileStorage

MAX_MESSAGES = 200
AUTOSAVE_INTERVAL = 3  # rounds


class SessionManager:
    """Manages session persistence with auto-save and pruning."""

    def __init__(self, sessions_dir: str, storage: AtomicFileStorage = None):
        self._dir = sessions_dir
        self._storage = storage or AtomicFileStorage()
        os.makedirs(self._dir, exist_ok=True)

    # ── Create / Load ───────────────────────────────────────────

    def create(self, session_id: str, agent_names: List[str], config: dict = None) -> Session:
        """Create a new session."""
        session = Session(
            session_id=session_id,
            agent_names=agent_names,
            config=config or {},
        )
        return session

    def load(self, session_id: str) -> Optional[Session]:
        """Load a session by ID. Returns None if not found."""
        path = os.path.join(self._dir, f"{session_id}.json")
        data = self._storage.read_json(path)
        if data:
            return Session.from_dict(data)
        return None

    def save(self, session: Session) -> str:
        """Save session to disk. Returns the file path."""
        path = os.path.join(self._dir, f"{session.session_id}.json")
        self._storage.write_json(path, session.to_dict())
        return path

    def get_latest(self) -> Optional[str]:
        """Get the path of the most recent session file. Returns None if no sessions."""
        files = [f for f in os.listdir(self._dir) if f.endswith(".json")]
        if not files:
            return None
        files.sort(reverse=True)
        return os.path.join(self._dir, files[0])

    # ── Auto-save ───────────────────────────────────────────────

    def autosave(self, session: Session) -> None:
        """Auto-save if the round count is a multiple of AUTOSAVE_INTERVAL.

        Called after each round completes. Saves every 3 rounds.
        This fixes the v3 bug where _autosave was pass.
        """
        if session.round_count > 0 and session.round_count % AUTOSAVE_INTERVAL == 0:
            try:
                self.save(session)
            except Exception as e:
                print(f"[SessionManager] Auto-save failed: {e}")

    # ── Pruning ─────────────────────────────────────────────────

    def prune(self, session: Session) -> int:
        """Keep last MAX_MESSAGES messages. Archive excess to _archive.json.

        Returns the number of messages pruned (0 if under limit).
        """
        if len(session.messages) <= MAX_MESSAGES:
            return 0

        excess = len(session.messages) - MAX_MESSAGES
        archived = session.messages[:-MAX_MESSAGES]

        # Save archived messages
        archive_path = os.path.join(
            self._dir,
            f"{session.session_id}_archive.json",
        )
        archive_data = {
            "archived_from": session.session_id,
            "archived_at": datetime.now().isoformat(),
            "message_count": len(archived),
            "messages": [m.to_dict() for m in archived],
        }
        self._storage.write_json(archive_path, archive_data)

        # Trim session
        session.messages = session.messages[-MAX_MESSAGES:]

        # Also prune compressed_chunks to relevant range
        if session.compressed_chunks:
            last_round = max((m.round_number for m in session.messages), default=0)
            session.compressed_chunks = [
                c for c in session.compressed_chunks
                if c.end_round >= last_round - 10
            ]

        print(f"[SessionManager] Pruned {excess} messages from {session.session_id}")
        return excess

    # ── Stats ───────────────────────────────────────────────────

    def get_session_stats(self, session: Session) -> dict:
        """Return stats about a session."""
        return {
            "session_id": session.session_id,
            "message_count": len(session.messages),
            "round_count": session.round_count,
            "compressed_chunks": len(session.compressed_chunks),
            "size_estimate_kb": len(json.dumps(session.to_dict(), ensure_ascii=False)) // 1024,
        }
