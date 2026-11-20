"""Package Lattice itself so a new laptop can download it from any running node."""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

EXCLUDE_DIRS = {".venv", "venv", "data", "models", "runtime", "__pycache__", ".git", ".idea", ".vscode",
                "node_modules", ".pytest_cache"}


def build_zip(root: Path) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(root.rglob("*")):
            rel = p.relative_to(root)
            if any(part in EXCLUDE_DIRS or part.startswith(".node") for part in rel.parts):
                continue
            if p.is_file() and not p.name.endswith((".pyc", ".part", ".tmp")):
                z.write(p, Path("lattice") / rel)
    return buf.getvalue()
