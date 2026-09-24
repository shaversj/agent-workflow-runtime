import { Type } from "typebox";

import { WorkflowTargetSummarySchema, WorkspaceSummarySchema } from "../workspaces/schemas.js";
import { TerminalStatusSchema } from "./history-schemas.js";

export const ToolCallRecordSchema = Type.Object({
  name: Type.String(),
  args: Type.Unknown(),
  isError: Type.Boolean(),
  result: Type.Unknown()
});

const RunStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("skipped"),
  Type.Literal("cancelled"),
  Type.Literal("interrupted")
]);

const InspectionToolCallSummarySchema = Type.Object({
  name: Type.String(),
  is_error: Type.Boolean(),
  created_at: Type.Optional(Type.String())
});

export const InspectionRunSummarySchema = Type.Object({
  interaction_id: Type.String(),
  run_ref: Type.String(),
  run_id: Type.Number(),
  status: RunStatusSchema,
  target: Type.String(),
  ref: Type.Optional(Type.String()),
  commit_sha: Type.Optional(Type.String()),
  short_commit: Type.Optional(Type.String()),
  report_path: Type.Optional(Type.String()),
  token_count: Type.Optional(Type.Number()),
  tool_call_count: Type.Number(),
  workflow_activity_count: Type.Number(),
  usage_completeness: Type.Union([Type.Literal("complete"), Type.Literal("unknown")]),
  failure_reason: Type.Optional(Type.String()),
  harness_provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  benchmark_status: Type.Optional(
    Type.Union([
      Type.Literal("live"),
      Type.Literal("revalidated"),
      Type.Literal("stale"),
      Type.Literal("unavailable")
    ])
  ),
  started_at: Type.String(),
  finished_at: Type.Optional(Type.String())
});

export const InspectionRunDetailSchema = Type.Object({
  ...InspectionRunSummarySchema.properties,
  tool_calls: Type.Array(InspectionToolCallSummarySchema, { maxItems: 100 }),
  tool_calls_truncated: Type.Boolean()
});

export const InspectionReportSummarySchema = Type.Object({
  interaction_id: Type.String(),
  run_ref: Type.Optional(Type.String()),
  run_id: Type.Optional(Type.Number()),
  status: Type.Optional(RunStatusSchema),
  target: Type.String(),
  ref: Type.Optional(Type.String()),
  commit_sha: Type.Optional(Type.String()),
  short_commit: Type.Optional(Type.String()),
  report_path: Type.String(),
  bytes: Type.Number(),
  updated_at: Type.Optional(Type.String()),
  token_count: Type.Optional(Type.Number()),
  tool_call_count: Type.Optional(Type.Number()),
  benchmark_status: InspectionRunSummarySchema.properties.benchmark_status,
  failure_reason: Type.Optional(Type.String())
});

export const InspectionRunListResultSchema = Type.Object({
  runs: Type.Array(InspectionRunSummarySchema),
  count: Type.Number()
});

export const InspectionRunShowResultSchema = Type.Union([
  Type.Object({
    found: Type.Literal(true),
    run: InspectionRunDetailSchema
  }),
  Type.Object({
    found: Type.Literal(false),
    reason: Type.String(),
    matches: Type.Optional(Type.Array(InspectionRunSummarySchema))
  })
]);

export const InspectionLatestReportResultSchema = Type.Object({
  repo_path: Type.String(),
  report_path: Type.Optional(Type.String()),
  bytes: Type.Number(),
  updated_at: Type.Optional(Type.String()),
  run_ref: Type.Optional(Type.String()),
  status: Type.Optional(RunStatusSchema),
  token_count: Type.Optional(Type.Number()),
  tool_call_count: Type.Optional(Type.Number()),
  benchmark_status: InspectionRunSummarySchema.properties.benchmark_status,
  failure_reason: Type.Optional(Type.String())
});

export const InspectionReadReportResultSchema = Type.Object({
  repo_path: Type.String(),
  report_path: Type.String(),
  content: Type.String(),
  truncated: Type.Boolean()
});

export const HarnessUsageSchema = Type.Object({
  requests: Type.Number(),
  inputTokens: Type.Optional(Type.Number()),
  outputTokens: Type.Optional(Type.Number()),
  totalTokens: Type.Optional(Type.Number()),
  completeness: Type.Optional(Type.Union([Type.Literal("complete"), Type.Literal("unknown")])),
  cost: Type.Optional(Type.Number())
});

export const WorkflowResultSchema = Type.Object({
  target: WorkflowTargetSummarySchema,
  repoPath: Type.Optional(Type.String()),
  runId: Type.Number(),
  interactionId: Type.String(),
  reportPath: Type.Optional(Type.String()),
  status: TerminalStatusSchema,
  provider: Type.String(),
  model: Type.String(),
  usage: HarnessUsageSchema,
  toolCalls: Type.Array(ToolCallRecordSchema),
  workspace: Type.Optional(WorkspaceSummarySchema),
  benchmark: Type.Optional(
    Type.Object({
      status: Type.Union([
        Type.Literal("live"),
        Type.Literal("revalidated"),
        Type.Literal("stale"),
        Type.Literal("unavailable")
      ]),
      apiVersion: Type.Literal(1),
      endpoint: Type.String(),
      fetchedAt: Type.String(),
      cacheAgeMs: Type.Optional(Type.Number({ minimum: 0 })),
      reason: Type.Optional(Type.String())
    })
  ),
  error: Type.Optional(Type.String()),
  cleanupError: Type.Optional(Type.String())
});
