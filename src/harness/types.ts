import type { Static } from "typebox";

import type { HarnessUsageSchema, ToolCallRecordSchema, WorkflowResultSchema } from "./schemas.js";
import type { WorkflowTargetSummary, WorkspaceSummary } from "../workspaces/types.js";

export type ToolCallRecord = Static<typeof ToolCallRecordSchema>;

export type HarnessUsage = Static<typeof HarnessUsageSchema>;

export type WorkflowResult = Static<typeof WorkflowResultSchema>;

export type WorkflowProgressEvent =
  | { type: "workspace_prepared"; target: WorkflowTargetSummary; workspace: WorkspaceSummary }
  | { type: "started"; runId: number; repoPath: string; model: string; timeoutMs: number }
  | { type: "evidence_started" }
  | { type: "evidence_completed"; fileCount: number }
  | { type: "benchmark_started" }
  | {
      type: "benchmark_completed";
      status: "live" | "revalidated" | "stale" | "unavailable";
      durationMs: number;
      cacheAgeMs?: number;
      failureType?: string;
    }
  | { type: "model_started"; modelProvider: string; modelRuntime: string; model: string }
  | { type: "turn_started"; turn: number }
  | { type: "tool_started"; name: string }
  | { type: "tool_completed"; name: string; isError: boolean }
  | { type: "report_submitted"; reportPath: string }
  | { type: "completed"; status: WorkflowResult["status"]; reportPath?: string }
  | { type: "timeout"; timeoutMs: number };
