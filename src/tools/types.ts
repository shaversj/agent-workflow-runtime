import type { Static, TSchema } from "typebox";

import type { ToolCallRecord } from "../harness/types.js";

export interface ToolContext {
  repoPath: string;
  reportPath: string;
  calls: ToolCallRecord[];
}

export interface WorkflowTool<TParameters extends TSchema, TResult> {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  execute: (
    params: Static<TParameters>,
    context: ToolContext,
    signal?: AbortSignal
  ) => Promise<WorkflowToolResult<TResult>> | WorkflowToolResult<TResult>;
}

export interface WorkflowToolResult<TResult> {
  result: TResult;
  text: string;
  terminate?: boolean;
}
