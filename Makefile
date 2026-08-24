.PHONY: install format format-check lint test typecheck check dev sweep

REPO ?= .

install:
	uv sync

format:
	uv run ruff format .

format-check:
	uv run ruff format --check .

lint:
	uv run ruff check .

test:
	uv run pytest

typecheck:
	uv run mypy

check: format-check lint test typecheck

dev:
	uv run fastapi dev src/agent_ops_kit/api.py

sweep:
	uv run agent-ops sweep "$(REPO)"
