"""Public swarm REST and SSE contract regressions."""

from __future__ import annotations

import hashlib
import os
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import api_server
import src.api.swarm_routes as swarm_routes
from src.swarm.models import RunStatus, SwarmEvent, SwarmRun, SwarmTask
from src.swarm.store import SwarmStore


@pytest.fixture
def swarm_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SwarmStore:
    """Route the process-wide swarm endpoint at an isolated on-disk store."""
    store = SwarmStore(base_dir=tmp_path / "runs")
    monkeypatch.delenv("API_AUTH_KEY", raising=False)
    monkeypatch.setattr(api_server, "_API_KEY", "")
    monkeypatch.setattr(swarm_routes, "_swarm_runtime", SimpleNamespace(_store=store))
    return store


def _client() -> TestClient:
    return TestClient(api_server.app, client=("127.0.0.1", 50000))


@pytest.fixture
def preset_directories(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    bundled_dir = tmp_path / "bundled-presets"
    user_dir = tmp_path / "user-presets"
    bundled_dir.mkdir()
    monkeypatch.setattr("src.swarm.presets.PRESETS_DIR", bundled_dir)
    monkeypatch.setattr("src.swarm.presets.USER_PRESETS_DIR", user_dir)
    return bundled_dir, user_dir


def _revision(yaml_text: str) -> str:
    return hashlib.sha256(yaml_text.encode("utf-8")).hexdigest()


def _create_run(
    store: SwarmStore,
    *,
    run_id: str = "run-contract",
    status: RunStatus = RunStatus.pending,
    tasks: list[SwarmTask] | None = None,
) -> SwarmRun:
    run = SwarmRun(
        id=run_id,
        preset_name="contract-test",
        status=status,
        created_at="2026-07-16T00:00:00+00:00",
        completed_at=(
            "2026-07-16T00:00:01+00:00" if status == RunStatus.completed else None
        ),
        tasks=tasks or [],
    )
    store.create_run(run)
    return run


def test_swarm_events_returns_404_before_streaming_missing_run(
    swarm_store: SwarmStore,
) -> None:
    response = _client().get("/swarm/runs/missing-run/events")

    assert response.status_code == 404
    assert response.json()["detail"] == "Run missing-run not found"


def test_swarm_events_resumes_from_last_event_id_header(
    swarm_store: SwarmStore,
) -> None:
    run = _create_run(swarm_store, status=RunStatus.completed)
    for index in range(1, 4):
        swarm_store.append_event(
            run.id,
            SwarmEvent(
                type=f"step_{index}",
                data={"index": index},
                timestamp=f"2026-07-16T00:00:0{index}+00:00",
            ),
        )

    response = _client().get(
        f"/swarm/runs/{run.id}/events?last_index=1",
        headers={"Last-Event-ID": "2"},
    )

    assert response.status_code == 200
    assert "event: step_1" not in response.text
    assert "event: step_2" not in response.text
    assert "id: 3\nevent: step_3" in response.text
    assert 'event: done\ndata: {"status": "completed"}' in response.text


def test_swarm_events_keeps_last_index_query_compatibility(
    swarm_store: SwarmStore,
) -> None:
    run = _create_run(swarm_store, status=RunStatus.completed)
    for index in range(1, 3):
        swarm_store.append_event(
            run.id,
            SwarmEvent(
                type=f"query_step_{index}",
                timestamp=f"2026-07-16T00:00:0{index}+00:00",
            ),
        )

    response = _client().get(f"/swarm/runs/{run.id}/events?last_index=1")

    assert response.status_code == 200
    assert "event: query_step_1" not in response.text
    assert "id: 2\nevent: query_step_2" in response.text


def test_swarm_detail_uses_redacted_public_task_projection(
    swarm_store: SwarmStore,
) -> None:
    internal_path = str(
        Path.cwd() / "agent" / ".swarm" / "runs" / "secret" / "task.log"
    )
    _create_run(
        swarm_store,
        tasks=[
            SwarmTask(
                id="task-1",
                agent_id="analyst",
                prompt_template="internal prompt",
                summary="Public summary",
                artifacts=[internal_path],
                error=f"failed while reading {internal_path}",
                worker_iterations=3,
            )
        ],
    )

    response = _client().get("/swarm/runs/run-contract")

    assert response.status_code == 200
    task = response.json()["tasks"][0]
    assert task["summary"] == "Public summary"
    assert "<redacted>" in task["error"]
    assert internal_path not in response.text
    assert "artifacts" not in task
    assert "prompt_template" not in task
    assert task["worker_iterations"] == 3
    assert task["iterations"] == 3


def test_swarm_preset_catalog_is_allowlisted_and_summary_stays_compatible(
    swarm_store: SwarmStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    presets_dir = tmp_path / "presets"
    presets_dir.mkdir()
    (presets_dir / "public_team.yaml").write_text(
        """\
name: public_team
title: Public Team
description: A test team.
agents:
  - id: analyst
    role: Research Analyst
    system_prompt: private prompt
    tools: [read_file]
    skills: [fundamental-filter]
    max_iterations: 7
    timeout_seconds: 120
    max_retries: 2
    model_name: internal-model-name
    extra_agent_key: hidden
  - id: reviewer
    role: Reviewer
    system_prompt: Review the result.
tasks:
  - id: task-research
    agent_id: analyst
    prompt_template: Analyze {ticker}.
    depends_on: []
    extra_task_key: hidden
  - id: task-review
    agent_id: reviewer
    prompt_template: Review the analysis.
    depends_on: [task-research]
    input_from: {analysis: task-research}
extra_preset_key: hidden
""",
        encoding="utf-8",
    )
    (presets_dir / "variant_team.yaml").write_text(
        """\
name: variant_team
title: Variant Team
description: A second team with a different analyst definition.
agents:
  - id: analyst
    role: Technical Analyst
    system_prompt: Analyze price structure.
    max_iterations: 3
""",
        encoding="utf-8",
    )
    monkeypatch.setattr("src.swarm.presets.PRESETS_DIR", presets_dir)
    monkeypatch.setattr("src.swarm.presets.USER_PRESETS_DIR", tmp_path / "user-presets")

    client = _client()
    summary_response = client.get("/swarm/presets")
    response = client.get("/swarm/presets/catalog")

    assert response.status_code == 200
    presets = {preset["name"]: preset for preset in response.json()}
    preset = presets["public_team"]
    assert preset == {
        "name": "public_team",
        "title": "Public Team",
        "description": "A test team.",
        "source": "bundled",
        "agents": [
            {
                "id": "analyst",
                "role": "Research Analyst",
                "instructions": "private prompt",
                "tools": ["read_file"],
                "skills": ["fundamental-filter"],
                "limits": {
                    "max_iterations": 7,
                    "timeout_seconds": 120,
                    "max_retries": 2,
                },
            },
            {
                "id": "reviewer",
                "role": "Reviewer",
                "instructions": "Review the result.",
                "limits": {},
            },
        ],
        "tasks": [
            {
                "id": "task-research",
                "agent_id": "analyst",
                "prompt_template": "Analyze {ticker}.",
                "depends_on": [],
            },
            {
                "id": "task-review",
                "agent_id": "reviewer",
                "prompt_template": "Review the analysis.",
                "depends_on": ["task-research"],
                "input_from": {"analysis": "task-research"},
            },
        ],
    }
    assert presets["variant_team"]["agents"] == [
        {
            "id": "analyst",
            "role": "Technical Analyst",
            "instructions": "Analyze price structure.",
            "limits": {"max_iterations": 3},
        }
    ]
    assert presets["variant_team"]["tasks"] == []
    assert "extra_agent_key" not in response.text
    assert "internal-model-name" not in response.text
    assert "extra_task_key" not in response.text
    assert "extra_preset_key" not in response.text
    assert client.post("/swarm/presets/catalog").status_code == 405

    assert summary_response.status_code == 200
    summaries = {preset["name"]: preset for preset in summary_response.json()}
    assert summaries["public_team"] == {
        "name": "public_team",
        "title": "Public Team",
        "description": "A test team.",
        "agent_count": 2,
        "variables": [],
        "source": "bundled",
    }
    assert summaries["variant_team"]["agent_count"] == 1


def test_swarm_preset_source_returns_exact_effective_user_yaml(
    swarm_store: SwarmStore, preset_directories: tuple[Path, Path]
) -> None:
    bundled_dir, user_dir = preset_directories
    bundled_text = "name: editor_team\ntitle: Bundled\nagents: []\ntasks: []\n"
    user_text = "# keep comment\nname: editor_team\ntitle: User\nagents: []\ntasks: []\n"
    (bundled_dir / "editor_team.yaml").write_bytes(bundled_text.encode())
    user_dir.mkdir()
    (user_dir / "editor_team.yaml").write_bytes(user_text.encode())

    response = _client().get("/swarm/presets/editor_team/source")

    assert response.status_code == 200
    assert response.json() == {
        "yaml_text": user_text,
        "source": "user",
        "revision": _revision(user_text),
    }
    assert str(user_dir) not in response.text
    assert str(bundled_dir) not in response.text


def test_swarm_preset_validation_returns_dag_preview_without_writing(
    swarm_store: SwarmStore, preset_directories: tuple[Path, Path]
) -> None:
    bundled_dir, user_dir = preset_directories
    yaml_text = """\
name: validate_team
title: Validate Team
agents:
  - id: analyst
    role: Analyst
tasks:
  - id: task-analysis
    agent_id: analyst
    prompt_template: "Analyze {ticker}"
    depends_on: []
variables:
  - name: ticker
"""

    response = _client().post("/swarm/presets/validate", json={"yaml_text": yaml_text})

    assert response.status_code == 200
    assert response.json() == {
        "valid": True,
        "errors": [],
        "warnings": [],
        "layers": [[{"task_id": "task-analysis", "agent_id": "analyst"}]],
    }
    assert not user_dir.exists()
    assert list(bundled_dir.iterdir()) == []


def test_swarm_preset_validation_returns_errors_for_malformed_yaml(
    swarm_store: SwarmStore, preset_directories: tuple[Path, Path]
) -> None:
    bundled_dir, user_dir = preset_directories

    response = _client().post("/swarm/presets/validate", json={"yaml_text": "name: ["})

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["valid"] is False
    assert detail["errors"]
    assert detail["warnings"] == []
    assert detail["layers"] == []
    assert not user_dir.exists()
    assert list(bundled_dir.iterdir()) == []


def test_create_swarm_preset_preserves_yaml_and_writes_only_to_user_directory(
    swarm_store: SwarmStore, preset_directories: tuple[Path, Path]
) -> None:
    bundled_dir, user_dir = preset_directories
    yaml_text = """\
# exact source comment
name: new_editor_team
title: New Editor Team
vendor_extension: keep this unknown field
agents:
  - id: analyst
    role: Analyst
tasks:
  - id: task-analysis
    agent_id: analyst
    prompt_template: "Analyze {ticker}"
    depends_on: []
variables:
  - name: ticker
"""

    response = _client().post("/swarm/presets", json={"yaml_text": yaml_text})

    assert response.status_code == 201
    target = user_dir / "new_editor_team.yaml"
    assert target.read_bytes() == yaml_text.encode("utf-8")
    assert not (bundled_dir / target.name).exists()
    assert list(user_dir.glob("*.tmp")) == []
    if os.name == "posix":
        assert stat.S_IMODE(target.stat().st_mode) == 0o600


@pytest.mark.parametrize("existing_source", ["bundled", "user"])
def test_create_swarm_preset_rejects_existing_names_without_modifying_source(
    swarm_store: SwarmStore,
    preset_directories: tuple[Path, Path],
    existing_source: str,
) -> None:
    bundled_dir, user_dir = preset_directories
    existing_text = "name: collision_team\nagents: []\ntasks: []\n"
    existing_dir = bundled_dir if existing_source == "bundled" else user_dir
    existing_dir.mkdir(exist_ok=True)
    target = existing_dir / "collision_team.yaml"
    target.write_bytes(existing_text.encode())
    new_text = "name: collision_team\nagents: []\ntasks: []\n"

    response = _client().post("/swarm/presets", json={"yaml_text": new_text})

    assert response.status_code == 409
    assert target.read_bytes() == existing_text.encode()
    assert not user_dir.exists() or list(user_dir.glob("*.tmp")) == []


@pytest.mark.parametrize(
    ("yaml_text", "error_fragment"),
    [
        ("name: [", "YAML"),
        (
            "name: duplicate_team\nagents:\n  - {id: analyst}\n  - {id: analyst}\ntasks: []\n",
            "Duplicate agent id",
        ),
        (
            "name: missing_team\nagents:\n  - {id: analyst}\ntasks:\n  - {id: task-a, agent_id: missing}\n",
            "unknown agent",
        ),
        (
            "name: cycle_team\nagents:\n  - {id: analyst}\ntasks:\n  - {id: a, agent_id: analyst, depends_on: [b]}\n  - {id: b, agent_id: analyst, depends_on: [a]}\n",
            "cycle",
        ),
        (
            "name: bad_input_team\nagents:\n  - {id: analyst}\ntasks:\n  - {id: task-a, agent_id: analyst, input_from: invalid}\n",
            "input_from",
        ),
    ],
)
def test_create_swarm_preset_rejects_invalid_documents_without_writing(
    swarm_store: SwarmStore,
    preset_directories: tuple[Path, Path],
    yaml_text: str,
    error_fragment: str,
) -> None:
    bundled_dir, user_dir = preset_directories

    response = _client().post("/swarm/presets", json={"yaml_text": yaml_text})

    assert response.status_code == 422
    assert error_fragment.lower() in response.json()["detail"]["errors"][0].lower()
    assert not user_dir.exists()
    assert list(bundled_dir.iterdir()) == []


def test_create_swarm_preset_rejects_name_mismatch_and_path_traversal(
    swarm_store: SwarmStore, preset_directories: tuple[Path, Path]
) -> None:
    bundled_dir, user_dir = preset_directories
    current_text = "name: requested_team\nagents: []\ntasks: []\n"
    (bundled_dir / "requested_team.yaml").write_bytes(current_text.encode())
    yaml_text = "name: declared_team\nagents: []\ntasks: []\n"

    response = _client().put(
        "/swarm/presets/requested_team/source",
        headers={"If-Match": _revision(current_text)},
        json={"yaml_text": yaml_text},
    )
    traversal = _client().get("/swarm/presets/../escape/source")

    assert response.status_code == 422
    assert "name" in response.json()["detail"]["errors"][0].lower()
    assert traversal.status_code in {400, 404}
    assert not user_dir.exists()
    assert (bundled_dir / "requested_team.yaml").read_bytes() == current_text.encode()


def test_save_swarm_preset_updates_user_source_with_matching_revision(
    swarm_store: SwarmStore, preset_directories: tuple[Path, Path]
) -> None:
    _, user_dir = preset_directories
    user_dir.mkdir()
    old_text = "# old comment\nname: save_team\ntitle: Old\nagents: []\ntasks: []\n"
    new_text = "# keep updated comment\nname: save_team\ntitle: Updated\nagents: []\ntasks: []\n"
    target = user_dir / "save_team.yaml"
    target.write_bytes(old_text.encode())

    response = _client().put(
        "/swarm/presets/save_team/source",
        headers={"If-Match": _revision(old_text)},
        json={"yaml_text": new_text},
    )

    assert response.status_code == 200
    assert target.read_bytes() == new_text.encode("utf-8")
    assert list(user_dir.glob("*.tmp")) == []


def test_save_bundled_swarm_preset_creates_user_copy_without_changing_bundle(
    swarm_store: SwarmStore, preset_directories: tuple[Path, Path]
) -> None:
    bundled_dir, user_dir = preset_directories
    old_text = "# bundled source\nname: bundled_team\ntitle: Bundled\nagents: []\ntasks: []\n"
    new_text = "# edited copy\nname: bundled_team\ntitle: User Override\nagents: []\ntasks: []\n"
    bundled_target = bundled_dir / "bundled_team.yaml"
    bundled_target.write_bytes(old_text.encode())

    response = _client().put(
        "/swarm/presets/bundled_team/source",
        headers={"If-Match": _revision(old_text)},
        json={"yaml_text": new_text},
    )

    assert response.status_code == 200
    assert bundled_target.read_bytes() == old_text.encode()
    assert (user_dir / bundled_target.name).read_bytes() == new_text.encode()


@pytest.mark.parametrize("if_match", [None, "invalid", "0" * 64])
def test_save_swarm_preset_rejects_missing_invalid_or_stale_revision(
    swarm_store: SwarmStore,
    preset_directories: tuple[Path, Path],
    if_match: str | None,
) -> None:
    _, user_dir = preset_directories
    user_dir.mkdir()
    current_text = "name: revision_team\nagents: []\ntasks: []\n"
    target = user_dir / "revision_team.yaml"
    target.write_bytes(current_text.encode())
    new_text = "name: revision_team\ntitle: Changed\nagents: []\ntasks: []\n"
    headers = {} if if_match is None else {"If-Match": if_match}

    response = _client().put(
        "/swarm/presets/revision_team/source",
        headers=headers,
        json={"yaml_text": new_text},
    )

    assert response.status_code == 409
    assert "if-match" in response.json()["detail"].lower()
    assert target.read_bytes() == current_text.encode()
    assert list(user_dir.glob("*.tmp")) == []


def test_atomic_save_failure_keeps_old_user_preset_and_cleans_temp(
    swarm_store: SwarmStore,
    preset_directories: tuple[Path, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, user_dir = preset_directories
    user_dir.mkdir()
    old_text = "name: atomic_team\ntitle: Old\nagents: []\ntasks: []\n"
    target = user_dir / "atomic_team.yaml"
    target.write_bytes(old_text.encode())
    new_text = "name: atomic_team\ntitle: New\nagents: []\ntasks: []\n"

    def fail_replace(*args: object, **kwargs: object) -> None:
        raise OSError("simulated replace failure")

    monkeypatch.setattr(os, "replace", fail_replace)
    response = _client().put(
        "/swarm/presets/atomic_team/source",
        headers={"If-Match": _revision(old_text)},
        json={"yaml_text": new_text},
    )

    assert response.status_code == 500
    assert str(user_dir) not in response.text
    assert target.read_bytes() == old_text.encode()
    assert list(user_dir.glob("*.tmp")) == []
