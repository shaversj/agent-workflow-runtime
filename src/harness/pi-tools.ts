import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  registeredToolName,
  type RegisteredTool,
  type RegisteredToolContext
} from "../tools/registry.js";

export function toPiAgentTools(
  tools: RegisteredTool[],
  context: RegisteredToolContext
): AgentTool[] {
  return tools.map((tool) => ({
    name: registeredToolName(tool),
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const output = await tool.execute(params, context, signal);
      return {
        content: [{ type: "text", text: output.text }],
        details: output.result,
        terminate: output.terminate
      };
    }
  }));
}
