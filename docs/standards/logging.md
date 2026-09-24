# Logging

## Library

Use Pino for application logging. Configure it in one shared module before logging from CLI, harness, or workflow code.

Do not use `console.log()` for diagnostics outside intentional CLI user output.

## Configuration

Configure logging centrally in `src/logger.ts`.

The shared logger should support:

- `LOG_LEVEL`: defaults to `warn`.
- `LOG_FORMAT`: `json` by default. Use `pretty` for local development through the official `pino-pretty` formatter.
- Pino redaction for secret-shaped fields such as `api_key`, `apiKey`, `token`, `secret`, `password`, `authorization`, and nested equivalents.

Do not configure Pino in individual modules. Add new configuration in `src/logger.ts` so CLI, harness, plugin, workflow, and tool code share the same behavior.

Keep JSON as the default format for machine consumption. Pretty logs are for local terminal use only.

Pretty logs should optimize for human scanning. Common correlation fields, paths, and counters such as `run_id`, `interaction_id`, `model`, `report_path`, `file_count`, and `token_count` may be summarized inline in the event message and hidden from the expanded field block. Do not remove those fields from JSON logs.

CLI progress text should not duplicate info-level lifecycle logs. When info logs are enabled, prefer the log stream for progress and keep CLI text to the final command result.

## Event Shape

Logs should be structured and queryable:

- Use stable event messages such as `readiness_sweep.started` and `readiness_sweep.completed`.
- Add context as object fields instead of interpolated strings.
- Include `interaction_id` and `run_id` when available; do not emit retired task/repository IDs.
- Include safe repository context, such as `repo_name` or sanitized path fields, when it helps connect logs to reports.
- Use consistent field names across workflows and plugins.
- Avoid repeating the full run context on every event. Put target, workspace, and source metadata on boundary events such as `readiness_sweep.workspace_prepared`; later phase events should carry IDs plus only the new facts they introduce.

Example shape:

```ts
logger.info(
  { interaction_id: interactionId, run_id: runId, tool_call_count: capabilityCalls },
  "readiness_sweep.completed"
);
```

## Field Names

Prefer these field names when the concept applies:

| Concept                   | Field              |
| ------------------------- | ------------------ |
| Workflow name             | `workflow_name`    |
| Plugin name               | `plugin_name`      |
| Tool name                 | `tool_name`        |
| Repository name           | `repo_name`        |
| Local target path         | `target_path`      |
| Git target URL            | `target_url`       |
| Disposable workspace path | `workspace_path`   |
| Interaction ID            | `interaction_id`   |
| Run ID                    | `run_id`           |
| Harness provider          | `harness_provider` |
| Model runtime             | `model_runtime`    |
| Model provider            | `model_provider`   |
| Model                     | `model`            |
| Status                    | `status`           |
| Duration in milliseconds  | `duration_ms`      |
| File count                | `file_count`       |
| Token count               | `token_count`      |
| Error type                | `error_type`       |
| Error message             | `error`            |

## Levels

- `debug`: local troubleshooting details that are too noisy for normal runs.
- `info`: lifecycle events a user or operator would expect.
- `warn`: recoverable problems that may affect fidelity or completeness.
- `error`: failed operations that prevent the requested action from completing.

Do not log expected readiness findings as errors. Findings belong in the sweep report and database; logs describe the sweep process itself.

## Required Events

Workflows should log these process events when they apply:

- workflow started, completed, failed, or skipped
- evidence gathering started and completed
- model call started, completed, failed, or timed out
- report written
- interaction recording failure or recovery
- recoverable fallback or degraded-mode behavior
- rules benchmark started and completed, including `benchmark_status`, `duration_ms`, cache age when
  stale, and a sanitized `failure_type` when degraded

Plugins should log lifecycle events at the workflow boundary, not every internal branch. Prefer counts and status fields over noisy per-file logs.

Use full context sparingly:

- `readiness_sweep.workspace_prepared`: include the disposable workspace path, source, ref, and commit SHA.
- `readiness_sweep.started`: include run IDs and timeout.
- `readiness_sweep.model_completed`: include run IDs, model identity, and token count.
- `readiness_sweep.report_written`: include run IDs and report path.
- `readiness_sweep.completed`: include run IDs, status, report path, token count, and tool call count.

## Error Logging

When logging an exception, include a sanitized error under `err` and a stable `error_type` field.
Never pass raw provider/database exceptions or their attached response objects to the logger.
Recording-failure fallback diagnostics contain only safe categories and interaction/run identity.

```ts
logger.error(
  {
    err: sanitizedError,
    error_type: error instanceof Error ? error.name : typeof error,
    run_id: runId,
    workflow_name: "readiness_sweep"
  },
  "readiness_sweep.failed"
);
```

Use `warn` for expected fallback paths, such as missing optional configuration that causes a skipped interpretation. Use `error` when the requested operation cannot complete.

## Privacy

Logs must follow [Security and Privacy](security-and-privacy.md):

- Do not log secret values.
- Do not log raw source file contents.
- Prefer counts, categories, file paths, and line numbers over copied content.
- Be careful with absolute paths because they can reveal private directory names when logs are shared.
- Do not log LLM prompt bodies, evidence excerpts, report bodies, or raw tool results unless they have been explicitly redacted and are needed for debugging.

## Testing

Add focused logging tests when changing logger configuration or high-risk workflow logging.

Tests should cover:

- secret-shaped fields are redacted
- failure logs include `error_type`
- normal workflow lifecycle logs include `run_id`, `workflow_name`, `model`, and `status` when available
- recording failures and delivery uncertainty are distinguishable without logging payloads
- external Git, GitHub, Discord, model, and database failures expose stable projected categories,
  never raw response bodies, command output, credentialed URLs, or provider exception objects
