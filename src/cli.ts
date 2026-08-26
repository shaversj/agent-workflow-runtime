#!/usr/bin/env node
import { DEFAULT_HARNESS_MODEL, runSweepWorkflow } from "./workflows/sweep.js";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "sweep") {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const { repoPath, harnessModel } = parseSweepArgs(args);
  const result = await runSweepWorkflow(repoPath, { model: harnessModel });
  console.log(`Sweep complete ${result.repoPath}`);
  console.log(`Status: ${result.status}`);
  console.log(`Tool calls: ${result.toolCalls.length}`);
  console.log(`Report: ${result.reportPath}`);
}

function parseSweepArgs(args: string[]) {
  const positional: string[] = [];
  let harnessModel = DEFAULT_HARNESS_MODEL;
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
    } else if (arg) {
      positional.push(arg);
    }
  }
  const repoPath = positional[0];
  if (!repoPath) throw new Error("sweep requires a repository path");
  return { repoPath, harnessModel };
}

function printUsage() {
  console.log(`Usage:
  agent-ops sweep <repo-path> [--harness-model MiniMax-M3]
  pnpm sweep -- <repo-path> [--harness-model MiniMax-M3]`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
