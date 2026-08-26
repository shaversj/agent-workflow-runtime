import type { AgentTool } from "@earendil-works/pi-agent-core";

import { listFilesTool, readFileTool, searchFilesTool } from "./repo.js";
import { submitReportTool } from "./report.js";
import { toAgentTool, type ToolContext } from "./types.js";

export function buildReadinessAgentTools(context: ToolContext): AgentTool[] {
  return [
    toAgentTool(listFilesTool, context),
    toAgentTool(readFileTool, context),
    toAgentTool(searchFilesTool, context),
    toAgentTool(submitReportTool, context)
  ];
}

export type { ToolContext };
