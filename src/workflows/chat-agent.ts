import fs from "node:fs";
import path from "node:path";

import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";

import { toPiAgentTools } from "../harness/pi-tools.js";
import { withWorkflowTimeout } from "../harness/timeout.js";
import type { WorkflowProgressEvent, WorkflowResult } from "../harness/types.js";
import { assistantText } from "../harness/usage.js";
import { createMinimaxHarnessModel } from "../harness/model.js";
import { logger } from "../logger.js";
import { readinessTools } from "../plugins/readiness/tools.js";
import { createChatRequestContext } from "../surfaces/chat/request-context.js";
import { routeChatMessage } from "../surfaces/chat/router.js";
import type {
  ChatHandlerOptions,
  ChatMessage,
  ChatRequestContext,
  ChatResponse,
  ChatRouterOptions
} from "../surfaces/chat/types.js";
import { createCatalogBridgeTools } from "../tools/catalog-bridge.js";
import { createToolCatalog, describeTool } from "../tools/catalog.js";
import {
  registeredToolName,
  ToolRegistry,
  type RegisteredTool,
  type RegisteredToolContext,
  type RegisteredToolResult
} from "../tools/registry.js";
import { DEFAULT_HARNESS_MODEL } from "./sweep.js";

const CHAT_AGENT_WORKFLOW_NAME = "chat_agent";
const MINIMAX_API_KEY_ENV = "MINIMAX_API_KEY";
const DEFAULT_CHAT_AGENT_TIMEOUT_MS = 120_000;
const REPORT_SUMMARY_MAX_CHARS = 900;

export async function runChatAgentWorkflow(
  message: ChatMessage,
  options: ChatHandlerOptions = {}
): Promise<ChatResponse> {
  const requestContext = createChatRequestContext(message.text, options);
  const routed = routeChatMessage(message, options);

  const modelName = requestContext.model ?? DEFAULT_HARNESS_MODEL;
  const timeoutMs = requestContext.timeoutMs ?? DEFAULT_CHAT_AGENT_TIMEOUT_MS;
  const catalog = createToolCatalog({
    tools: options.availableTools ?? readinessTools,
    surface: message.platform,
    enabledSources: options.enabledPluginSources
  });
  const registry = catalog.registry;
  const toolContext = createToolContext(message, requestContext, options, modelName, timeoutMs);
  const availableTools = [
    ...catalog.directTools,
    ...(catalog.catalogTools.length
      ? createCatalogBridgeTools(catalog.catalogTools, message.platform)
      : [])
  ];

  if (availableTools.length === 0) {
    return { kind: "ignored", text: "No chat tools are available for this surface." };
  }

  const deterministicReportRequest = parseReportRequest(requestContext);
  if (
    !("kind" in deterministicReportRequest) ||
    deterministicReportRequest.kind !== "unsupported"
  ) {
    return runDeterministicTool(deterministicReportRequest, registry, toolContext);
  }

  if (!process.env[MINIMAX_API_KEY_ENV]) {
    if (
      routed.kind === "unsupported" &&
      "kind" in deterministicReportRequest &&
      deterministicReportRequest.kind === "unsupported"
    ) {
      return { kind: "ignored", text: routed.reason };
    }
    return runWithoutRouterModel(message, options, registry, toolContext, requestContext);
  }

  const workflowLogger = logger.child({
    workflow_name: CHAT_AGENT_WORKFLOW_NAME,
    surface: message.platform,
    channel_id: message.channelId,
    thread_id: message.threadId,
    message_id: message.messageId,
    user_id: message.userId,
    model: modelName
  });
  workflowLogger.info(
    {
      tool_names: availableTools.map((tool) => registeredToolName(tool)),
      catalog_tool_names: catalog.catalogTools.map((tool) => registeredToolName(tool)),
      enabled_sources: catalog.sourceSummaries.map((source) => source.id)
    },
    "chat_agent.started"
  );

  const harnessModel = createMinimaxHarnessModel(modelName);
  emitProgress(options.onProgress, {
    type: "model_started",
    modelProvider: harnessModel.modelProvider,
    modelRuntime: harnessModel.modelRuntime,
    model: modelName
  });

  let finalMessages: AgentMessage[] = [];
  let lastToolText: string | undefined;
  let lastWorkflowResult: WorkflowResult | undefined;
  let turn = 0;
  const agent = new Agent({
    initialState: {
      systemPrompt: buildChatAgentSystemPrompt(availableTools, catalog.catalogTools),
      model: harnessModel.model,
      thinkingLevel: "low",
      tools: toPiAgentTools(availableTools, toolContext),
      messages: []
    },
    streamFn: harnessModel.models.streamSimple.bind(harnessModel.models),
    toolExecution: "sequential",
    shouldStopAfterTurn: ({ toolResults }) =>
      toolResults.length === 0 ||
      toolResults.some((toolResult) => workflowResultFromDetails(toolResult.details))
  });

  agent.subscribe((event: AgentEvent) => {
    if (event.type === "turn_start") {
      turn += 1;
      emitProgress(options.onProgress, { type: "turn_started", turn });
    } else if (event.type === "tool_execution_start") {
      emitProgress(options.onProgress, { type: "tool_started", name: event.toolName });
    } else if (event.type === "tool_execution_end") {
      emitProgress(options.onProgress, {
        type: "tool_completed",
        name: event.toolName,
        isError: event.isError
      });
      const toolResult = event.result as unknown;
      lastToolText = firstTextContent(toolResult);
      const workflowResult = workflowResultFromDetails(toolResultDetails(toolResult));
      if (workflowResult) lastWorkflowResult = workflowResult;
    } else if (event.type === "agent_end") {
      finalMessages = event.messages;
    }
  });

  try {
    await withWorkflowTimeout(
      agent.prompt(buildChatAgentPrompt(message, options, routed, requestContext)),
      timeoutMs,
      () => {
        agent.abort();
        emitProgress(options.onProgress, { type: "timeout", timeoutMs });
      }
    );
  } catch (error) {
    workflowLogger.error(
      {
        err: error,
        error_type: error instanceof Error ? error.name : typeof error,
        error: error instanceof Error ? error.message : String(error)
      },
      "chat_agent.failed"
    );
    return {
      kind: "message",
      status: "failed",
      text: `Chat agent failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (lastWorkflowResult) {
    workflowLogger.info(
      {
        ...workflowResultTargetLogFields(lastWorkflowResult),
        workspace_path: lastWorkflowResult.repoPath,
        run_id: lastWorkflowResult.runId,
        status: lastWorkflowResult.status,
        report_path: lastWorkflowResult.reportPath,
        token_count: lastWorkflowResult.usage.totalTokens
      },
      "chat_agent.workflow_completed"
    );
    return {
      kind: "message",
      status: lastWorkflowResult.status,
      text: renderWorkflowSummary(lastWorkflowResult),
      result: lastWorkflowResult
    };
  }

  const text = lastAssistantText(finalMessages) || lastToolText;
  if (!text) return { kind: "ignored", text: "No response was produced." };

  return {
    kind: "message",
    status: "completed",
    text
  };
}

async function runWithoutRouterModel(
  message: ChatMessage,
  options: ChatHandlerOptions,
  registry: ToolRegistry,
  toolContext: RegisteredToolContext,
  requestContext: ChatRequestContext
): Promise<ChatResponse> {
  const deterministicReportRequest = parseReportRequest(requestContext);
  if (
    !("kind" in deterministicReportRequest) ||
    deterministicReportRequest.kind !== "unsupported"
  ) {
    return runDeterministicTool(deterministicReportRequest, registry, toolContext);
  }

  const intent = routeChatMessage(message, options);
  if (intent.kind === "clarify") return { kind: "clarify", text: intent.question };
  if (intent.kind === "unsupported") return { kind: "ignored", text: intent.reason };

  const toolRequest = {
    toolName: "readiness_run_sweep",
    args: {
      repo_path: intent.repoPath,
      ref: intent.ref,
      model: intent.model,
      timeout_ms: intent.timeoutMs
    }
  };
  return runDeterministicTool(toolRequest, registry, toolContext);
}

async function runDeterministicTool(
  request:
    | {
        toolName: string;
        args: Record<string, unknown>;
      }
    | {
        kind: "clarify";
        question: string;
      },
  registry: ToolRegistry,
  toolContext: RegisteredToolContext
): Promise<ChatResponse> {
  if ("kind" in request) return { kind: "clarify", text: request.question };
  const tool = registry.get(request.toolName);
  if (!tool) return { kind: "ignored", text: "Readiness sweep tool is not registered." };
  let output: RegisteredToolResult<unknown>;
  try {
    output = await tool.execute(request.args, toolContext);
  } catch (error) {
    return {
      kind: "message",
      status: "failed",
      text: error instanceof Error ? error.message : String(error)
    };
  }
  const result = workflowResultFromDetails(output.result);
  if (!result) {
    return {
      kind: "message",
      status: "completed",
      text: renderToolSummary(output)
    };
  }
  return {
    kind: "message",
    status: result.status,
    text: renderWorkflowSummary(result),
    result
  };
}

function createToolContext(
  message: ChatMessage,
  requestContext: ChatRequestContext,
  options: ChatHandlerOptions,
  model: string,
  timeoutMs: number
): RegisteredToolContext {
  return {
    surface: message.platform,
    requestContext,
    model,
    timeoutMs,
    onProgress: options.onProgress,
    sourceContext: {
      source: message.platform,
      guildId: message.workspaceId,
      channelId: message.channelId,
      threadId: message.threadId,
      messageId: message.messageId,
      userId: message.userId
    }
  };
}

function buildChatAgentSystemPrompt(
  tools: RegisteredTool[],
  catalogTools: RegisteredTool[]
): string {
  const toolList = tools
    .map((tool) => `- ${registeredToolName(tool)}: ${tool.description}`)
    .join("\n");
  const catalogToolList = catalogTools
    .map((tool) => {
      const metadata = describeTool(tool);
      return `- ${metadata.name} [source=${metadata.source}, read_only=${metadata.read_only}, requires_approval=${metadata.requires_approval}]: ${metadata.description}`;
    })
    .join("\n");
  return `You are Agent Ops Kit's chat tool router.

Available tools:
${toolList}

${catalogToolList ? `Enabled plugin tools:\n${catalogToolList}\n` : ""}
Use searchTools to inspect enabled plugin tools when plugin tools are available through the catalog.
Use executeTool with the exact tool_name from searchTools when you need to run a catalog tool.
Choose exactly one final action when the user asks for a repository readiness sweep or an existing readiness report.
Use the selected tool result to answer the user naturally.
If a required repository path is missing, ask one concise clarification question.
Do not invent repository paths, report paths, run IDs, or results.`;
}

function buildChatAgentPrompt(
  message: ChatMessage,
  options: ChatHandlerOptions,
  routed: ReturnType<typeof routeChatMessage>,
  requestContext: ChatRequestContext
): string {
  return JSON.stringify(
    {
      message: message.text,
      surface: message.platform,
      request_context: requestContext,
      routed_request: routed.kind === "run_workflow" ? routed : undefined
    },
    null,
    2
  );
}

function renderWorkflowSummary(result: WorkflowResult): string {
  const reportName = path.basename(result.reportPath);
  const target = result.target.origin;
  const lines = [
    `Readiness sweep ${result.status} for ${target}.`,
    `Run: ${result.runId}`,
    `Tokens: ${result.usage.totalTokens}`,
    `Report: ${reportName}`
  ];
  const reportSummary = readReportSummary(result.reportPath);
  if (reportSummary) lines.push("", "Summary:", reportSummary);
  lines.push("", "Full report:", result.reportPath);
  lines.push("", `Tool calls: ${result.toolCalls.length}`);
  if (result.error) lines.push(`Error: ${result.error}`);
  return lines.join("\n");
}

function readReportSummary(reportPath: string): string | undefined {
  if (!fs.existsSync(reportPath) || !fs.statSync(reportPath).isFile()) return undefined;
  const markdown = fs.readFileSync(reportPath, "utf8");
  const section =
    extractMarkdownSection(markdown, "Overall Judgment") ?? firstUsefulMarkdown(markdown);
  if (!section) return undefined;
  return truncateReportSummary(section.trim(), REPORT_SUMMARY_MAX_CHARS);
}

function extractMarkdownSection(markdown: string, heading: string): string | undefined {
  const escapedHeading = escapeRegExp(heading);
  const sectionPattern = new RegExp(
    String.raw`(^|\n)##\s+${escapedHeading}\s*\n([\s\S]*?)(?=\n##\s+|\n#\s+|$)`,
    "i"
  );
  const match = markdown.match(sectionPattern);
  const body = match?.[2]?.trim();
  return body || undefined;
}

function firstUsefulMarkdown(markdown: string): string | undefined {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("# Agent Readiness Sweep"))
    .filter((line) => !line.startsWith("Repository:"))
    .filter((line) => !line.startsWith("This report was generated"));
  const firstSectionIndex = lines.findIndex((line) => /^##\s+/.test(line));
  const usefulLines = firstSectionIndex >= 0 ? lines.slice(firstSectionIndex + 1) : lines;
  return usefulLines.find((line) => !line.startsWith("#"));
}

function truncateReportSummary(summary: string, maxChars: number): string {
  if (summary.length <= maxChars) return summary;
  return `${summary.slice(0, maxChars - 3).trimEnd()}...`;
}

function renderToolSummary(output: RegisteredToolResult<unknown>): string {
  if (!isRecord(output.result)) return output.text;
  if (typeof output.result.content === "string") {
    const reportPath =
      typeof output.result.report_path === "string"
        ? output.result.report_path
        : "latest readiness report";
    const lines = [`Report: ${reportPath}`, "", output.result.content];
    if (output.result.truncated === true) lines.push("", "(Report output truncated.)");
    return lines.join("\n");
  }
  return output.text;
}

function parseReportRequest(
  request: ChatRequestContext
):
  | { toolName: string; args: Record<string, unknown> }
  | { kind: "clarify"; question: string }
  | { kind: "unsupported" } {
  const normalized = request.sourceText;
  if (!/\breport\b/i.test(normalized)) return { kind: "unsupported" };
  const wantsRead = /\b(read|show|summarize|inspect|open)\b/i.test(normalized);
  const wantsLatest = /\blatest\b/i.test(normalized) || /\bwhere\b/i.test(normalized);
  if (!wantsRead && !wantsLatest) return { kind: "unsupported" };

  const repoPath = request.repoTarget;
  if (!repoPath) {
    return {
      kind: "clarify",
      question: "Which repository should I use for the readiness report?"
    };
  }

  return wantsRead
    ? {
        toolName: "readiness_read_report",
        args: {
          repo_path: repoPath,
          report_path: request.reportPath
        }
      }
    : {
        toolName: "readiness_get_latest_report",
        args: { repo_path: repoPath }
      };
}

export function repoTargetForChatMessage(
  message: ChatMessage,
  options: ChatRouterOptions,
  routed: ReturnType<typeof routeChatMessage> = routeChatMessage(message, options)
): string | undefined {
  if (routed.kind === "run_workflow") return routed.repoPath;
  return createChatRequestContext(message.text, options).repoTarget;
}

function workflowResultTargetLogFields(result: WorkflowResult) {
  if (result.target.source === "git-url") {
    return { target_url: result.target.origin };
  }
  return { target_path: result.target.origin };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lastAssistantText(messages: AgentMessage[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    const text = assistantText(message);
    if (text) return text;
  }
  return undefined;
}

function firstTextContent(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  const content = result.content as unknown[];
  const first = content.find((item) => isRecord(item) && item.type === "text");
  return isRecord(first) && typeof first.text === "string" ? first.text : undefined;
}

function toolResultDetails(result: unknown): unknown {
  return isRecord(result) ? result.details : undefined;
}

function workflowResultFromDetails(details: unknown): WorkflowResult | undefined {
  if (!isRecord(details)) return undefined;
  return isRecord(details.target) &&
    (details.target.source === "local-git" || details.target.source === "git-url") &&
    typeof details.target.origin === "string" &&
    typeof details.target.ref === "string" &&
    typeof details.target.commitSha === "string" &&
    typeof details.repoPath === "string" &&
    typeof details.runId === "number" &&
    typeof details.reportPath === "string" &&
    typeof details.status === "string" &&
    typeof details.provider === "string" &&
    typeof details.model === "string"
    ? (details as unknown as WorkflowResult)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const emitProgress = (
  onProgress: ((event: WorkflowProgressEvent) => void) | undefined,
  event: WorkflowProgressEvent
) => onProgress?.(event);
