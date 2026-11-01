"""Tests for swarm preset inspection and static validation."""

from __future__ import annotations

from pathlib import Path

from src.swarm import presets


def _inspect_document(data: dict) -> dict:
    validator = getattr(presets, "inspect_preset_document", None)
    assert callable(validator), "inspect_preset_document must inspect parsed YAML data"
    return validator(data, "requested_name")


def test_all_bundled_presets_inspect_without_errors() -> None:
    """Bundled presets should have valid agent/task references and DAGs."""
    for entry in presets.list_presets():
        report = presets.inspect_preset(entry["name"])
        assert report["valid"], f"{entry['name']} errors: {report['errors']}"
        assert report["layers"], f"{entry['name']} has no execution layers"


def test_inspect_preset_returns_dry_run_layers() -> None:
    report = presets.inspect_preset("investment_committee")

    assert report["valid"]
    assert report["variables"] == ["market", "target"]
    assert report["layers"][0] == [
        {"task_id": "task-bull", "agent_id": "bull_advocate"},
        {"task_id": "task-bear", "agent_id": "bear_advocate"},
    ]
    assert report["layers"][-1] == [
        {"task_id": "task-decision", "agent_id": "portfolio_manager"}
    ]


def test_inspect_preset_reports_invalid_references(
    tmp_path: Path,
    monkeypatch,
) -> None:
    preset_dir = tmp_path / "presets"
    preset_dir.mkdir()
    (preset_dir / "broken.yaml").write_text(
        """
name: broken
title: Broken Preset
agents:
  - id: analyst
    role: Analyst
    system_prompt: ""
tasks:
  - id: task-a
    agent_id: missing_agent
    prompt_template: "Analyze {target}"
    depends_on: [missing_task]
variables:
  - name: market
""",
        encoding="utf-8",
    )

    monkeypatch.setattr(presets, "PRESETS_DIR", preset_dir)

    report = presets.inspect_preset("broken")

    assert not report["valid"]
    assert "Task 'task-a' references unknown agent 'missing_agent'" in report["errors"]
    assert "Task 'task-a' depends on unknown task 'missing_task'" in report["errors"]
    assert "Prompt templates use undeclared variables: target" in report["warnings"]
    assert "Declared variables are not used by task prompt templates: market" in report["warnings"]


def test_inspect_preset_document_builds_parallel_and_dependent_layers() -> None:
    report = _inspect_document(
        {
            "name": "research_team",
            "title": "Research Team",
            "description": "",
            "agents": [
                {"id": "analyst_a", "role": "Analyst A"},
                {"id": "analyst_b", "role": "Analyst B"},
                {"id": "editor", "role": "Editor"},
            ],
            "tasks": [
                {"id": "task-a", "agent_id": "analyst_a", "prompt_template": "Study {topic}"},
                {"id": "task-b", "agent_id": "analyst_b", "prompt_template": "Check {topic}"},
                {
                    "id": "task-edit",
                    "agent_id": "editor",
                    "prompt_template": "Combine {upstream_context}",
                    "depends_on": ["task-a", "task-b"],
                    "input_from": {"first": "task-a", "second": "task-b"},
                },
            ],
            "variables": [{"name": "topic"}],
        }
    )

    assert report["valid"] is True
    assert report["errors"] == []
    assert report["warnings"] == []
    assert report["layers"] == [
        [
            {"task_id": "task-a", "agent_id": "analyst_a"},
            {"task_id": "task-b", "agent_id": "analyst_b"},
        ],
        [{"task_id": "task-edit", "agent_id": "editor"}],
    ]
    assert report["name"] == "research_team"


def test_inspect_preset_document_reports_duplicate_agent_and_task_ids() -> None:
    report = _inspect_document(
        {
            "name": "duplicate_ids",
            "agents": [
                {"id": "analyst", "role": "First"},
                {"id": "analyst", "role": "Second"},
            ],
            "tasks": [
                {"id": "task-a", "agent_id": "analyst"},
                {"id": "task-a", "agent_id": "analyst"},
            ],
        }
    )

    assert report["valid"] is False
    assert "Duplicate agent id: analyst" in report["errors"]
    assert "Duplicate task id: task-a" in report["errors"]


def test_inspect_preset_document_reports_unknown_agent_dependency_and_input() -> None:
    report = _inspect_document(
        {
            "name": "unknown_references",
            "agents": [{"id": "analyst", "role": "Analyst"}],
            "tasks": [
                {
                    "id": "task-a",
                    "agent_id": "missing_agent",
                    "depends_on": ["missing_dependency"],
                    "input_from": {"result": "missing_input"},
                }
            ],
        }
    )

    assert report["valid"] is False
    assert "Task 'task-a' references unknown agent 'missing_agent'" in report["errors"]
    assert "Task 'task-a' depends on unknown task 'missing_dependency'" in report["errors"]
    assert "Task 'task-a' input_from references unknown task 'missing_input'" in report["errors"]


def test_inspect_preset_document_reports_dependency_cycles() -> None:
    report = _inspect_document(
        {
            "name": "cycle",
            "agents": [{"id": "analyst", "role": "Analyst"}],
            "tasks": [
                {"id": "task-a", "agent_id": "analyst", "depends_on": ["task-b"]},
                {"id": "task-b", "agent_id": "analyst", "depends_on": ["task-a"]},
            ],
        }
    )

    assert report["valid"] is False
    assert any(error.startswith("Cycle detected in task DAG:") for error in report["errors"])


def test_inspect_preset_document_preserves_template_variable_warnings() -> None:
    report = _inspect_document(
        {
            "name": "template_warnings",
            "agents": [{"id": "analyst", "role": "Analyst"}],
            "tasks": [
                {"id": "task-a", "agent_id": "analyst", "prompt_template": "Study {ticker}"}
            ],
            "variables": [{"name": "market"}],
        }
    )

    assert report["valid"] is True
    assert report["warnings"] == [
        "Prompt templates use undeclared variables: ticker",
        "Declared variables are not used by task prompt templates: market",
    ]
