import { logger } from "../logger.js";
import type { WorkflowProgressEvent } from "./types.js";
import type { WorkflowTargetSummary } from "../workspaces/types.js";

export function emitWorkflowProgress(
  workflowName: string,
  onProgress: ((event: WorkflowProgressEvent) => void) | undefined,
  event: WorkflowProgressEvent,
  logContext: Record<string, unknown> = {}
) {
  onProgress?.(event);
  const context = { workflow_name: workflowName, ...logContext };
  if (event.type === "workspace_prepared") {
    logger.info(
      {
        ...context,
        ...targetLogFields(event.target),
        workspace_source: event.workspace.source,
        workspace_path: event.workspace.path,
        workspace_ref: event.workspace.ref,
        workspace_commit_sha: event.workspace.commitSha,
        state_path: event.workspace.statePath
      },
      `${workflowName}.workspace_prepared`
    );
  } else if (event.type === "tool_started") {
    logger.info({ ...context, tool_name: event.name }, `${workflowName}.tool_started`);
  } else if (event.type === "tool_completed") {
    logger.info(
      { ...context, tool_name: event.name, is_error: event.isError },
      `${workflowName}.tool_completed`
    );
  } else if (event.type === "turn_started") {
    logger.info({ ...context, turn: event.turn }, `${workflowName}.turn_started`);
  } else if (event.type === "timeout") {
    logger.warn({ ...context, timeout_ms: event.timeoutMs }, `${workflowName}.timeout`);
  } else if (event.type === "evidence_started") {
    logger.info(context, `${workflowName}.evidence_started`);
  } else if (event.type === "evidence_completed") {
    logger.info({ ...context, file_count: event.fileCount }, `${workflowName}.evidence_completed`);
  } else if (event.type === "model_started") {
    logger.info(
      {
        ...context,
        model_provider: event.modelProvider,
        model_runtime: event.modelRuntime,
        model: event.model
      },
      `${workflowName}.model_started`
    );
  }
}

function targetLogFields(target: WorkflowTargetSummary) {
  return target.source === "git-url"
    ? { target_url: target.origin }
    : { target_path: target.origin };
}
