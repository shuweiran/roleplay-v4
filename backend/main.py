#!/usr/bin/env python3
"""
Roleplay System v4 — Multi-Agent Roleplay with Track-Based Routing.

Usage:
    python -m backend.main              # Start on port 8000
    python -m backend.main --port 8080  # Custom port
    python -m backend.main --dev        # Dev mode (Vite proxy expected)
"""

from __future__ import annotations

import argparse
import os
import sys

# Fix Windows GBK encoding for emoji output
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Ensure backend/ is on path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.api.app import create_app
from backend.config import AppConfig


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Roleplay v4 Web Server")
    parser.add_argument("--host", type=str, default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--dev", action="store_true", help="Enable Vite dev proxy mode")
    parser.add_argument("--data-dir", type=str, default="",
                        help="Override data directory path")
    parser.add_argument("--disable-arbiter", action="store_true")
    parser.add_argument("--budget", type=float, default=10.0, help="USD budget for LLM")
    return parser.parse_args()


def main():
    args = parse_args()

    config = AppConfig()
    config.host = args.host
    config.port = args.port
    config.frontend.dev_mode = args.dev
    config.monitor.budget_usd = args.budget

    if args.disable_arbiter:
        config.arbiter.enabled = False

    if args.data_dir:
        config.data.characters_dir = os.path.join(args.data_dir, "characters")
        config.data.scenes_dir = os.path.join(args.data_dir, "scenes")
        config.data.sessions_dir = os.path.join(args.data_dir, "sessions")

    app = create_app(config)

    import uvicorn
    print()
    print("  ╔═══════════════════════════════════════╗")
    print("  ║     🎭 Roleplay v4                     ║")
    print("  ║     多智能体角色扮演系统               ║")
    print("  ╚═══════════════════════════════════════╝")
    print()
    print(f"  🌐 打开浏览器访问 http://localhost:{args.port}")
    print(f"  ⚙️  首次使用 → 左下角「设置」→ 填入你的 API Key")
    print(f"  📦 Model: {config.llm.model}")
    print()
    if args.dev:
        print(f"  💻 Dev mode: expecting Vite dev server on port {config.frontend.dev_port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
