import { DEFAULT_HARNESS_MODEL, runSweepWorkflow } from "../../workflows/sweep.js";
import type { WorkflowProgressEvent } from "../../harness/types.js";

export async function runSweepCli(args: string[]) {
  const { repoPath, harnessModel, timeoutMs } = parseSweepArgs(args);
  const result = await runSweepWorkflow(repoPath, {
    model: harnessModel,
    timeoutMs,
    onProgress: (event) => {
      const line = formatSweepProgress(event);
      if (line) console.error(line);
    }
  });

  console.log(`Sweep complete ${result.repoPath}`);
  console.log(`Status: ${result.status}`);
  console.log(`Tool calls: ${result.toolCalls.length}`);
  console.log(`Report: ${result.reportPath}`);
}

function parseSweepArgs(args: string[]) {
  const positional: string[] = [];
  let harnessModel = DEFAULT_HARNESS_MODEL;
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
  const repoPath = positional[0];
  if (!repoPath) throw new Error("sweep requires a repository path");
  return { repoPath, harnessModel, timeoutMs };
}

function formatSweepProgress(event: WorkflowProgressEvent): string | undefined {
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
