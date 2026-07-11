from __future__ import annotations

import json
from importlib import resources
from pathlib import Path
from typing import Iterator

from .schema import GameDefinition

SCRIPTS_DIR = Path(__file__).resolve().parent / "scripts"


def _iter_script_paths() -> Iterator[Path]:
    if not SCRIPTS_DIR.is_dir():
        return
    for path in sorted(SCRIPTS_DIR.glob("*.json")):
        yield path


def load_script(path: Path) -> GameDefinition:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return GameDefinition.model_validate(data)


class GameRegistry:
    def __init__(self) -> None:
        self._definitions: dict[str, GameDefinition] = {}

    def scan(self) -> None:
        self._definitions.clear()
        for path in _iter_script_paths():
            definition = load_script(path)
            self._definitions[definition.name] = definition

    def list_games(self) -> list[str]:
        if not self._definitions:
            self.scan()
        return list(self._definitions.keys())

    def get(self, name: str) -> GameDefinition | None:
        if not self._definitions:
            self.scan()
        return self._definitions.get(name)

    def __len__(self) -> int:
        if not self._definitions:
            self.scan()
        return len(self._definitions)


registry = GameRegistry()
