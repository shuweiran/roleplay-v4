"""
Namespace isolation: each invite code with note "friend"/"for friends"
gets its own private data directory. Others share the "global" namespace.

Path structure:
  data/global/characters/  ← your (admin) data
  data/namespaces/{ns}/characters/  ← friend's data
"""

import hashlib
import os
import shutil

BASE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
GLOBAL_NS = "global"
NAMESPACES_DIR = os.path.join(BASE_DIR, "namespaces")


def namespace_from_code(code: str, note: str = "") -> str:
    """Derive namespace from invite code metadata.
    - "friend" / "for friends" → isolated namespace (hash of code)
    - anything else → "global"
    """
    note_lower = (note or "").strip().lower()
    if note_lower in ("friend", "for friends"):
        h = hashlib.sha256(code.encode()).hexdigest()[:16]
        return f"ns_{h}"
    return GLOBAL_NS


def namespace_path(namespace: str, sub: str = "") -> str:
    """Get the filesystem path for a namespace and optional subdirectory."""
    if namespace == GLOBAL_NS:
        base = BASE_DIR
    else:
        base = os.path.join(NAMESPACES_DIR, namespace)
    if sub:
        return os.path.join(base, sub)
    return base


def ensure_namespace(namespace: str) -> None:
    """Ensure a namespace directory exists, seeded with template data if new.
    Friend namespaces start empty (no global characters/scenes leaked).
    """
    if namespace == GLOBAL_NS:
        os.makedirs(os.path.join(BASE_DIR, "characters"), exist_ok=True)
        os.makedirs(os.path.join(BASE_DIR, "scenes"), exist_ok=True)
        os.makedirs(os.path.join(BASE_DIR, "sessions"), exist_ok=True)
        return

    ns_dir = os.path.join(NAMESPACES_DIR, namespace)
    if os.path.isdir(ns_dir):
        return  # already exists

    # Create fresh directories
    os.makedirs(os.path.join(ns_dir, "characters"), exist_ok=True)
    os.makedirs(os.path.join(ns_dir, "scenes"), exist_ok=True)
    os.makedirs(os.path.join(ns_dir, "sessions"), exist_ok=True)
    print(f"[Namespace] Created new isolated namespace: {namespace}")
