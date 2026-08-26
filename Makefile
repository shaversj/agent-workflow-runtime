.PHONY: install format format-check lint test typecheck check sweep

REPO ?= .
HARNESS_MODEL ?= MiniMax-M3
HARNESS_FLAGS = --harness-model "$(HARNESS_MODEL)"

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

sweep:
	uv run agent-ops sweep "$(REPO)" $(HARNESS_FLAGS)
