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
