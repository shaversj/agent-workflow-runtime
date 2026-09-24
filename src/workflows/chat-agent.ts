import fs from "node:fs";
import path from "node:path";

import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { Value } from "typebox/value";

import {
  externalErrorMessage,
  projectExternalError,
  type ExternalErrorProjection
} from "../harness/external-error.js";
import { beginInteraction, RecordingFailure } from "../harness/interaction.js";
import type { InteractionRecorder } from "../harness/interaction.js";
import { toPiAgentTools } from "../harness/pi-tools.js";
import { WorkflowResultSchema } from "../harness/schemas.js";
import { withWorkflowTimeout } from "../harness/timeout.js";
import type { WorkflowProgressEvent, WorkflowResult } from "../harness/types.js";
import { assistantText, observedModelUsage } from "../harness/usage.js";
import { createMinimaxHarnessModel } from "../harness/model.js";
import { logger } from "../logger.js";
import { defaultPluginTools } from "../plugins/index.js";
import { createChatRequestContext } from "../surfaces/chat/request-context.js";
import { routeChatMessage } from "../surfaces/chat/router.js";
import { runRulesChatRequest } from "../surfaces/chat/rules.js";
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
  let recording: InteractionRecorder | undefined;
  let executionFinished = false;
  try {
    recording = options.recording ?? beginChatInteraction(message, options);
    if (!recording.claimed) return { kind: "ignored", text: "" };
    recording.assertHealthy();
    if (recording.signal.aborted) throw new Error("workflow_aborted");
    let response = await executeChatAgent(message, { ...options, recording });
    recording.assertHealthy();
    if (recording.signal.aborted) throw new Error("workflow_aborted");
    // Unsupported requests were accepted by the surface and still have a canonical answer.
    if (response.kind === "ignored")
      response = { kind: "message", status: "completed", text: response.text };
    const messageId = recording.appendMessage({ role: "assistant", content: response.text });
    const status =
      response.kind === "message" && response.status !== "accepted" ? response.status : "completed";
    const failure = status === "completed" ? {} : { error: response.text };
    recording.finishRun({ status, ...failure });
    recording.finishInteraction({ status, ...failure });
    executionFinished = true;
    recording.assertHealthy();
    options.onResponseRecorded?.(messageId);
    return response;
  } catch (error) {
    const failure = projectExternalError("chat_workflow_failed", {
      interactionId: recording?.interactionId,
      runId: recording?.runId
    });
    const status =
      !(error instanceof RecordingFailure) &&
      !executionFinished &&
      recording !== undefined &&
      recording.signal.aborted
        ? "cancelled"
        : "failed";
    const text =
      error instanceof RecordingFailure
        ? error.message
        : status === "cancelled"
          ? "The request was cancelled."
          : externalErrorMessage(failure);
    if (recording?.claimed && !executionFinished) {
      try {
        recording.assertHealthy();
        const messageId = recording.appendMessage({ role: "assistant", content: text });
        recording.finishRun({ status, error: text });
        recording.finishInteraction({ status, error: text });
        options.onResponseRecorded?.(messageId);
      } catch {
        // The recorder owns payload-free recovery after a fatal write failure.
      }
    }
    return { kind: "message", status, text };
  } finally {
    if (!options.recording) recording?.close();
  }
}

export function beginChatInteraction(message: ChatMessage, options: ChatHandlerOptions = {}) {
  if (message.platform !== "discord") throw new Error("unsupported_history_surface");
  const request = createChatRequestContext(message.text, options);
  return beginInteraction(
    {
      source: message.platform,
      kind: CHAT_AGENT_WORKFLOW_NAME,
      userMessage: message.text,
      applicationId: message.applicationId,
      sourceMessageId: message.messageId,
      ...(request.repoTarget ? { target: request.repoTarget } : {}),
      conversationKey: JSON.stringify([
        message.platform,
        message.applicationId,
        message.workspaceId ?? null,
        message.channelId,
        message.threadId ?? null,
        message.userId
      ]),
      metadata: {
        channelId: message.channelId,
        userId: message.userId,
        ...(message.workspaceId ? { guildId: message.workspaceId } : {}),
        ...(message.threadId ? { threadId: message.threadId } : {})
      }
    },
    { signal: options.signal }
  );
}

async function executeChatAgent(
  message: ChatMessage,
  options: ChatHandlerOptions & { recording: InteractionRecorder }
): Promise<ChatResponse> {
  const recording = options.recording;
  const requestContext = createChatRequestContext(message.text, options);
  if (requestContext.repoTarget) recording.updateRun({ target: requestContext.repoTarget });
  const routed = routeChatMessage(message, options);

  const modelName = requestContext.model ?? DEFAULT_HARNESS_MODEL;
  const timeoutMs = requestContext.timeoutMs ?? DEFAULT_CHAT_AGENT_TIMEOUT_MS;
  const catalog = createToolCatalog({
    tools: options.availableTools ?? defaultPluginTools,
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

  const rulesResponse = await runRulesChatRequest(requestContext, options.enabledPluginSources);
  if (rulesResponse) return rulesResponse;

  const deterministicInspectionRequest = parseInspectionRequest(requestContext);
  if (
    !("kind" in deterministicInspectionRequest) ||
    deterministicInspectionRequest.kind !== "unsupported"
  ) {
    return runDeterministicTool(deterministicInspectionRequest, registry, toolContext);
  }

  if (!process.env[MINIMAX_API_KEY_ENV]) {
    if (routed.kind === "unsupported") {
      return { kind: "ignored", text: routed.reason };
    }
    return runWithoutRouterModel(message, options, registry, toolContext);
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
  let active = true;
  let modelFailure: ExternalErrorProjection | undefined;
  const agent = new Agent({
    initialState: {
      systemPrompt: buildChatAgentSystemPrompt(availableTools, catalog.catalogTools),
      model: harnessModel.model,
      thinkingLevel: "low",
      tools: toPiAgentTools(availableTools, toolContext),
      messages: []
    },
    streamFn: async (model, context, streamOptions) => {
      recording.assertHealthy();
      if (!active) throw new Error("workflow_aborted");
      const id = recording.modelStart({ provider: harnessModel.modelProvider, model: modelName });
      try {
        const stream = await Promise.resolve(
          harnessModel.models.streamSimple(model, context, streamOptions)
        );
        // Observe only the returned message's accounting, never provider payloads or reasoning.
        return new Proxy(stream, {
          get(target, property) {
            if (property === "result")
              return async () => {
                const result = await target.result();
                if (!active) throw new Error("workflow_aborted");
                const usage = observedModelUsage(result);
                recording.modelFinish({
                  id,
                  status:
                    result.stopReason === "aborted"
                      ? "cancelled"
                      : result.stopReason === "error"
                        ? "failed"
                        : "completed",
                  ...(usage ? { usage } : {}),
                  ...(result.stopReason === "error" || result.stopReason === "aborted"
                    ? {
                        error: (modelFailure ??= projectExternalError("model_provider_failed", {
                          interactionId: recording.interactionId,
                          runId: recording.runId
                        }))
                      }
                    : {})
                });
                return result;
              };
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function" ? (value.bind(target) as unknown) : value;
          }
        });
      } catch {
        modelFailure ??= projectExternalError("model_provider_failed", {
          interactionId: recording.interactionId,
          runId: recording.runId
        });
        if (active) recording.modelFinish({ id, status: "failed", error: modelFailure });
        throw new Error(externalErrorMessage(modelFailure));
      }
    },
    toolExecution: "sequential",
    shouldStopAfterTurn: ({ toolResults }) => {
      recording.assertHealthy();
      return (
        toolResults.length === 0 ||
        toolResults.some((toolResult) => workflowResultFromDetails(toolResult.details))
      );
    }
  });

  agent.subscribe((event: AgentEvent) => {
    if (!active) return;
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

  const abort = () => agent.abort();
  recording.signal.addEventListener("abort", abort, { once: true });
  try {
    recording.assertHealthy();
    if (recording.signal.aborted) throw new Error("workflow_aborted");
    await withWorkflowTimeout(
      agent.prompt(buildChatAgentPrompt(message, routed, requestContext)),
      timeoutMs,
      () => {
        active = false;
        agent.abort();
        emitProgress(options.onProgress, { type: "timeout", timeoutMs });
      }
    );
    recording.assertHealthy();
    if (recording.signal.aborted) throw new Error("workflow_aborted");
    const failedAssistant = finalMessages.findLast(
      (item) =>
        item.role === "assistant" && (item.stopReason === "error" || item.stopReason === "aborted")
    );
    if (failedAssistant?.role === "assistant") {
      modelFailure ??= projectExternalError("model_provider_failed", {
        interactionId: recording.interactionId,
        runId: recording.runId
      });
      throw new Error(externalErrorMessage(modelFailure));
    }
  } catch {
    modelFailure ??= projectExternalError("model_provider_failed", {
      interactionId: recording.interactionId,
      runId: recording.runId
    });
    workflowLogger.error(modelFailure, "chat_agent.failed");
    return {
      kind: "message",
      status: "failed",
      text: externalErrorMessage(modelFailure)
    };
  } finally {
    active = false;
    recording.signal.removeEventListener("abort", abort);
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
  toolContext: RegisteredToolContext
): Promise<ChatResponse> {
  const intent = routeChatMessage(message, options);
  if (intent.kind === "clarify") return { kind: "clarify", text: intent.question };
  if (intent.kind === "unsupported") return { kind: "ignored", text: intent.reason };

  const toolRequest = {
    toolName: "readiness_run_sweep",
    args: {
      repo_path: intent.repoPath,
      ...(intent.ref ? { ref: intent.ref } : {}),
      ...(intent.model ? { model: intent.model } : {}),
      ...(intent.timeoutMs !== undefined ? { timeout_ms: intent.timeoutMs } : {})
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
  } catch {
    const failure = projectExternalError(
      request.toolName.startsWith("github_") ? "github_request_failed" : "external_tool_failed",
      {
        interactionId: toolContext.recording?.interactionId,
        runId: toolContext.recording?.runId
      }
    );
    return {
      kind: "message",
      status: "failed",
      text: externalErrorMessage(failure)
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
    recording: options.recording,
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
      return `- ${metadata.name} [source=${metadata.source}, read_only=${metadata.read_only}, requires_approval=${metadata.requires_approval}, parameters=${JSON.stringify(metadata.parameters)}]: ${metadata.description}`;
    })
    .join("\n");
  return `You are Agent Workflow Runtime's chat tool router.

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
  const target = result.target.origin;
  const lines = [
    `Readiness sweep ${result.status} for ${target}.`,
    `Run: ${result.runId}`,
    `Tokens: ${result.usage.totalTokens ?? "unknown"}${result.usage.completeness === "unknown" && result.usage.totalTokens !== undefined ? " (incomplete)" : ""}`
  ];
  if (result.reportPath) lines.push(`Report: ${path.basename(result.reportPath)}`);
  const reportSummary = result.reportPath ? readReportSummary(result.reportPath) : undefined;
  if (reportSummary) lines.push("", "Summary:", reportSummary);
  if (result.reportPath) lines.push("", "Full report:", result.reportPath);
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

function parseInspectionRequest(
  request: ChatRequestContext
):
  | { toolName: string; args: Record<string, unknown> }
  | { kind: "clarify"; question: string }
  | { kind: "unsupported" } {
  const normalized = request.sourceText;
  const runListMatch = /\b(?:runs?\s+list|list\s+runs?)\b/i.exec(normalized);
  if (runListMatch) {
    if (!request.repoTarget) {
      return {
        kind: "clarify",
        question: "Which repository should I use to list readiness runs?"
      };
    }
    return {
      toolName: "readiness_list_runs",
      args: { repo_path: request.repoTarget }
    };
  }

  const showRunMatch = /\b(?:runs?\s+show|show\s+runs?)\s+([A-Za-z0-9._:-]+)/i.exec(normalized);
  if (showRunMatch?.[1]) {
    const runRef = showRunMatch[1];
    if (!request.repoTarget) {
      return {
        kind: "clarify",
        question: "Which repository should I use to show that readiness run?"
      };
    }
    return {
      toolName: "readiness_show_run",
      args: {
        run_ref: runRef,
        repo_path: request.repoTarget
      }
    };
  }

  if (!/\breports?\b/i.test(normalized)) return { kind: "unsupported" };
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
  return Value.Check(WorkflowResultSchema, details) ? details : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const emitProgress = (
  onProgress: ((event: WorkflowProgressEvent) => void) | undefined,
  event: WorkflowProgressEvent
) => onProgress?.(event);
