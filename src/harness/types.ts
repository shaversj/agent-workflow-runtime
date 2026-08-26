export interface ToolCallRecord {
  name: string;
  args: unknown;
  isError: boolean;
  result: unknown;
}

export interface HarnessUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost?: number;
}

export interface WorkflowResult {
  repoPath: string;
  runId: number;
  reportPath: string;
  status: "completed" | "failed" | "skipped";
  provider: string;
  model: string;
  usage: HarnessUsage;
  toolCalls: ToolCallRecord[];
  error?: string;
}

export type WorkflowProgressEvent =
  | { type: "started"; runId: number; repoPath: string; model: string; timeoutMs: number }
  | { type: "evidence_started" }
  | { type: "evidence_completed"; fileCount: number }
  | { type: "model_started"; provider: string; model: string }
  | { type: "turn_started"; turn: number }
  | { type: "tool_started"; name: string }
  | { type: "tool_completed"; name: string; isError: boolean }
  | { type: "report_submitted"; reportPath: string }
  | { type: "completed"; status: WorkflowResult["status"]; reportPath: string }
  | { type: "timeout"; timeoutMs: number };
