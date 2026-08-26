# Logging

## Library

Use Pino for application logging. Configure it in one shared module before logging from CLI, harness, or workflow code.

Do not use `console.log()` for diagnostics outside intentional CLI user output.

## Event Shape

Logs should be structured and queryable:

- Use stable event messages such as `readiness_sweep.started` and `readiness_sweep.completed`.
- Add context as object fields instead of interpolated strings.
- Include durable IDs when available, such as `task_id`, `run_id`, and `repository_id`.
- Include safe repository context, such as `repo_name` or sanitized path fields, when it helps connect logs to reports.

Example shape:

```ts
logger.info(
  { task_id: taskId, run_id: runId, tool_call_count: calls.length },
  "readiness_sweep.completed"
);
```

## Levels

- `debug`: local troubleshooting details that are too noisy for normal runs.
- `info`: lifecycle events a user or operator would expect.
- `warn`: recoverable problems that may affect fidelity or completeness.
- `error`: failed operations that prevent the requested action from completing.

Do not log expected readiness findings as errors. Findings belong in the sweep report and database; logs describe the sweep process itself.

## Privacy

Logs must follow [Security and Privacy](security-and-privacy.md):

- Do not log secret values.
- Do not log raw source file contents.
- Prefer counts, categories, file paths, and line numbers over copied content.
- Be careful with absolute paths because they can reveal private directory names when logs are shared.
