# Development Workflow

## Canonical Commands

Use the Makefile as the project command interface.

```bash
make install
make format
make lint
make test
make typecheck
make check
```

Run `make install` once per clone, worktree, or recreated virtual environment
before validation. It is the canonical dependency sync command.

## Validation Expectations

Before handing off code changes, run the smallest useful check first, then the
full relevant gate:

- Documentation-only changes: inspect links and formatting manually.
- TypeScript behavior changes: run focused tests first, then `make check`.
- Database changes: review Drizzle schema/bootstrap changes plus `make check`.
- CLI or harness behavior changes: run tests that exercise the public boundary, then
  `make check`.

If a check cannot be run, record the reason and the risk clearly in the handoff.

## Documentation Updates

Update `README.md` when changes affect:

- installation steps
- common commands
- project structure
- development workflow
- user-facing CLI behavior

Keep `AGENTS.md` focused on agent instructions. Put reusable project standards
under `docs/standards/`.
