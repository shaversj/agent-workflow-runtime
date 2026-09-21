import { Type } from "typebox";

import { beginInteraction } from "../../harness/interaction.js";
import { captureHistory } from "../../harness/history-capture.js";
import type { WorkflowProgressEvent } from "../../harness/types.js";
import { DEFAULT_HARNESS_MODEL, runSweepWorkflow } from "../../workflows/sweep.js";
import { markOption, normalizeCliArgs, parseCli, takeOptionValue } from "./args.js";

const SweepArgsSchema = Type.Object(
  {
    repoTarget: Type.String({ minLength: 1 }),
    ref: Type.Optional(Type.String({ minLength: 1 })),
    harnessModel: Type.String({ minLength: 1 }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 }))
  },
  { additionalProperties: false }
);

export async function runSweepCli(args: string[]) {
  const { repoTarget, ref, harnessModel, timeoutMs } = parseSweepArgs(args);
  const printProgress = shouldPrintCliProgress();
  const controller = new AbortController();
  const recording = beginInteraction(
    {
      source: "cli",
      kind: "readiness_sweep",
      target: repoTarget,
      userMessage: ["sweep", ...args]
    },
    { signal: controller.signal }
  );
  const onInterrupt = () => controller.abort(new Error("SIGINT"));
  const onTerminate = () => controller.abort(new Error("SIGTERM"));
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const result = await runSweepWorkflow(repoTarget, {
      ref,
      model: harnessModel,
      timeoutMs,
      recording,
      signal: controller.signal,
      onProgress: (event) => {
        if (!printProgress) return;
        const line = formatSweepProgress(event);
        if (line) console.error(line);
      }
    });

    recording.assertHealthy();
    if (result.status === "cancelled") {
      process.exitCode =
        controller.signal.reason instanceof Error && controller.signal.reason.message === "SIGTERM"
          ? 143
          : 130;
    } else if (result.status === "failed" || result.status === "interrupted") {
      process.exitCode = 1;
    }
    const summary = captureHistory(
      [
        `Sweep ${result.status}: ${result.target.origin}`,
        `Interaction: ${recording.interactionId}`,
        `Run: ${result.runId}`,
        `Status: ${result.status}`,
        `Workflow evidence activities: ${result.toolCalls.length}`,
        `Tokens: ${result.usage.totalTokens ?? "unknown"} (${result.usage.completeness ?? "unknown"})`,
        `Report: ${result.reportPath ?? "none"}`,
        ...(result.error ? [`Error: ${result.error}`] : []),
        ...(result.cleanupError ? [`Cleanup error: ${result.cleanupError}`] : [])
      ].join("\n")
    ).text;
    const messageId = recording.appendMessage({ role: "assistant", content: summary });
    recording.finishInteraction({ status: result.status, error: result.error });
    const deliveryId = recording.deliveryStart({ messageId, part: 1, attempt: 1 });
    try {
      recording.assertHealthy();
      await writeSummary(summary + "\n");
      recording.deliveryFinish({
        id: deliveryId,
        status: "acknowledged",
        surfaceMessageId: "stdout"
      });
    } catch (error) {
      recording.deliveryFinish({ id: deliveryId, status: "failed", error: safeError(error) });
      throw error;
    }
    recording.assertHealthy();
  } catch (error) {
    recording.assertHealthy();
    recording.finishInteraction({ status: "failed", error: safeError(error) });
    throw new Error(safeError(error));
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    recording.close();
  }
}

function safeError(error: unknown): string {
  return captureHistory(error instanceof Error ? error.message : String(error)).text;
}

function writeSummary(summary: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    const onError = (error: Error) => {
      failure ??= error;
    };
    process.stdout.on("error", onError);
    const finish = (error?: Error | null) => {
      failure ??= error ?? undefined;
      // Writable streams can emit their error just after invoking the write callback.
      setImmediate(() => {
        process.stdout.off("error", onError);
        if (failure) reject(failure);
        else resolve();
      });
    };
    try {
      process.stdout.write(summary, finish);
    } catch (error) {
      finish(new Error(safeError(error)));
    }
  });
}

export function parseSweepArgs(args: string[]) {
  const normalized = normalizeCliArgs(args);
  const positional: string[] = [];
  const seen = new Set<string>();
  let harnessModel = DEFAULT_HARNESS_MODEL;
  let ref: string | undefined;
  let timeoutMs: number | undefined;
  for (let index = 0; index < normalized.length; index += 1) {
    const arg = normalized[index];
    if (arg === "--harness-model") {
      markOption(seen, arg);
      const value = takeOptionValue(normalized, index, arg);
      harnessModel = value;
      index += 1;
    } else if (arg === "--ref") {
      markOption(seen, arg);
      const value = takeOptionValue(normalized, index, arg);
      ref = value;
      index += 1;
    } else if (arg === "--timeout-ms") {
      markOption(seen, arg);
      const value = takeOptionValue(normalized, index, arg);
      if (!/^[1-9][0-9]*$/.test(value)) {
        throw new Error("--timeout-ms must be a positive integer");
      }
      timeoutMs = Number(value);
      index += 1;
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown sweep argument: ${arg}`);
    } else if (arg) {
      positional.push(arg);
    }
  }
  if (positional.length > 1) throw new Error("sweep accepts one repository target");
  const repoTarget = positional[0];
  if (!repoTarget) throw new Error("sweep requires a repository target");
  return parseCli(SweepArgsSchema, { repoTarget, ref, harnessModel, timeoutMs });
}

function formatSweepProgress(event: WorkflowProgressEvent): string | undefined {
  if (event.type === "workspace_prepared") {
    return `Workspace prepared ${event.workspace.path} from ${event.target.origin} @ ${event.workspace.commitSha.slice(0, 12)}`;
  }
  if (event.type === "started") {
    return `Started sweep run ${event.runId} with ${event.model}`;
  }
  if (event.type === "evidence_started") {
    return "Collecting repository evidence...";
  }
  if (event.type === "evidence_completed") {
    return `Collected evidence from ${event.fileCount} files`;
  }
  if (event.type === "model_started") {
    return `Waiting for ${event.modelProvider}/${event.model}...`;
  }
  if (event.type === "turn_started") {
    return `Turn ${event.turn}`;
  }
  if (event.type === "tool_started") {
    return `Tool started: ${event.name}`;
  }
  if (event.type === "tool_completed") {
    return `Tool completed: ${event.name}${event.isError ? " (error)" : ""}`;
  }
  if (event.type === "report_submitted") {
    return `Report submitted: ${event.reportPath}`;
  }
  if (event.type === "timeout") {
    return `Timed out after ${Math.round(event.timeoutMs / 1000)}s`;
  }
  return undefined;
}

function shouldPrintCliProgress(): boolean {
  return !infoLogsAreEnabled(process.env.LOG_LEVEL);
}

function infoLogsAreEnabled(level: string | undefined): boolean {
  const normalized = (level ?? "warn").toLowerCase();
  const priority = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60,
    silent: Number.POSITIVE_INFINITY
  };
  const selectedPriority =
    normalized in priority ? priority[normalized as keyof typeof priority] : priority.warn;
  return selectedPriority <= priority.info;
}
