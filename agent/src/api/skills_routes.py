"""Skills CRUD and tool catalog HTTP routes.

Mounted by ``agent/api_server.py`` via ``register_skills_routes(app, ...)``.
Identity and persistence live in ``src.agent.skill_store``; these handlers
translate results and errors into HTTP semantics:

- GETs use ``require_auth``; every mutation uses ``require_settings_write_auth``
  (API key plus the cross-site browser guard).
- Conflicts return 409 with ``detail.code``: ``name_collision``,
  ``revision_stale``, ``bundled_read_only`` or ``auxiliary_files_present``.
- Invalid identifiers/documents return 422 with ``detail.code=invalid_skill``.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, StrictStr

from src.agent.skill_store import SkillConflictError, SkillValidationError

AuthDep = Callable[..., Awaitable[Any] | Any]


class SkillContent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: StrictStr


def register_skills_routes(
    app: FastAPI,
    require_auth: AuthDep | None = None,
    require_settings_write_auth: AuthDep | None = None,
) -> None:
    """Mount the skills and tools catalog routes onto ``app``.

    Resolves auth dependencies from the host ``api_server`` module via
    ``sys.modules`` when not passed explicitly.
    """
    import sys as _sys

    host = _sys.modules.get("api_server") or _sys.modules.get("agent.api_server")
    if host is None:
        raise RuntimeError(
            "register_skills_routes: api_server module not in sys.modules; "
            "ensure api_server is imported before calling this function"
        )

    if require_auth is None:
        require_auth = host.require_auth
    if require_settings_write_auth is None:
        require_settings_write_auth = host.require_settings_write_auth

    def _conflict(exc: SkillConflictError) -> HTTPException:
        return HTTPException(
            status_code=409, detail={"code": exc.code, "message": exc.message}
        )

    def _invalid(exc: SkillValidationError) -> HTTPException:
        return HTTPException(
            status_code=422, detail={"code": "invalid_skill", "message": exc.message}
        )

    # --- Skills ---

    @app.get("/skills/catalog", dependencies=[Depends(require_auth)])
    async def list_skill_catalog():
        """List visible skills (bundled and user) with their source."""
        from src.agent.skill_store import list_skill_catalog

        return list_skill_catalog()

    @app.get("/skills/{name}/source", dependencies=[Depends(require_auth)])
    async def get_skill_source(name: str):
        """Return a skill's exact SKILL.md content and revision."""
        from src.agent.skill_store import read_skill_source

        try:
            return read_skill_source(name)
        except SkillValidationError as exc:
            raise _invalid(exc) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except SkillConflictError as exc:
            raise _conflict(exc) from exc
        except (OSError, UnicodeError) as exc:
            raise HTTPException(status_code=500, detail="Failed to read skill") from exc

    @app.post(
        "/skills",
        status_code=201,
        dependencies=[Depends(require_settings_write_auth)],
    )
    async def create_skill(payload: SkillContent):
        from src.agent.skill_store import create_user_skill

        try:
            return create_user_skill(payload.content)
        except SkillValidationError as exc:
            raise _invalid(exc) from exc
        except SkillConflictError as exc:
            raise _conflict(exc) from exc
        except OSError as exc:
            raise HTTPException(status_code=500, detail="Failed to save skill") from exc

    @app.put(
        "/skills/{name}/source",
        dependencies=[Depends(require_settings_write_auth)],
    )
    async def save_skill_source(
        name: str,
        payload: SkillContent,
        if_match: str | None = Header(default=None, alias="If-Match"),
    ):
        from src.agent.skill_store import save_user_skill

        try:
            return save_user_skill(name, payload.content, if_match or "")
        except SkillValidationError as exc:
            raise _invalid(exc) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except SkillConflictError as exc:
            raise _conflict(exc) from exc
        except (OSError, UnicodeError) as exc:
            raise HTTPException(status_code=500, detail="Failed to save skill") from exc

    @app.delete(
        "/skills/{name}/source",
        dependencies=[Depends(require_settings_write_auth)],
    )
    async def delete_skill_source(
        name: str,
        if_match: str | None = Header(default=None, alias="If-Match"),
    ):
        from src.agent.skill_store import delete_user_skill

        try:
            return delete_user_skill(name, if_match or "")
        except SkillValidationError as exc:
            raise _invalid(exc) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except SkillConflictError as exc:
            raise _conflict(exc) from exc
        except OSError as exc:
            raise HTTPException(status_code=500, detail="Failed to delete skill") from exc

    # --- Tools ---

    @app.get("/tools/catalog", dependencies=[Depends(require_auth)])
    async def list_tool_catalog():
        """Allowlisted local tool names for the UI.

        Builds the same local registry the runtime uses — ``agent_config=None``
        never connects a remote MCP server and no tool is executed. Shell
        tools appear only when the server configuration enables them
        (``include_shell_tools=_env_shell_tools_enabled()``). Only
        ``function.name`` and ``function.description`` are projected; schemas,
        credentials and availability of remote MCP tools stay out of the
        response.
        """
        from src.api.security import _env_shell_tools_enabled
        from src.tools import build_registry

        registry = build_registry(
            include_shell_tools=_env_shell_tools_enabled(),
            agent_config=None,
        )
        catalog = []
        for schema in registry.get_definitions():
            function = (schema or {}).get("function") or {}
            name = function.get("name")
            if name:
                catalog.append(
                    {"name": name, "description": function.get("description", "")}
                )
        return catalog
