.PHONY: install format format-check lint test typecheck deadcode build check sweep discord web test-coding-worker

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

web:
	pnpm web

test-coding-worker:
	test -n "$(CODING_TEST_IMAGE)"
	CODING_TEST_IMAGE="$(CODING_TEST_IMAGE)" pnpm exec vitest run tests/coding-worker.integration.test.ts tests/coding-runtime.integration.test.ts tests/coding-end-to-end.test.ts
