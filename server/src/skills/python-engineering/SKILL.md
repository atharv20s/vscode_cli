---
name: python-engineering
description: Modern Python development standards, PEP 8/ruff linting, type hints, asyncio concurrency, pytest suites, and virtual environment isolation.
---

# Modern Python Engineering Standards

Use when working with Python projects, FastAPI/Flask services, data pipelines, or CLI scripts.

## Core Rules
1. **Type Annotations:** Annotate all function parameters and return types using standard PEP 484/585 syntax (`list[str]`, `dict[str, Any]`, `Optional[T]`).
2. **Virtual Environment Hygiene:** Never execute Python globally; always respect the project's active virtual environment (`.venv` or `poetry`/`uv`/`pipenv`).
3. **Async Discipline:** When using `asyncio` or FastAPI, never call blocking synchronous I/O or sleep inside async handlers; use thread pools or native async alternatives.
4. **Data Modeling:** Use Pydantic v2 `BaseModel` or `dataclasses` with validation for external input and configuration parsing.
5. **Testing & Linting:** Run `pytest -q` and `ruff check .` or `flake8` to verify code quality before concluding changes.
