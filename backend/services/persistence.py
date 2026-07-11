"""
Atomic JSON file persistence for characters, scenes, and sessions.

Key features:
- Atomic writes: .tmp file → os.replace() (crash-safe)
- CharacterStore / SceneStore encapsulate CRUD with validation
- Backward-compatible with v3 JSON formats
"""

from __future__ import annotations

import json
import os
import re
from typing import Dict, List, Optional

# Windows-illegal filename characters
_ILLEGAL_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _validate_filename(name: str, label: str = "name") -> str:
    """Validate and return a filename-safe name. Raises ValueError on invalid chars."""
    if not name or not name.strip():
        raise ValueError(f"{label} cannot be empty")
    if _ILLEGAL_CHARS.search(name):
        raise ValueError(f"{label} contains illegal characters: {name!r}")
    return name.strip()

# Persona import deferred to avoid circular imports at module level
# We'll import inline in CharacterStore methods


class AtomicFileStorage:
    """Atomic JSON file read/write with crash safety.

    Writes to a .tmp file first, then atomically replaces the target.
    On POSIX, os.replace() is atomic. On Windows, it's near-atomic
    (atomic within the same volume since Python 3.3+).
    """

    @staticmethod
    def read_json(path: str) -> Optional[dict]:
        """Read and parse a JSON file. Returns None if not found or corrupt."""
        if not os.path.exists(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            print(f"[Persistence] Failed to read {path}: {e}")
            return None

    @staticmethod
    def write_json(path: str, data: dict) -> None:
        """Atomic write: write to .tmp, then os.replace().

        If the write to .tmp crashes, the original file is untouched.
        """
        tmp_path = path + ".tmp"
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, path)  # Atomic
        except Exception:
            # Clean up tmp file on failure
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
            raise

    @staticmethod
    def delete_file(path: str) -> bool:
        """Delete a file. Returns True if deleted, False if not found."""
        if os.path.exists(path):
            os.remove(path)
            return True
        return False

    @staticmethod
    def list_json_files(directory: str) -> List[str]:
        """List all .json files in a directory."""
        os.makedirs(directory, exist_ok=True)
        return sorted([
            f for f in os.listdir(directory)
            if f.endswith(".json") and not f.startswith(".")
        ])


class CharacterStore:
    """CRUD for character JSON files. Uses AtomicFileStorage."""

    def __init__(self, characters_dir: str, storage: AtomicFileStorage = None):
        self._dir = characters_dir
        self._storage = storage or AtomicFileStorage()
        os.makedirs(self._dir, exist_ok=True)

    def list_all(self) -> list:
        """Return list of dicts: {name, persona, voice, background}."""
        characters = []
        for fname in self._storage.list_json_files(self._dir):
            data = self._storage.read_json(os.path.join(self._dir, fname))
            if data and "name" in data:
                characters.append({
                    "name": data["name"],
                    "persona": data.get("persona", "")[:80],
                    "voice": data.get("voice", "")[:60],
                    "background": data.get("background", "")[:80],
                })
        return characters

    def list_full(self) -> list:
        """Return list of full character dicts (for Persona loading)."""
        characters = []
        for fname in self._storage.list_json_files(self._dir):
            data = self._storage.read_json(os.path.join(self._dir, fname))
            if data and "name" in data:
                characters.append(data)
        return characters

    def get(self, name: str) -> Optional[dict]:
        """Get a single character by name. Returns full dict or None."""
        # Case-sensitive lookup (JSON files use exact name as filename)
        path = os.path.join(self._dir, f"{name}.json")
        data = self._storage.read_json(path)
        if data and data.get("name") == name:
            return data
        # Fallback: scan all files for name match (handles renamed files)
        for fname in self._storage.list_json_files(self._dir):
            data = self._storage.read_json(os.path.join(self._dir, fname))
            if data and data.get("name") == name:
                return data
        return None

    def save(self, persona_dict: dict) -> str:
        """Save a character (creates or overwrites). Returns the name."""
        name = persona_dict["name"]
        _validate_filename(name, "Character name")
        path = os.path.join(self._dir, f"{name}.json")
        self._storage.write_json(path, persona_dict)
        return name

    def update(self, old_name: str, new_persona: dict) -> bool:
        """Atomically update: write new file first, then delete old.

        This prevents data loss if the write fails (unlike delete-then-create).
        """
        new_name = new_persona.get("name", old_name)
        _validate_filename(new_name, "Character name")
        new_path = os.path.join(self._dir, f"{new_name}.json")
        old_path = os.path.join(self._dir, f"{old_name}.json")

        # Write new file first (atomic)
        self._storage.write_json(new_path, new_persona)

        # Then delete old file if name changed
        if old_name != new_name and os.path.exists(old_path):
            self._storage.delete_file(old_path)

        return True

    def delete(self, name: str) -> bool:
        """Delete a character by name. Returns True if deleted."""
        path = os.path.join(self._dir, f"{name}.json")
        return self._storage.delete_file(path)


class SceneStore:
    """CRUD for scene JSON files. Uses AtomicFileStorage."""

    def __init__(self, scenes_dir: str, storage: AtomicFileStorage = None):
        self._dir = scenes_dir
        self._storage = storage or AtomicFileStorage()
        os.makedirs(self._dir, exist_ok=True)

    def list_all(self) -> List[dict]:
        """Return list of scene dicts."""
        scenes = []
        for fname in self._storage.list_json_files(self._dir):
            data = self._storage.read_json(os.path.join(self._dir, fname))
            if data:
                scenes.append(data)
        return scenes

    def get(self, scene_id: str) -> Optional[dict]:
        """Get a scene by scene_id."""
        path = os.path.join(self._dir, f"{scene_id}.json")
        return self._storage.read_json(path)

    def save(self, scene_id: str, data: dict) -> None:
        """Save (create or update) a scene."""
        _validate_filename(scene_id, "Scene ID")
        path = os.path.join(self._dir, f"{scene_id}.json")
        data["scene_id"] = scene_id
        self._storage.write_json(path, data)

    def delete(self, scene_id: str) -> bool:
        """Delete a scene by scene_id."""
        path = os.path.join(self._dir, f"{scene_id}.json")
        return self._storage.delete_file(path)
