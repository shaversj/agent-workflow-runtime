# Logging

## Library

Use `structlog` for application logging. When the first runtime logging code is
added, add `structlog` as a runtime dependency and configure it in one shared
module before logging from CLI, harness, or workflow code.

Prefer `structlog.stdlib.get_logger(__name__)` at module scope so application
logs integrate with Python's standard logging handlers. Configure processors in
one place, including log level, timestamp, exception formatting, and a renderer
appropriate for the environment.

Do not use bare `print()` for diagnostics outside intentional CLI user output.

## Event Shape

Logs should be structured and queryable:

- Use stable, lowercase event names such as `readiness_sweep.started` and
  `readiness_sweep.completed`.
- Add context with keyword arguments instead of interpolated message strings.
- Include durable IDs when available, such as `task_id`, `run_id`, and
  `repository_id`.
- Include safe repository context, such as `repo_name` or sanitized path fields,
  when it helps connect logs to reports.

Example shape:

```python
logger.info(
    "readiness_sweep.completed",
    task_id=task_id,
    run_id=run_id,
    finding_count=len(findings),
)
```

## Bound Context

Bind repeated context once at workflow boundaries instead of passing the same
fields through every log call.

For readiness sweeps, useful bound fields include:

- `repo_path` or a sanitized equivalent
- `repo_name`
- `task_id`
- `run_id`

Do not bind secrets, tokens, private keys, or full file contents.

Use `structlog.contextvars` for run-scoped context when a single execution
crosses CLI, harness, workflow, and helper modules. Clear context variables at
the start of each independent sweep.

## Levels

- `debug`: local troubleshooting details that are too noisy for normal runs.
- `info`: lifecycle events a user or operator would expect.
- `warning`: recoverable problems that may affect fidelity or completeness.
- `error`: failed operations that prevent the requested action from completing.

Do not log expected validation findings as errors. Findings belong in the sweep
report and database; logs describe the sweep process itself.

## Privacy

Logs must follow [Security and Privacy](security-and-privacy.md):

- Do not log secret values.
- Do not log raw source file contents.
- Prefer counts, categories, file paths, and line numbers over copied content.
- Be careful with absolute paths because they can reveal private directory
  names when logs are shared.

## Tests

When logging behavior becomes part of the contract, test event names and critical
context fields. Avoid tests that freeze incidental processor output or exact log
formatting.
