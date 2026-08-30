.PHONY: install format format-check lint test typecheck deadcode build check sweep discord

REPO ?= .
HARNESS_MODEL ?= MiniMax-M3
REF ?=
TIMEOUT_MS ?=
HARNESS_FLAGS = --harness-model "$(HARNESS_MODEL)"
ifneq ($(strip $(REF)),)
HARNESS_FLAGS += --ref "$(REF)"
endif
ifneq ($(strip $(TIMEOUT_MS)),)
HARNESS_FLAGS += --timeout-ms "$(TIMEOUT_MS)"
endif

install:
	pnpm install

format:
	pnpm format

format-check:
	pnpm format:check

lint:
	pnpm lint

test:
	pnpm test

typecheck:
	pnpm typecheck

deadcode:
	pnpm deadcode

build:
	pnpm build

check: format-check lint test typecheck deadcode build

sweep:
	pnpm sweep -- "$(REPO)" $(HARNESS_FLAGS)

discord:
	pnpm discord
