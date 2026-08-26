#!/usr/bin/env node
import { DEFAULT_HARNESS_MODEL, runSweepWorkflow } from "./workflows/sweep.js";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "sweep") {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const { repoPath, harnessModel, timeoutMs } = parseSweepArgs(args);
  const result = await runSweepWorkflow(repoPath, {
    model: harnessModel,
    timeoutMs,
    onProgress: (event) => {
      if (event.type === "started") {
        console.error(`Started sweep run ${event.runId} with ${event.model}`);
      } else if (event.type === "collection_started") {
        console.error("Collecting repository evidence...");
      } else if (event.type === "collection_completed") {
        console.error(`Collected evidence from ${event.fileCount} files`);
      } else if (event.type === "model_started") {
        console.error(`Waiting for ${event.provider}/${event.model}...`);
      } else if (event.type === "turn_started") {
        console.error(`Turn ${event.turn}`);
      } else if (event.type === "tool_started") {
        console.error(`Tool started: ${event.name}`);
      } else if (event.type === "tool_completed") {
        console.error(`Tool completed: ${event.name}${event.isError ? " (error)" : ""}`);
      } else if (event.type === "report_submitted") {
        console.error(`Report submitted: ${event.reportPath}`);
      } else if (event.type === "timeout") {
        console.error(`Timed out after ${Math.round(event.timeoutMs / 1000)}s`);
      }
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

function printUsage() {
  console.log(`Usage:
  agent-ops sweep <repo-path> [--harness-model MiniMax-M3] [--timeout-ms 120000]
  pnpm sweep -- <repo-path> [--harness-model MiniMax-M3] [--timeout-ms 120000]`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
