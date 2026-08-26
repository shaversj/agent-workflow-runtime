import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";

import type { ToolCallRecord } from "../domain/types.js";

export interface ToolContext {
  repoPath: string;
  reportPath: string;
  calls: ToolCallRecord[];
  maxToolCalls?: number;
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

export function toAgentTool<TParameters extends TSchema, TResult>(
  tool: WorkflowTool<TParameters, TResult>,
  context: ToolContext
): AgentTool<TParameters, TResult> {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (_toolCallId, params, signal): Promise<AgentToolResult<TResult>> => {
      if (context.maxToolCalls !== undefined && context.calls.length >= context.maxToolCalls) {
        const result = {
          error: `Tool budget exhausted after ${context.maxToolCalls} calls. Use observed evidence to produce the report.`
        };
        context.calls.push({
          name: tool.name,
          args: params,
          isError: true,
          result
        });
        throw new Error(result.error);
      }
      try {
        const output = await tool.execute(params, context, signal);
        context.calls.push({
          name: tool.name,
          args: params,
          isError: false,
          result: output.result
        });
        return {
          content: [{ type: "text", text: output.text }],
          details: output.result,
          terminate: output.terminate
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const result = { error: message };
        context.calls.push({
          name: tool.name,
          args: params,
          isError: true,
          result
        });
        throw error;
      }
    }
  };
}
