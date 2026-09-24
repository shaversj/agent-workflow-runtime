import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";

import type { InteractionRecorder } from "../harness/interaction.js";
import { createMinimaxHarnessModel } from "../harness/model.js";
import { toPiAgentTools } from "../harness/pi-tools.js";
import { withWorkflowTimeout } from "../harness/timeout.js";
import type { ToolCallRecord, WorkflowProgressEvent } from "../harness/types.js";
import {
  addAssistantUsage,
  assistantText,
  emptyUsage,
  observedModelUsage
} from "../harness/usage.js";
import type { HarnessUsage } from "../harness/types.js";
import { createRulesBenchmarkTools } from "../plugins/rules-benchmark/tools.js";
import type { RulesBenchmarkClient } from "../plugins/rules-benchmark/client.js";
import type { ToolSourceContext } from "../tools/registry.js";

const MAX_TURNS = 6;

interface ReadinessInterpretationResult {
  body: string;
  usage: HarnessUsage;
  toolCalls: ToolCallRecord[];
  turns: number;
}

export class ReadinessInterpretationError extends Error {
  readonly usage: HarnessUsage;
  readonly toolCalls: ToolCallRecord[];
  readonly turns: number;

  constructor(
    message: string,
    state: { usage: HarnessUsage; toolCalls: ToolCallRecord[]; turns: number },
    cause: unknown
  ) {
    super(message, { cause });
    this.name = "ReadinessInterpretationError";
    this.usage = state.usage;
    this.toolCalls = state.toolCalls;
    this.turns = state.turns;
  }
}

export async function runReadinessInterpretation(options: {
  modelName: string;
  timeoutMs: number;
  signal: AbortSignal;
  recording: InteractionRecorder;
  benchmarkClient: RulesBenchmarkClient;
  sourceContext?: ToolSourceContext;
  systemPrompt: string;
  prompt: string;
  onProgress?: (event: WorkflowProgressEvent) => void;
}): Promise<ReadinessInterpretationResult> {
  const harnessModel = createMinimaxHarnessModel(options.modelName);
  const benchmarkTools = createRulesBenchmarkTools(options.benchmarkClient);
  const calls: ToolCallRecord[] = [];
  const pendingArgs = new Map<string, unknown>();
  let messages: AgentMessage[] = [];
  let usage = emptyUsage();
  let turns = 0;
  let turnLimitReached = false;
  let active = true;

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: harnessModel.model,
      thinkingLevel: "low",
      tools: toPiAgentTools(benchmarkTools, {
        surface: options.sourceContext?.source ?? "cli",
        recording: options.recording,
        sourceContext: options.sourceContext,
        model: options.modelName,
        timeoutMs: options.timeoutMs,
        onProgress: options.onProgress
      }),
      messages: []
    },
    streamFn: async (model, context, streamOptions) => {
      options.recording.assertHealthy();
      if (!active || options.signal.aborted) throw new Error("workflow_aborted");
      const id = options.recording.modelStart({
        provider: harnessModel.modelProvider,
        model: options.modelName
      });
      try {
        const providerSignal = streamOptions?.signal ?? options.signal;
        const stream = await abortable(
          Promise.resolve(
            harnessModel.models.streamSimple(model, context, {
              ...streamOptions,
              maxTokens: 3_000,
              timeoutMs: options.timeoutMs
            })
          ),
          providerSignal
        );
        return new Proxy(stream, {
          get(target, property) {
            if (property === "result") {
              return async () => {
                let result: Awaited<ReturnType<typeof target.result>>;
                try {
                  result = await target.result();
                } catch (error) {
                  if (active) {
                    options.recording.modelFinish({
                      id,
                      status: options.signal.aborted ? "cancelled" : "failed",
                      error: safeError(error)
                    });
                  }
                  throw error;
                }
                if (!active || options.signal.aborted) throw new Error("workflow_aborted");
                usage = addAssistantUsage(usage, result);
                const observed = observedModelUsage(result);
                options.recording.modelFinish({
                  id,
                  status:
                    result.stopReason === "aborted"
                      ? "cancelled"
                      : result.stopReason === "error"
                        ? "failed"
                        : "completed",
                  ...(observed ? { usage: observed } : {}),
                  ...(result.stopReason === "error" || result.stopReason === "aborted"
                    ? { error: result.errorMessage ?? `model_${result.stopReason}` }
                    : {})
                });
                return result;
              };
            }
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function" ? (value.bind(target) as unknown) : value;
          }
        });
      } catch (error) {
        if (active) {
          options.recording.modelFinish({
            id,
            status: options.signal.aborted ? "cancelled" : "failed",
            error: safeError(error)
          });
        }
        throw error;
      }
    },
    toolExecution: "sequential",
    shouldStopAfterTurn: ({ toolResults }) => {
      if (toolResults.length === 0) return true;
      if (turns >= MAX_TURNS) {
        turnLimitReached = true;
        return true;
      }
      return false;
    }
  });

  agent.subscribe((event: AgentEvent) => {
    if (!active) return;
    if (event.type === "turn_start") {
      turns += 1;
      options.onProgress?.({ type: "turn_started", turn: turns });
    } else if (event.type === "tool_execution_start") {
      pendingArgs.set(event.toolCallId, event.args);
      options.onProgress?.({ type: "tool_started", name: event.toolName });
    } else if (event.type === "tool_execution_end") {
      calls.push({
        name: event.toolName,
        args: pendingArgs.get(event.toolCallId) ?? {},
        isError: event.isError,
        result: toolResultDetails(event.result)
      });
      pendingArgs.delete(event.toolCallId);
      options.onProgress?.({
        type: "tool_completed",
        name: event.toolName,
        isError: event.isError
      });
    } else if (event.type === "agent_end") {
      messages = event.messages;
    }
  });

  try {
    const abort = () => agent.abort();
    options.signal.addEventListener("abort", abort, { once: true });
    try {
      if (options.signal.aborted) throw abortReason(options.signal);
      await withWorkflowTimeout(agent.prompt(options.prompt), options.timeoutMs, () => {
        active = false;
        agent.abort();
        options.onProgress?.({ type: "timeout", timeoutMs: options.timeoutMs });
      });
      if (options.signal.aborted) throw abortReason(options.signal);
    } finally {
      active = false;
      options.signal.removeEventListener("abort", abort);
    }

    const failed = messages.findLast(
      (message) =>
        message.role === "assistant" &&
        (message.stopReason === "error" || message.stopReason === "aborted")
    );
    if (failed?.role === "assistant") {
      throw new Error(failed.errorMessage ?? `model_${failed.stopReason}`);
    }
    if (turnLimitReached) throw new Error("readiness_interpretation_turn_limit");
    const body = lastAssistantText(messages);
    if (!body) throw new Error("interpretation_returned_no_text");
    return { body, usage, toolCalls: calls, turns };
  } catch (error) {
    if (error instanceof ReadinessInterpretationError) throw error;
    throw new ReadinessInterpretationError(
      safeError(error),
      { usage, toolCalls: calls, turns },
      error
    );
  }
}

function lastAssistantText(messages: AgentMessage[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    const text = assistantText(message);
    if (text) return text;
  }
  return "";
}

function toolResultDetails(result: unknown): unknown {
  if (typeof result !== "object" || result === null || !("details" in result)) return undefined;
  return result.details;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("workflow_aborted");
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "model_provider_failed";
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("model_provider_failed"));
      }
    );
  });
}
