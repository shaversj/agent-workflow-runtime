# Contributing

## Set Up

Agent Ops Kit supports Node.js 24 and pnpm 10. Work from a source checkout:

```bash
make install
make check
pnpm test:web
```

Docker is required only for the real coding-worker containment suite. The required image and command
are documented in the README.

## Make A Change

- Read `AGENTS.md` and the relevant file in `docs/standards/` first.
- Keep changes within the existing plugin, surface, workflow, workspace, or persistence boundary.
- Add focused tests for changed behavior and run `make check` before opening a pull request.
- Update documentation when commands, configuration, architecture, or user-visible behavior changes.
- Never commit credentials, private repository content, generated local history, or `.env` files.

Pull requests should explain the user-visible outcome, trust-boundary impact, verification performed,
and any remaining operational step. Use GitHub's private vulnerability reporting instead of a pull
request for security-sensitive findings.

This repository is source-distributed. Do not add npm publication or global installation claims
without an explicit package-distribution design.
