"""Public swarm REST and SSE contract regressions."""

from __future__ import annotations

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
