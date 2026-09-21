import { randomUUID } from "node:crypto";

export type ExternalErrorCategory =
  | "chat_workflow_failed"
  | "discord_deletion_failed"
  | "discord_gateway_failed"
  | "discord_reply_failed"
  | "discord_status_failed"
  | "external_tool_failed"
  | "github_request_failed"
  | "model_provider_failed";

export interface ExternalErrorContext {
  correlationId?: string;
  interactionId?: string;
  runId?: number;
  statusCode?: number;
  redirectCount?: number;
  attempt?: number;
  part?: number;
}

export interface ExternalErrorProjection {
  error_category: ExternalErrorCategory;
  correlation_id: string;
  interaction_id?: string;
  run_id?: number;
  status_code?: number;
  redirect_count?: number;
  attempt?: number;
  part?: number;
}

const correlationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const internalIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

/** External throwables never cross this boundary; callers provide only trusted local context. */
export function projectExternalError(
  category: ExternalErrorCategory,
  context: ExternalErrorContext = {}
): ExternalErrorProjection {
  const correlationId =
    typeof context.correlationId === "string" && correlationIdPattern.test(context.correlationId)
      ? context.correlationId
      : randomUUID();
  return Object.freeze({
    error_category: category,
    correlation_id: correlationId,
    ...(typeof context.interactionId === "string" && internalIdPattern.test(context.interactionId)
      ? { interaction_id: context.interactionId }
      : {}),
    ...(safePositiveInteger(context.runId) ? { run_id: context.runId } : {}),
    ...(safeStatusCode(context.statusCode) ? { status_code: context.statusCode } : {}),
    ...(safeCount(context.redirectCount) ? { redirect_count: context.redirectCount } : {}),
    ...(safePositiveInteger(context.attempt) ? { attempt: context.attempt } : {}),
    ...(safePositiveInteger(context.part) ? { part: context.part } : {})
  });
}

export function externalErrorMessage(failure: ExternalErrorProjection): string {
  return `The request could not be completed. Reference: ${failure.correlation_id}.`;
}

export function externalErrorAsError(failure: ExternalErrorProjection): Error {
  const error = new Error(externalErrorMessage(failure));
  error.name = "ExternalOperationError";
  return error;
}

function safePositiveInteger(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function safeCount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100;
}

function safeStatusCode(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599;
}
