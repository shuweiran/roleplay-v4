"""
Configuration for Roleplay v4.

All config lives in dataclasses with sensible defaults.
API keys are resolved from environment variables at startup.
"""

import json
import os
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional


# ── API key persistence ───────────────────────────────────────────

_API_KEY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "api_key.json")


def load_api_key() -> dict:
    """Load saved API key config from api_key.json. Returns dict with api_key/api_base/model keys."""
    try:
        if os.path.exists(_API_KEY_FILE):
            with open(_API_KEY_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            return {
                "api_key": data.get("api_key", "") or "",
                "api_base": data.get("api_base", "") or "",
                "model": data.get("model", "") or "",
            }
    except Exception:
        pass
    return {"api_key": "", "api_base": "", "model": ""}


def save_api_key(api_key: str, api_base: str = "", model: str = ""):
    """Save API key config to api_key.json for persistence across restarts."""
    try:
        data = {"api_key": api_key, "api_base": api_base, "model": model}
        with open(_API_KEY_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"[config] Failed to save api_key.json: {e}")


# ── Track mode enum ───────────────────────────────────────────────

class TrackMode(str, Enum):
    MERGED = "merged"
    WEAK = "weak"
    ISOLATED = "isolated"


# ── LLM config ────────────────────────────────────────────────────

def _resolve_api_key() -> str:
    # Priority: api_key.json > environment variables
    saved = load_api_key()
    if saved.get("api_key"):
        return saved["api_key"]
    for key in ("LLM_API_KEY", "ANTHROPIC_AUTH_TOKEN", "DEEPSEEK_API_KEY"):
        val = os.getenv(key, "")
        if val:
            return val
    # .claude_dotenv fallback
    try:
        dotenv = os.path.expanduser("~/.claude_dotenv")
        if os.path.exists(dotenv):
            with open(dotenv, "r") as f:
                for line in f:
                    if line.startswith("ANTHROPIC_AUTH_TOKEN="):
                        return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return "***"


def _resolve_api_base() -> str:
    saved = load_api_key()
    if saved.get("api_base"):
        return saved["api_base"]
    for key in ("LLM_API_BASE", "ANTHROPIC_BASE_URL"):
        val = os.getenv(key, "")
        if val:
            return val.replace("/anthropic", "")
    return "https://api.deepseek.com"


def _resolve_model() -> str:
    saved = load_api_key()
    if saved.get("model"):
        return saved["model"]
    for key in ("LLM_MODEL", "ANTHROPIC_MODEL"):
        val = os.getenv(key, "")
        if val:
            model = val.replace("[1m]", "").strip()
            if "deepseek-v4-pro" in model:
                return "deepseek-v4-flash"
            return model
    return "deepseek-v4-flash"


@dataclass
class LLMConfig:
    api_key: str = field(default_factory=_resolve_api_key)
    api_base: str = field(default_factory=_resolve_api_base)
    model: str = field(default_factory=_resolve_model)
    max_tokens: int = 4096
    temperature: float = 0.9


# ── Memory config ─────────────────────────────────────────────────

@dataclass
class MemoryConfig:
    short_term_rounds: int = 20
    summary_interval: int = 10
    resume: bool = False


# ── Arbiter config ─────────────────────────────────────────────────

@dataclass
class ArbiterConfig:
    enabled: bool = True
    loop_detection_rounds: int = 3
    arbiter_model: str = ""


# ── Lorebook config ────────────────────────────────────────────────

@dataclass
class LorebookConfig:
    enabled: bool = True
    max_inject_tokens: int = 500
    lore_file: str = "lore_example.yml"


# ── Monitor config ────────────────────────────────────────────────

@dataclass
class MonitorConfig:
    enabled: bool = True
    budget_usd: float = 10.0
    fallback_model: str = "deepseek-v4-flash"
    timeout_seconds: int = 60
    max_retries: int = 3


# ── Mode config ────────────────────────────────────────────────────

@dataclass
class ModeConfig:
    mode: str = "free"            # "free" | "protagonist" | "multi_track" | "director" | "werewolf"
    protagonist: str = ""          # protagonist name
    director_character: str = ""   # user's character name in director/werewolf mode
    advanced_tracks: List[str] = field(default_factory=list)


# ── Token optimizer config ─────────────────────────────────────────

@dataclass
class TokenOptimizerConfig:
    enabled: bool = True
    use_lightweight_prompt: bool = True
    prompt_full_every_n_rounds: int = 5
    max_context_tokens: int = 4000


# ── Round config ───────────────────────────────────────────────────

@dataclass
class RoundConfig:
    enabled: bool = True
    parallel_agents: bool = True
    arbiter_max_tokens: int = 150
    agent_max_tokens: int = 300
    compression_interval: int = 5


# ── Scene config ───────────────────────────────────────────────────

@dataclass
class SceneConfig:
    scene_id: str = ""
    name: str = "默认场景"
    description: str = ""
    initial_agent_names: list = field(default_factory=list)


# ── Data config ────────────────────────────────────────────────────

@dataclass
class DataConfig:
    characters_dir: str = "data/characters"
    scenes_dir: str = "data/scenes"
    sessions_dir: str = "data/sessions"


# ── Frontend config ────────────────────────────────────────────────

@dataclass
class FrontendConfig:
    dev_mode: bool = False
    dev_port: int = 5173
    dist_dir: str = "frontend/dist"


# ── App config (top-level) ────────────────────────────────────────

@dataclass
class AppConfig:
    llm: LLMConfig = field(default_factory=LLMConfig)
    memory: MemoryConfig = field(default_factory=MemoryConfig)
    arbiter: ArbiterConfig = field(default_factory=ArbiterConfig)
    lorebook: LorebookConfig = field(default_factory=LorebookConfig)
    monitor: MonitorConfig = field(default_factory=MonitorConfig)
    token_optimizer: TokenOptimizerConfig = field(default_factory=TokenOptimizerConfig)
    scene: SceneConfig = field(default_factory=SceneConfig)
    round: RoundConfig = field(default_factory=RoundConfig)
    mode: ModeConfig = field(default_factory=ModeConfig)
    data: DataConfig = field(default_factory=DataConfig)
    frontend: FrontendConfig = field(default_factory=FrontendConfig)
    host: str = "0.0.0.0"
    port: int = 8000
    profiles_dir: str = "profiles"
    interrupt_mode: str = "always"
