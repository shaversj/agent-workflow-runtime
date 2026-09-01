# Standards

These standards are the durable working rules for Agent Ops Kit. Keep `AGENTS.md`
short and directive, then put detailed guidance here.

Consult the relevant standard before changing the related surface:

- [Development Workflow](development-workflow.md) - setup, common commands, validation order
- [Dependency Management](dependency-management.md) - `pnpm`, Node.js versions, lockfile handling
- [Formatting](formatting.md) - Prettier, ESLint, and TypeScript compiler formatting boundaries
- [Testing](testing.md) - test organization, coverage expectations, verification evidence
- [Runtime Contracts](runtime-contracts.md) - TypeBox validation, boundary parsing, workflow and tool result contracts
- [Database](database.md) - Drizzle, SQLite state, schema review
- [CLI and Reports](cli-and-reports.md) - CLI commands, local output, report behavior
- [Logging](logging.md) - Pino events, levels, context, privacy
- [Static Analysis](static-analysis.md) - TypeScript, ESLint, Knip, and future Semgrep checks
- [Security and Privacy](security-and-privacy.md) - read-only defaults, secret handling, safe artifacts

Add a new standard only when the repo grows a durable surface that future work
will repeatedly touch. Prefer updating an existing standard over creating a
near-duplicate page.
