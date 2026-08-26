import { logger } from "../logger.js";
import type { WorkflowProgressEvent } from "./types.js";

export function emitWorkflowProgress(
  workflowName: string,
  onProgress: ((event: WorkflowProgressEvent) => void) | undefined,
  event: WorkflowProgressEvent
) {
  onProgress?.(event);
  if (event.type === "tool_started") {
    logger.info({ tool_name: event.name }, `${workflowName}.tool_started`);
  } else if (event.type === "tool_completed") {
    logger.info(
      { tool_name: event.name, is_error: event.isError },
      `${workflowName}.tool_completed`
    );
  } else if (event.type === "turn_started") {
    logger.info({ turn: event.turn }, `${workflowName}.turn_started`);
  } else if (event.type === "timeout") {
    logger.warn(
      { workflow_name: workflowName, timeout_ms: event.timeoutMs },
      `${workflowName}.timeout`
    );
  } else if (event.type === "evidence_started") {
    logger.info({ workflow_name: workflowName }, `${workflowName}.evidence_started`);
  } else if (event.type === "evidence_completed") {
    logger.info(
      { workflow_name: workflowName, file_count: event.fileCount },
      `${workflowName}.evidence_completed`
    );
  } else if (event.type === "model_started") {
    logger.info(
      {
        workflow_name: workflowName,
        model_provider: event.modelProvider,
        model_runtime: event.modelRuntime,
        model: event.model
      },
      `${workflowName}.model_started`
    );
  }
}
