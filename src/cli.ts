#!/usr/bin/env node
import { loadLocalEnv } from "./env.js";
import { runReportsCli } from "./surfaces/cli/reports.js";
import { runRunsCli } from "./surfaces/cli/runs.js";
import { runSweepCli } from "./surfaces/cli/sweep.js";
import { runHistoryCli } from "./surfaces/cli/history.js";

loadLocalEnv();

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "history") {
    runHistoryCli(args);
    return;
  }
  if (command === "sweep") {
    await runSweepCli(args);
    return;
  }
  if (command === "runs") {
    runRunsCli(args);
    return;
  }
  if (command === "reports") {
    runReportsCli(args);
    return;
  }

  printUsage();
  process.exitCode = 2;
}

function printUsage() {
  console.log(`Usage:
  agent-ops sweep <repo-target> [--ref main] [--harness-model MiniMax-M3] [--timeout-ms 120000]
  agent-ops runs list [repo-target] [--limit 20]
  agent-ops runs show <run-ref> [repo-target]
  agent-ops reports latest [repo-target]
  agent-ops history list [--target repo-target] [--source cli|discord] [--outcome completed] [--since ISO] [--until ISO] [--limit 20] [--cursor value] [--json]
  agent-ops history show <interaction-id> [--limit 50] [--cursor value] [--json]
  pnpm sweep -- <repo-target> [--ref main] [--harness-model MiniMax-M3] [--timeout-ms 120000]`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
