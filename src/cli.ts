#!/usr/bin/env node
import { loadLocalEnv } from "./env.js";
import { runSweepCli } from "./surfaces/cli/sweep.js";

loadLocalEnv();

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "sweep") {
    printUsage();
    process.exitCode = 2;
    return;
  }

  await runSweepCli(args);
}

function printUsage() {
  console.log(`Usage:
  agent-ops sweep <repo-target> [--ref main] [--harness-model MiniMax-M3] [--timeout-ms 120000]
  pnpm sweep -- <repo-target> [--ref main] [--harness-model MiniMax-M3] [--timeout-ms 120000]`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
