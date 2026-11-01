"""Swarm YAML preset loader.

Reads YAML preset files from the bundled ``presets/`` directory next to this
module and parses them into SwarmRun / SwarmAgentSpec / SwarmTask data models.
Keeping the YAMLs inside the ``src.swarm`` package guarantees identical
behavior under editable installs and built wheels.

User-supplied presets are also discovered from ``~/.vibe-trading/swarm/
presets/`` — the same pattern as user skills (``src/agent/skills.py``):
the user directory is searched first, so a user preset can both add to and
override the bundled roster by name, and nothing needs to be copied into
site-packages (where it would be wiped by the next ``pip install -U``).
Preset names are validated to a single path segment before any filesystem
lookup, so a name can never escape either presets directory.
"""

from __future__ import annotations

import uuid
import hashlib
import os
import re
import tempfile
import threading
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from string import Formatter

import yaml
from pydantic import ValidationError

from src.swarm.models import RunStatus, SwarmAgentSpec, SwarmRun, SwarmTask, TaskStatus
from src.swarm.task_store import topological_layers, validate_dag

PRESETS_DIR = Path(__file__).resolve().parent / "presets"
#: User-created presets; searched before the bundled directory so user files
#: can add to and override the roster by name (mirrors USER_SKILLS_DIR in
#: ``src/agent/skills.py``). Survives package upgrades.
USER_PRESETS_DIR = Path.home() / ".vibe-trading" / "swarm" / "presets"
_INTERNAL_TEMPLATE_VARS = {"upstream_context"}
_PRESET_WRITE_LOCK = threading.Lock()


def _redact_home(path: Path) -> str:
    """Render ``path`` with the home prefix collapsed to ``~`` so user-facing
    errors never leak the absolute home directory (CWE-209)."""
    try:
        return "~/" + str(path.relative_to(Path.home()))
    except ValueError:
        return str(path)


def _validate_preset_name(name: str) -> str:
    """Reject names that are empty or could escape a presets directory.

    Preset names map directly to ``<dir>/<name>.yaml``; a name carrying a
    path separator or ``..`` would resolve outside the directory. The bundled
    path had the same latent exposure — validating here covers both.

    Returns:
        The stripped name.

    Raises:
        ValueError: Empty name, path separators, or parent references.
    """
    cleaned = (name or "").strip()
    if not cleaned or cleaned in {".", ".."} or any(char in cleaned for char in "/\\:"):
        raise ValueError(f"invalid preset name: {name!r}")
    return cleaned


def _preset_search_dirs() -> tuple[Path, ...]:
    """Directories searched for presets, highest priority first."""
    return (USER_PRESETS_DIR, PRESETS_DIR)


def resolve_preset_path(name: str) -> Path | None:
    """Return the YAML path for *name* (user dir first), or ``None``."""
    cleaned = _validate_preset_name(name)
    for directory in _preset_search_dirs():
        path = directory / f"{cleaned}.yaml"
        if path.is_file():
            return path
    return None


def load_preset(name: str) -> dict:
    """Load a YAML preset by name (user directory first, then bundled).

    Args:
        name: Preset name (without .yaml extension).

    Returns:
        Parsed YAML dict.

    Raises:
        ValueError: If the name is empty or contains path separators.
        FileNotFoundError: If the preset file does not exist in either the
            user directory (``~/.vibe-trading/swarm/presets/``) or the
            bundled package directory.
    """
    path = resolve_preset_path(name)
    if path is None:
        available = sorted({
            p.stem
            for directory in _preset_search_dirs()
            if directory.exists()
            for p in directory.glob("*.yaml")
        })
        raise FileNotFoundError(
            f"Preset {name!r} not found in {_redact_home(USER_PRESETS_DIR)} or "
            f"the bundled presets. Available: {available}"
        )
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def list_presets() -> list[dict]:
    """Return summary info for all available presets, sorted by name.

    User presets (``~/.vibe-trading/swarm/presets/``) are listed alongside the
    bundled roster; when both directories carry the same file stem, the user
    preset wins — the same override rule as user skills.

    Returns:
        List of dicts with keys: name, title, description, agent_count,
        variables, source (``"user"`` or ``"bundled"``).
    """
    by_stem = _listed_preset_data()
    return sorted(
        [
            {
                "name": data.get("name", stem),
                "title": data.get("title", ""),
                "description": data.get("description", ""),
                "agent_count": len(data.get("agents", [])),
                "variables": data.get("variables", []),
                "source": source,
            }
            for stem, (source, data) in by_stem.items()
        ],
        key=lambda entry: entry["name"],
    )


def _listed_preset_data() -> dict[str, tuple[str, dict]]:
    """Load readable preset documents once with user-over-bundled precedence."""
    by_stem: dict[str, tuple[str, dict]] = {}
    for directory, source in ((PRESETS_DIR, "bundled"), (USER_PRESETS_DIR, "user")):
        if not directory.exists():
            continue
        for path in sorted(directory.glob("*.yaml")):
            try:
                data = yaml.safe_load(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(data, dict):
                continue
            # Later iteration (user) intentionally replaces bundled stems.
            by_stem[path.stem] = (source, data)
    return by_stem


def list_preset_catalog() -> list[dict]:
    """Return the allowlisted team, agent, and task definitions for the UI."""
    catalog: list[dict] = []
    limit_fields = ("max_iterations", "timeout_seconds", "max_retries")

    for stem, (source, data) in _listed_preset_data().items():
        agents = []
        raw_agents = data.get("agents", [])
        if not isinstance(raw_agents, list):
            raw_agents = []
        for raw_agent in raw_agents:
            if not isinstance(raw_agent, dict):
                continue
            agent = {
                "id": raw_agent.get("id"),
                "role": raw_agent.get("role", ""),
                "instructions": raw_agent.get("system_prompt", ""),
            }
            for field in ("tools", "skills"):
                if field in raw_agent:
                    agent[field] = raw_agent[field]
            agent["limits"] = {
                field: raw_agent[field]
                for field in limit_fields
                if field in raw_agent
            }
            agents.append(agent)

        tasks = []
        raw_tasks = data.get("tasks", [])
        if not isinstance(raw_tasks, list):
            raw_tasks = []
        for raw_task in raw_tasks:
            if not isinstance(raw_task, dict):
                continue
            task = {
                "id": raw_task.get("id"),
                "agent_id": raw_task.get("agent_id"),
                "prompt_template": raw_task.get("prompt_template", ""),
                "depends_on": raw_task.get("depends_on", []),
            }
            if "input_from" in raw_task:
                task["input_from"] = raw_task["input_from"]
            tasks.append(task)

        catalog.append(
            {
                "name": data.get("name", stem),
                "title": data.get("title", ""),
                "description": data.get("description", ""),
                "source": source,
                "agents": agents,
                "tasks": tasks,
            }
        )

    return sorted(catalog, key=lambda entry: entry["name"])


def _declared_variable_names(raw_variables: list) -> set[str]:
    """Extract variable names from the YAML variables section."""
    names: set[str] = set()
    for item in raw_variables:
        if isinstance(item, dict):
            name = item.get("name")
        else:
            name = str(item)
        if name:
            names.add(str(name))
    return names


def _template_variables(template: str) -> set[str]:
    """Return Python format fields referenced by a prompt template."""
    variables: set[str] = set()
    for _, field_name, _, _ in Formatter().parse(template or ""):
        if not field_name:
            continue
        root = field_name.split(".", 1)[0].split("[", 1)[0]
        if root and root not in _INTERNAL_TEMPLATE_VARS:
            variables.add(root)
    return variables


def _preset_definitions(
    data: dict,
) -> tuple[list[SwarmAgentSpec], list[SwarmTask]]:
    """Build agent and task models from an already parsed preset document."""
    agents = [
        SwarmAgentSpec(
            id=agent_data["id"],
            role=agent_data.get("role", ""),
            system_prompt=agent_data.get("system_prompt", ""),
            tools=agent_data.get("tools", []),
            skills=agent_data.get("skills", []),
            max_iterations=agent_data.get("max_iterations", 25),
            timeout_seconds=agent_data.get("timeout_seconds", 300),
            model_name=agent_data.get("model_name"),
            max_retries=agent_data.get("max_retries", 2),
        )
        for agent_data in data.get("agents", [])
    ]

    tasks = []
    for task_data in data.get("tasks", []):
        depends_on = task_data.get("depends_on", [])
        tasks.append(
            SwarmTask(
                id=task_data["id"],
                agent_id=task_data["agent_id"],
                prompt_template=task_data.get("prompt_template", ""),
                depends_on=depends_on,
                blocked_by=list(depends_on),
                input_from=task_data.get("input_from", {}),
                status=TaskStatus.blocked if depends_on else TaskStatus.pending,
            )
        )
    return agents, tasks


def inspect_preset(name: str) -> dict:
    """Load and validate a preset without starting workers or calling an LLM."""
    return inspect_preset_document(load_preset(name), name)


def inspect_preset_document(data: dict, preset_name: str = "") -> dict:
    """Validate parsed preset data and return its dry-run execution plan."""
    agents, tasks = _preset_definitions(data)

    errors: list[str] = []
    warnings: list[str] = []

    agent_ids = [agent.id for agent in agents]
    task_ids = [task.id for task in tasks]
    agent_id_set = set(agent_ids)
    task_id_set = set(task_ids)

    for duplicate in sorted(item for item, count in Counter(agent_ids).items() if count > 1):
        errors.append(f"Duplicate agent id: {duplicate}")
    for duplicate in sorted(item for item, count in Counter(task_ids).items() if count > 1):
        errors.append(f"Duplicate task id: {duplicate}")

    for task in tasks:
        if task.agent_id not in agent_id_set:
            errors.append(f"Task '{task.id}' references unknown agent '{task.agent_id}'")
        for _, upstream_task_id in task.input_from.items():
            if upstream_task_id not in task_id_set:
                errors.append(
                    f"Task '{task.id}' input_from references unknown task '{upstream_task_id}'"
                )

    layers: list[list[str]] = []
    try:
        validate_dag(tasks)
        layers = topological_layers(tasks)
    except ValueError as exc:
        errors.append(str(exc))

    dependents: dict[str, list[str]] = defaultdict(list)
    for task in tasks:
        for dep in task.depends_on:
            dependents[dep].append(task.id)

    def is_upstream(candidate: str, task_id: str) -> bool:
        """Return whether candidate can reach task_id through dependency edges."""
        seen: set[str] = set()
        stack = [candidate]
        while stack:
            current = stack.pop()
            if current == task_id:
                return True
            if current in seen:
                continue
            seen.add(current)
            stack.extend(dependents.get(current, []))
        return False

    for task in tasks:
        for key, upstream_task_id in task.input_from.items():
            if upstream_task_id in task_id_set and not is_upstream(upstream_task_id, task.id):
                warnings.append(
                    f"Task '{task.id}' input_from '{key}' references '{upstream_task_id}', "
                    "which is not upstream in the DAG"
                )

    declared_variables = _declared_variable_names(data.get("variables", []))
    used_variables: set[str] = set()
    for task in data.get("tasks", []):
        try:
            used_variables.update(_template_variables(task.get("prompt_template", "")))
        except ValueError as exc:
            errors.append(f"Task '{task.get('id', '?')}' has invalid prompt template: {exc}")

    missing_declarations = sorted(used_variables - declared_variables)
    unused_declarations = sorted(declared_variables - used_variables)
    if missing_declarations:
        warnings.append(
            "Prompt templates use undeclared variables: " + ", ".join(missing_declarations)
        )
    if unused_declarations:
        warnings.append(
            "Declared variables are not used by task prompt templates: "
            + ", ".join(unused_declarations)
        )

    task_agent = {task.id: task.agent_id for task in tasks}
    return {
        "name": data.get("name", preset_name),
        "title": data.get("title", ""),
        "description": data.get("description", ""),
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "variables": sorted(declared_variables),
        "used_variables": sorted(used_variables),
        "agents": [
            {"id": agent.id, "role": agent.role, "tools": agent.tools, "skills": agent.skills}
            for agent in agents
        ],
        "tasks": [
            {
                "id": task.id,
                "agent_id": task.agent_id,
                "depends_on": task.depends_on,
                "input_from": task.input_from,
            }
            for task in tasks
        ],
        "layers": [
            [{"task_id": task_id, "agent_id": task_agent.get(task_id, "")} for task_id in layer]
            for layer in layers
        ],
    }


def validate_preset_yaml(yaml_text: str) -> tuple[str | None, dict]:
    """Parse and inspect editor YAML without touching the filesystem."""
    try:
        data = yaml.safe_load(yaml_text)
        if not isinstance(data, dict):
            raise ValueError("YAML root must be a mapping")
        name = data.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Preset name must be a non-empty string")
        if _validate_preset_name(name) != name:
            raise ValueError("Preset name must not contain surrounding whitespace")
        inspection = inspect_preset_document(data, name)
        return name, {
            key: inspection[key]
            for key in ("valid", "errors", "warnings", "layers")
        }
    except yaml.YAMLError as exc:
        errors = [f"Invalid YAML: {exc}"]
    except (AttributeError, KeyError, TypeError, ValueError, ValidationError) as exc:
        errors = [str(exc)]
    return None, {"valid": False, "errors": errors, "warnings": [], "layers": []}


class PresetConflictError(Exception):
    """A preset already exists or the supplied source revision is stale."""


def read_preset_source(name: str) -> dict:
    """Return exact source text and its content revision without its path."""
    path = resolve_preset_path(name)
    if path is None:
        raise FileNotFoundError("Preset not found")
    content = path.read_bytes()
    return {
        "yaml_text": content.decode("utf-8"),
        "source": "user" if path.parent.resolve() == USER_PRESETS_DIR.resolve() else "bundled",
        "revision": hashlib.sha256(content).hexdigest(),
    }


def _atomic_write_user_preset(name: str, yaml_text: str) -> None:
    """Atomically replace one user preset, never writing into the package tree."""
    name = _validate_preset_name(name)
    user_dir = USER_PRESETS_DIR.resolve()
    bundled_dir = PRESETS_DIR.resolve()
    if user_dir == bundled_dir or bundled_dir in user_dir.parents:
        raise ValueError("User preset directory must be outside bundled presets")
    user_dir.mkdir(parents=True, exist_ok=True)
    target = user_dir / f"{name}.yaml"
    fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=user_dir)
    try:
        os.chmod(temp_name, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(yaml_text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, target)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def create_user_preset(name: str, yaml_text: str) -> None:
    """Create a new user preset if neither source already has that name."""
    name = _validate_preset_name(name)
    with _PRESET_WRITE_LOCK:
        if resolve_preset_path(name) is not None:
            raise PresetConflictError("Preset already exists")
        _atomic_write_user_preset(name, yaml_text)


def save_user_preset(name: str, yaml_text: str, expected_revision: str) -> None:
    """Save an edit only if it still matches the source the editor loaded."""
    name = _validate_preset_name(name)
    if not re.fullmatch(r"[0-9a-fA-F]{64}", expected_revision or ""):
        raise PresetConflictError("A valid If-Match revision is required")
    with _PRESET_WRITE_LOCK:
        path = resolve_preset_path(name)
        if path is None:
            raise FileNotFoundError("Preset not found")
        current_revision = hashlib.sha256(path.read_bytes()).hexdigest()
        if current_revision != expected_revision.lower():
            raise PresetConflictError("If-Match revision is stale")
        _atomic_write_user_preset(name, yaml_text)


def build_run_from_preset(preset_name: str, user_vars: dict[str, str]) -> SwarmRun:
    """Create a SwarmRun from a preset with user variables applied.

    Steps:
        1. Load preset YAML
        2. Create SwarmAgentSpec list from agents section
        3. Create SwarmTask list from tasks section
        4. Generate run_id: f"swarm-{datetime}-{uuid[:8]}"
        5. Return SwarmRun with all fields populated

    Args:
        preset_name: Name of the preset to load.
        user_vars: User-provided variables for prompt template rendering.

    Returns:
        Fully constructed SwarmRun instance (status=pending).

    Raises:
        FileNotFoundError: If preset does not exist.
        ValueError: If preset YAML is malformed.
    """
    data = load_preset(preset_name)

    agents, tasks = _preset_definitions(data)

    # Generate run ID
    now = datetime.now(timezone.utc)
    ts = now.strftime("%Y%m%d-%H%M%S")
    short_uuid = uuid.uuid4().hex[:8]
    run_id = f"swarm-{ts}-{short_uuid}"

    return SwarmRun(
        id=run_id,
        preset_name=preset_name,
        status=RunStatus.pending,
        user_vars=user_vars,
        agents=agents,
        tasks=tasks,
        created_at=now.isoformat(),
    )
