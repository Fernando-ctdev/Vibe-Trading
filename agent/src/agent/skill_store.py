"""User skill persistence for the REST Skills API.

The API identity of a skill is its canonical frontmatter ``name`` — never the
directory name. Read/update/delete resolve a name by scanning the allowed
roots and comparing declared names, so a user skill stored in a differently
named directory stays addressable. User entries shadow bundled entries with
the same name (the ``SkillsLoader`` precedence). Names are validated as safe
single path segments, scanned directories must resolve inside their root and
symlinked directories are never followed. SKILL.md bytes are read and written
verbatim: no normalization and no frontmatter re-serialization.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict

from src.agent.frontmatter import parse_frontmatter

USER_SKILLS_DIR = Path.home() / ".vibe-trading" / "skills" / "user"
BUNDLED_SKILLS_DIR = Path(__file__).resolve().parents[1] / "skills"

_SKILL_FILE = "SKILL.md"
_SKILL_WRITE_LOCK = threading.Lock()
# Safe slug: ASCII alphanumeric head, then alphanumerics, dots, underscores
# or hyphens — no whitespace, separators, unicode, or trailing dot.
_SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
# Directory stems Windows reserves regardless of extension; creating them
# would make the skill unusable or shadow a device on Windows hosts.
_WINDOWS_RESERVED = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}


class SkillValidationError(ValueError):
    """An invalid skill identifier or document (HTTP 422)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class SkillConflictError(Exception):
    """A resolvable conflict (HTTP 409) with a machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class _SkillEntry:
    name: str
    source: str
    directory: Path
    meta: Dict[str, Any] = field(default_factory=dict)


def validate_skill_name(name: str) -> str:
    """Reject names that are unsafe as a skill directory slug.

    Safe-slug policy (``_SLUG_RE``) plus Windows-reserved stems. Every
    bundled skill name already satisfies this; the value is returned
    unchanged — no silent normalization.
    """
    if (
        not isinstance(name, str)
        or not _SLUG_RE.fullmatch(name)
        # The slug class allows interior dots; a trailing one is still an
        # invalid Windows directory name.
        or name[-1] == "."
        or name.lower().split(".", 1)[0] in _WINDOWS_RESERVED
    ):
        raise SkillValidationError(f"Invalid skill name: {name!r}")
    return name


def _skill_roots() -> tuple[tuple[Path, str], ...]:
    """Scan roots with their source label, highest precedence first."""
    return ((USER_SKILLS_DIR, "user"), (BUNDLED_SKILLS_DIR, "bundled"))


def _iter_skill_dirs(root: Path, source: str) -> list[_SkillEntry]:
    """Parse every direct child directory carrying a SKILL.md.

    Symlinked directories are skipped and the resolved directory must stay
    inside its root, so no entry can point outside the scan roots.
    """
    entries: list[_SkillEntry] = []
    if not root.is_dir():
        return entries
    try:
        resolved_root = root.resolve()
    except OSError:
        return entries
    for path in sorted(root.iterdir()):
        if path.is_symlink() or not path.is_dir():
            continue
        try:
            path.resolve().relative_to(resolved_root)
        except (OSError, ValueError):
            continue
        skill_file = path / _SKILL_FILE
        # A symlinked SKILL.md could point outside the root; never follow it.
        if skill_file.is_symlink() or not skill_file.is_file():
            continue
        try:
            text = skill_file.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        meta, _ = parse_frontmatter(text)
        name = meta.get("name")
        if isinstance(name, str) and name:
            entries.append(_SkillEntry(name=name, source=source, directory=path, meta=meta))
    return entries


def _resolve_entry(name: str) -> _SkillEntry:
    """Resolve one canonical name against both roots, user-first.

    A single user match shadows any bundled match (SkillsLoader order). Two
    entries declaring the same name inside the winning root are ambiguous and
    surface as ``name_collision`` instead of being picked silently.
    """
    validate_skill_name(name)
    user_matches = [
        entry for entry in _iter_skill_dirs(USER_SKILLS_DIR, "user") if entry.name == name
    ]
    if len(user_matches) > 1:
        raise SkillConflictError(
            "name_collision", f"Multiple user skills declare the name '{name}'"
        )
    if user_matches:
        return user_matches[0]
    bundled_matches = [
        entry for entry in _iter_skill_dirs(BUNDLED_SKILLS_DIR, "bundled") if entry.name == name
    ]
    if len(bundled_matches) > 1:
        raise SkillConflictError(
            "name_collision", f"Multiple bundled skills declare the name '{name}'"
        )
    if not bundled_matches:
        raise FileNotFoundError(f"Skill '{name}' not found")
    return bundled_matches[0]


def _declared_frontmatter_name(content: str) -> str:
    """Return the canonical name declared by submitted SKILL.md content."""
    meta, _ = parse_frontmatter(content)
    name = meta.get("name")
    if not isinstance(name, str) or not name:
        raise SkillValidationError("Skill content must declare a non-empty frontmatter 'name'")
    return validate_skill_name(name)


def _atomic_write_skill(directory: Path, content: str) -> None:
    """Atomically replace SKILL.md inside *directory*.

    Mirrors ``src.swarm.presets._atomic_write_user_preset``: unique temp file
    in the target directory, restricted permissions, fsync, os.replace.
    """
    target = directory / _SKILL_FILE
    directory.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{_SKILL_FILE}.", suffix=".tmp", dir=directory)
    try:
        os.chmod(temp_name, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, target)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def _revision_of(content_bytes: bytes) -> str:
    return hashlib.sha256(content_bytes).hexdigest()


def _require_current_revision(path: Path, expected_revision: str) -> None:
    if not re.fullmatch(r"[0-9a-fA-F]{64}", expected_revision or ""):
        raise SkillConflictError("revision_stale", "A valid If-Match revision is required")
    if _revision_of(path.read_bytes()) != expected_revision.lower():
        raise SkillConflictError("revision_stale", "If-Match revision is stale")


def list_skill_catalog() -> list[dict]:
    """Return every visible skill as ``{name, source, description}``.

    The first entry seen for a name wins — user shadows bundled, and within a
    root the sorted-first directory wins. Ambiguity is surfaced with a 409 on
    the targeted read/update/delete operations, not in this listing.
    """
    catalog: dict[str, dict] = {}
    for root, source in _skill_roots():
        for entry in _iter_skill_dirs(root, source):
            if entry.name in catalog:
                continue
            catalog[entry.name] = {
                "name": entry.name,
                "source": entry.source,
                "description": str(entry.meta.get("description", "")),
            }
    return sorted(catalog.values(), key=lambda item: item["name"])


def read_skill_source(name: str) -> dict:
    """Return exact SKILL.md bytes (decoded) and their content revision."""
    entry = _resolve_entry(name)
    content_bytes = (entry.directory / _SKILL_FILE).read_bytes()
    return {
        "name": entry.name,
        "source": entry.source,
        "content": content_bytes.decode("utf-8"),
        "revision": _revision_of(content_bytes),
    }


def create_user_skill(content: str) -> dict:
    """Create a new user skill in a directory derived from its declared name."""
    name = _declared_frontmatter_name(content)
    with _SKILL_WRITE_LOCK:
        for root, source in _skill_roots():
            for entry in _iter_skill_dirs(root, source):
                if entry.name == name:
                    raise SkillConflictError(
                        "name_collision",
                        f"A {source} skill already declares the name '{name}'",
                    )
        directory = USER_SKILLS_DIR / name
        if directory.exists():
            raise SkillConflictError(
                "name_collision", f"User skill directory for '{name}' already exists"
            )
        _atomic_write_skill(directory, content)
    return {"name": name, "source": "user"}


def save_user_skill(name: str, content: str, expected_revision: str) -> dict:
    """Update an existing user skill in place, keeping its directory."""
    if _declared_frontmatter_name(content) != name:
        raise SkillValidationError(
            "Skill content frontmatter 'name' must match the skill being updated"
        )
    with _SKILL_WRITE_LOCK:
        entry = _resolve_entry(name)
        if entry.source != "user":
            raise SkillConflictError(
                "bundled_read_only", f"Skill '{name}' is bundled and read-only"
            )
        _require_current_revision(entry.directory / _SKILL_FILE, expected_revision)
        _atomic_write_skill(entry.directory, content)
    return {"name": name, "source": "user"}


def delete_user_skill(name: str, expected_revision: str) -> dict:
    """Delete a user skill directory that carries nothing but SKILL.md."""
    with _SKILL_WRITE_LOCK:
        entry = _resolve_entry(name)
        if entry.source != "user":
            raise SkillConflictError(
                "bundled_read_only", f"Skill '{name}' is bundled and read-only"
            )
        directory = entry.directory
        auxiliaries = sorted(
            path.name for path in directory.iterdir() if path.name != _SKILL_FILE
        )
        if auxiliaries:
            raise SkillConflictError(
                "auxiliary_files_present",
                "Skill directory contains supporting files that would be lost: "
                + ", ".join(auxiliaries),
            )
        _require_current_revision(directory / _SKILL_FILE, expected_revision)
        shutil.rmtree(directory)
    return {"name": name, "deleted": True}
