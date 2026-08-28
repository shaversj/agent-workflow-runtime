import { DEFAULT_HARNESS_MODEL, runSweepWorkflow } from "../../workflows/sweep.js";
import type { WorkflowProgressEvent } from "../../harness/types.js";

export async function runSweepCli(args: string[]) {
  const { repoTarget, ref, harnessModel, timeoutMs } = parseSweepArgs(args);
  const printProgress = shouldPrintCliProgress();
  const result = await runSweepWorkflow(repoTarget, {
    ref,
    model: harnessModel,
    timeoutMs,
    onProgress: (event) => {
      if (!printProgress) return;
      const line = formatSweepProgress(event);
      if (line) console.error(line);
    }
  });

  console.log(`Sweep complete ${result.workspace?.origin ?? result.repoPath}`);
  console.log(`Status: ${result.status}`);
  console.log(`Tool calls: ${result.toolCalls.length}`);
  console.log(`Report: ${result.reportPath}`);
}

function parseSweepArgs(args: string[]) {
  const positional: string[] = [];
  let harnessModel = DEFAULT_HARNESS_MODEL;
  let ref: string | undefined;
  let timeoutMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--harness-model") {
      const value = args[index + 1];
      if (!value) throw new Error("--harness-model requires a value");
      harnessModel = value;
      index += 1;
    } else if (arg === "--ref") {
      const value = args[index + 1];
      if (!value) throw new Error("--ref requires a value");
      ref = value;
      index += 1;
    } else if (arg === "--timeout-ms") {
      const value = args[index + 1];
      if (!value) throw new Error("--timeout-ms requires a value");
      timeoutMs = Number.parseInt(value, 10);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("--timeout-ms must be a positive integer");
      }
      index += 1;
    } else if (arg) {
      positional.push(arg);
    }
  }
  const repoTarget = positional[0];
  if (!repoTarget) throw new Error("sweep requires a repository target");
  return { repoTarget, ref, harnessModel, timeoutMs };
}

function formatSweepProgress(event: WorkflowProgressEvent): string | undefined {
  if (event.type === "workspace_prepared") {
    return `Workspace prepared ${event.workspace.path} from ${event.target.origin} @ ${event.target.commitSha.slice(0, 12)}`;
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
