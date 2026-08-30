import { Type } from "typebox";

import { WorkflowTargetSummarySchema, WorkspaceSummarySchema } from "../workspaces/schemas.js";

export const ToolCallRecordSchema = Type.Object({
  name: Type.String(),
  args: Type.Unknown(),
  isError: Type.Boolean(),
  result: Type.Unknown()
});

export const HarnessUsageSchema = Type.Object({
  requests: Type.Number(),
  inputTokens: Type.Number(),
  outputTokens: Type.Number(),
  totalTokens: Type.Number(),
  cost: Type.Optional(Type.Number())
});

export const WorkflowResultSchema = Type.Object({
  target: WorkflowTargetSummarySchema,
  repoPath: Type.String(),
  runId: Type.Number(),
  reportPath: Type.String(),
  status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("skipped")]),
  provider: Type.String(),
  model: Type.String(),
  usage: HarnessUsageSchema,
  toolCalls: Type.Array(ToolCallRecordSchema),
  workspace: Type.Optional(WorkspaceSummarySchema),
  error: Type.Optional(Type.String())
});
