"""Skills CRUD and tools catalog REST contract and auth regressions."""

from __future__ import annotations

import hashlib
import os
import stat
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import api_server
from src.config.accessor import reset_env_config


def _client() -> TestClient:
    return TestClient(api_server.app, client=("127.0.0.1", 50000))


def _remote_client() -> TestClient:
    """Return a TestClient that simulates a non-loopback caller."""
    return TestClient(api_server.app, client=("203.0.113.10", 50000))


@pytest.fixture(autouse=True)
def dev_mode_auth(monkeypatch: pytest.MonkeyPatch):
    """Start every test from dev-mode auth with shell tools disabled."""
    monkeypatch.delenv("API_AUTH_KEY", raising=False)
    monkeypatch.delenv("VIBE_TRADING_ENABLE_SHELL_TOOLS", raising=False)
    monkeypatch.setattr(api_server, "_API_KEY", "")
    reset_env_config()
    yield
    reset_env_config()


@pytest.fixture
def skills_dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    """Route the skills endpoints at isolated on-disk roots."""
    import src.agent.skill_store as skill_store

    bundled_dir = tmp_path / "bundled-skills"
    user_dir = tmp_path / "user-skills"
    bundled_dir.mkdir()
    monkeypatch.setattr(skill_store, "BUNDLED_SKILLS_DIR", bundled_dir)
    monkeypatch.setattr(skill_store, "USER_SKILLS_DIR", user_dir)
    return bundled_dir, user_dir


def _write_skill(
    directory: Path,
    subdir: str,
    name: str,
    description: str = "Does things.",
    body: str = "Body text.",
) -> Path:
    """Create one skill directory whose name may differ from the skill name."""
    skill_dir = directory / subdir
    skill_dir.mkdir(parents=True, exist_ok=True)
    text = (
        "---\n"
        f"name: {name}\n"
        f"description: {description}\n"
        "category: other\n"
        "---\n"
        f"{body}\n"
    )
    # Write raw bytes so the on-disk newline style stays exactly as authored.
    (skill_dir / "SKILL.md").write_bytes(text.encode("utf-8"))
    return skill_dir


def _read(path: Path) -> str:
    return path.read_bytes().decode("utf-8")


def _revision(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Catalog and source reads
# ---------------------------------------------------------------------------


def test_skill_catalog_lists_sources_and_user_shadows_bundled(
    skills_dirs: tuple[Path, Path],
) -> None:
    bundled_dir, user_dir = skills_dirs
    _write_skill(bundled_dir, "alpha-tool", "alpha_tool", description="Bundled alpha.")
    _write_skill(bundled_dir, "beta-tool", "beta_tool", description="Bundled beta.")
    # User skill stored in a directory whose name differs from the skill name.
    _write_skill(user_dir, "custom-dir", "alpha_tool", description="User alpha.")

    response = _client().get("/skills/catalog")

    assert response.status_code == 200
    assert response.json() == [
        {"name": "alpha_tool", "source": "user", "description": "User alpha."},
        {"name": "beta_tool", "source": "bundled", "description": "Bundled beta."},
    ]


def test_skill_source_resolves_by_frontmatter_name_and_keeps_exact_bytes(
    skills_dirs: tuple[Path, Path],
) -> None:
    _, user_dir = skills_dirs
    skill_dir = _write_skill(user_dir, "legacy-dir", "renamed_skill", body="Legacy # body")
    raw = _read(skill_dir / "SKILL.md")

    response = _client().get("/skills/renamed_skill/source")

    assert response.status_code == 200
    assert response.json() == {
        "name": "renamed_skill",
        "source": "user",
        "content": raw,
        "revision": _revision(raw),
    }


def test_skill_source_rejects_unknown_and_traversal_names(
    skills_dirs: tuple[Path, Path],
) -> None:
    assert _client().get("/skills/missing_skill/source").status_code == 404
    assert _client().get("/skills/../escape/source").status_code in {400, 404, 422}


def test_ambiguous_duplicate_user_names_conflict_instead_of_pick(
    skills_dirs: tuple[Path, Path],
) -> None:
    _, user_dir = skills_dirs
    user_dir.mkdir()
    _write_skill(user_dir, "dir-one", "twin_skill")
    _write_skill(user_dir, "dir-two", "twin_skill")

    response = _client().get("/skills/twin_skill/source")

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "name_collision"


def test_symlinked_skill_directories_are_not_followed(
    skills_dirs: tuple[Path, Path], tmp_path: Path
) -> None:
    outside = tmp_path / "outside"
    _, user_dir = skills_dirs
    user_dir.mkdir()
    _write_skill(outside, "escaped", "escaped_skill")
    try:
        os.symlink(outside / "escaped", user_dir / "link", target_is_directory=True)
    except OSError:
        pytest.skip("symlink creation unavailable on this platform")

    assert _client().get("/skills/escaped_skill/source").status_code == 404
    catalog_names = {
        item["name"] for item in _client().get("/skills/catalog").json()
    }
    assert "escaped_skill" not in catalog_names


def test_symlinked_skill_files_are_not_followed(
    skills_dirs: tuple[Path, Path], tmp_path: Path
) -> None:
    """A SKILL.md symlink pointing outside a root must never be read."""
    outside = tmp_path / "outside"
    _, user_dir = skills_dirs
    skill_dir = _write_skill(user_dir, "local", "local_skill")
    outside_skill = _write_skill(outside, "escaped", "escaped_skill")
    try:
        os.symlink(outside_skill / "SKILL.md", skill_dir / "SKILL.md")
    except OSError:
        pytest.skip("symlink creation unavailable on this platform")

    assert _client().get("/skills/local_skill/source").status_code == 404
    assert _client().get("/skills/escaped_skill/source").status_code == 404
    catalog_names = {
        item["name"] for item in _client().get("/skills/catalog").json()
    }
    assert "escaped_skill" not in catalog_names
    assert "local_skill" not in catalog_names


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


def test_create_skill_writes_user_directory_derived_from_name(
    skills_dirs: tuple[Path, Path],
) -> None:
    bundled_dir, user_dir = skills_dirs
    content = "---\nname: my_new_skill\ndescription: Created.\n---\n# keep exact\n"

    response = _client().post("/skills", json={"content": content})

    assert response.status_code == 201
    assert response.json() == {"name": "my_new_skill", "source": "user"}
    target = user_dir / "my_new_skill" / "SKILL.md"
    assert _read(target) == content
    assert list((user_dir / "my_new_skill").glob("*.tmp")) == []
    if os.name == "posix":
        assert stat.S_IMODE(target.stat().st_mode) == 0o600


@pytest.mark.parametrize("existing_source", ["bundled", "user"])
def test_create_skill_rejects_frontmatter_name_collision(
    skills_dirs: tuple[Path, Path], existing_source: str
) -> None:
    bundled_dir, user_dir = skills_dirs
    root = bundled_dir if existing_source == "bundled" else user_dir
    _write_skill(root, "other-dir", "collision_skill")
    content = "---\nname: collision_skill\ndescription: New.\n---\nNew body\n"

    response = _client().post("/skills", json={"content": content})

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "name_collision"
    assert existing_source in detail["message"]
    assert not (user_dir / "collision_skill").exists()


@pytest.mark.parametrize(
    "content",
    [
        "no frontmatter at all\n",
        "---\ndescription: no name\n---\nbody\n",
        "---\nname: ''\ndescription: empty name\n---\nbody\n",
        "---\nname: bad/slash\ndescription: traversal\n---\nbody\n",
        "---\nname: bad\\backslash\ndescription: traversal\n---\nbody\n",
        "---\nname: con\ndescription: reserved device\n---\nbody\n",
        "---\nname: Com1\ndescription: reserved device\n---\nbody\n",
        "---\nname: aux.txt\ndescription: reserved stem\n---\nbody\n",
        "---\nname: trailing.dot.\ndescription: windows invalid\n---\nbody\n",
    ],
)
def test_create_skill_rejects_invalid_frontmatter_without_writing(
    skills_dirs: tuple[Path, Path], content: str
) -> None:
    _, user_dir = skills_dirs

    response = _client().post("/skills", json={"content": content})

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_skill"
    assert not user_dir.exists()


@pytest.mark.parametrize("name", ["nul", "lpt2", "config.", "inner space"])
def test_invalid_identifiers_are_rejected_on_every_operation(
    skills_dirs: tuple[Path, Path], name: str
) -> None:
    """Bundled access stays intact, but unsafe URL names never resolve."""
    bundled_dir, _ = skills_dirs
    _write_skill(bundled_dir, "bundled-dir", "real_skill")

    client = _client()
    assert client.get(f"/skills/{name}/source").status_code == 422
    assert (
        client.put(
            f"/skills/{name}/source",
            headers={"If-Match": "0" * 64},
            json={"content": "x"},
        ).status_code
        == 422
    )
    assert (
        client.delete(f"/skills/{name}/source", headers={"If-Match": "0" * 64}).status_code
        == 422
    )
    # A valid bundled name remains readable.
    assert client.get("/skills/real_skill/source").status_code == 200


@pytest.mark.parametrize("quote", ['"', "'"])
def test_quoted_frontmatter_name_full_crud_roundtrip(
    skills_dirs: tuple[Path, Path], quote: str
) -> None:
    """A quoted frontmatter name is canonicalized consistently across create,
    catalog listing, source read, update, and delete."""
    _, user_dir = skills_dirs
    content = (
        f"---\nname: {quote}quoted_skill{quote}\n"
        "description: Created with quotes.\n"
        "---\n"
        "# body stays exact\n"
    )
    updated = content.replace("Created with quotes.", "Updated.")
    client = _client()

    created = client.post("/skills", json={"content": content})
    assert created.status_code == 201
    assert created.json() == {"name": "quoted_skill", "source": "user"}
    assert _read(user_dir / "quoted_skill" / "SKILL.md") == content

    catalog = client.get("/skills/catalog")
    assert catalog.status_code == 200
    assert {
        "name": "quoted_skill",
        "source": "user",
        "description": "Created with quotes.",
    } in catalog.json()

    read = client.get("/skills/quoted_skill/source")
    assert read.status_code == 200
    assert read.json() == {
        "name": "quoted_skill",
        "source": "user",
        "content": content,
        "revision": _revision(content),
    }

    saved = client.put(
        "/skills/quoted_skill/source",
        headers={"If-Match": _revision(content)},
        json={"content": updated},
    )
    assert saved.status_code == 200
    assert saved.json() == {"name": "quoted_skill", "source": "user"}
    assert _read(user_dir / "quoted_skill" / "SKILL.md") == updated

    deleted = client.delete(
        "/skills/quoted_skill/source", headers={"If-Match": _revision(updated)}
    )
    assert deleted.status_code == 200
    assert deleted.json() == {"name": "quoted_skill", "deleted": True}
    assert not (user_dir / "quoted_skill").exists()


# ---------------------------------------------------------------------------
# Update
# ---------------------------------------------------------------------------


def test_save_skill_updates_existing_directory_in_place(
    skills_dirs: tuple[Path, Path],
) -> None:
    _, user_dir = skills_dirs
    skill_dir = _write_skill(user_dir, "legacy-dir", "renamed_skill", body="Old body")
    old = _read(skill_dir / "SKILL.md")
    new = "---\nname: renamed_skill\ndescription: Updated.\n---\n# updated comment\n"

    response = _client().put(
        "/skills/renamed_skill/source",
        headers={"If-Match": _revision(old)},
        json={"content": new},
    )

    assert response.status_code == 200
    assert _read(skill_dir / "SKILL.md") == new
    # The update keeps the pre-existing directory; it never renames on disk.
    assert skill_dir.name == "legacy-dir"
    assert list(skill_dir.glob("*.tmp")) == []


def test_save_skill_rejects_frontmatter_name_divergence(
    skills_dirs: tuple[Path, Path],
) -> None:
    _, user_dir = skills_dirs
    skill_dir = _write_skill(user_dir, "dir-a", "stable_skill")
    original = _read(skill_dir / "SKILL.md")
    divergent = "---\nname: other_skill\ndescription: x\n---\nbody\n"

    response = _client().put(
        "/skills/stable_skill/source",
        headers={"If-Match": _revision(original)},
        json={"content": divergent},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_skill"
    assert _read(skill_dir / "SKILL.md") == original


@pytest.mark.parametrize("if_match", [None, "not-a-hash", "0" * 64])
def test_save_skill_rejects_missing_or_stale_revision(
    skills_dirs: tuple[Path, Path], if_match: str | None
) -> None:
    _, user_dir = skills_dirs
    skill_dir = _write_skill(user_dir, "dir-b", "revision_skill")
    original = _read(skill_dir / "SKILL.md")
    updated = "---\nname: revision_skill\ndescription: New\n---\nnew\n"
    headers = {} if if_match is None else {"If-Match": if_match}

    response = _client().put(
        "/skills/revision_skill/source", headers=headers, json={"content": updated}
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "revision_stale"
    assert _read(skill_dir / "SKILL.md") == original


def test_bundled_skills_are_read_only(skills_dirs: tuple[Path, Path]) -> None:
    bundled_dir, user_dir = skills_dirs
    skill_dir = _write_skill(bundled_dir, "bundled-dir", "frozen_skill")
    original = _read(skill_dir / "SKILL.md")
    edited = "---\nname: frozen_skill\ndescription: Edited\n---\nedited\n"

    saved = _client().put(
        "/skills/frozen_skill/source",
        headers={"If-Match": _revision(original)},
        json={"content": edited},
    )
    deleted = _client().delete(
        "/skills/frozen_skill/source", headers={"If-Match": _revision(original)}
    )

    assert saved.status_code == 409
    assert saved.json()["detail"]["code"] == "bundled_read_only"
    assert deleted.status_code == 409
    assert deleted.json()["detail"]["code"] == "bundled_read_only"
    assert _read(skill_dir / "SKILL.md") == original
    assert not user_dir.exists()


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------


def test_delete_removes_user_skill_directory_with_revision(
    skills_dirs: tuple[Path, Path],
) -> None:
    _, user_dir = skills_dirs
    skill_dir = _write_skill(user_dir, "doomed", "doomed_skill")
    raw = _read(skill_dir / "SKILL.md")

    response = _client().delete(
        "/skills/doomed_skill/source", headers={"If-Match": _revision(raw)}
    )

    assert response.status_code == 200
    assert response.json() == {"name": "doomed_skill", "deleted": True}
    assert not skill_dir.exists()


def test_delete_refuses_auxiliary_files(skills_dirs: tuple[Path, Path]) -> None:
    _, user_dir = skills_dirs
    skill_dir = _write_skill(user_dir, "rich", "rich_skill")
    (skill_dir / "examples.md").write_text("support file\n", encoding="utf-8")
    raw = _read(skill_dir / "SKILL.md")

    response = _client().delete(
        "/skills/rich_skill/source", headers={"If-Match": _revision(raw)}
    )

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "auxiliary_files_present"
    assert "examples.md" in detail["message"]
    assert skill_dir.exists()


def test_delete_unknown_skill_returns_404(skills_dirs: tuple[Path, Path]) -> None:
    response = _client().delete(
        "/skills/ghost_skill/source", headers={"If-Match": "0" * 64}
    )

    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Tools catalog
# ---------------------------------------------------------------------------


def test_tools_catalog_excludes_shell_tools_and_schemas_when_disabled() -> None:
    response = _client().get("/tools/catalog")

    assert response.status_code == 200
    items = response.json()
    assert items
    assert {item["name"] for item in items}.isdisjoint({"bash", "background_run"})
    assert all(set(item) == {"name", "description"} for item in items)


def test_tools_catalog_includes_shell_tools_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VIBE_TRADING_ENABLE_SHELL_TOOLS", "1")
    reset_env_config()

    response = _client().get("/tools/catalog")

    assert response.status_code == 200
    assert "bash" in {item["name"] for item in response.json()}


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def test_skills_and_tools_endpoints_require_key_for_remote_when_unset() -> None:
    client = _remote_client()

    assert client.get("/skills/catalog").status_code == 403
    assert client.get("/skills/x/source").status_code == 403
    assert client.get("/tools/catalog").status_code == 403
    assert (
        client.post("/skills", json={"content": "---\nname: a\n---\nbody\n"}).status_code
        == 403
    )
    assert (
        client.put(
            "/skills/x/source",
            headers={"If-Match": "0" * 64},
            json={"content": "x"},
        ).status_code
        == 403
    )
    assert (
        client.delete("/skills/x/source", headers={"If-Match": "0" * 64}).status_code
        == 403
    )


def test_mutations_require_bearer_and_reject_cross_site(
    skills_dirs: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("API_AUTH_KEY", "secret")
    monkeypatch.setattr(api_server, "_API_KEY", "secret")
    client = _remote_client()
    content = "---\nname: auth_skill\ndescription: Auth.\n---\nbody\n"
    bearer = {"Authorization": "Bearer secret"}
    cross_site = {**bearer, "Origin": "https://attacker.example"}

    assert client.get("/skills/catalog").status_code == 401
    assert client.get("/tools/catalog").status_code == 401
    assert client.post("/skills", json={"content": content}).status_code == 401

    created = client.post("/skills", headers=bearer, json={"content": content})
    assert created.status_code == 201
    revision = _revision(content)
    assert client.put(
        "/skills/auth_skill/source",
        headers={**cross_site, "If-Match": revision},
        json={"content": content},
    ).status_code == 403
    assert client.delete(
        "/skills/auth_skill/source", headers={**cross_site, "If-Match": revision}
    ).status_code == 403
    # Reads stay available to an authenticated cross-site browser client.
    assert client.get("/skills/catalog", headers=cross_site).status_code == 200

    saved = client.put(
        "/skills/auth_skill/source",
        headers={**bearer, "If-Match": revision},
        json={"content": content},
    )
    assert saved.status_code == 200
    deleted = client.delete(
        "/skills/auth_skill/source", headers={**bearer, "If-Match": revision}
    )
    assert deleted.status_code == 200
