#!/usr/bin/env node
import { loadTrustedEnv, TrustedEnvError } from "./env.js";

async function main() {
  loadTrustedEnv();
  const [command, ...args] = process.argv.slice(2);
  if (command === "code") {
    const { runCodingCli } = await import("./surfaces/cli/code.js");
    await runCodingCli(args);
    return;
  }
  if (command === "history") {
    const { runHistoryCli } = await import("./surfaces/cli/history.js");
    runHistoryCli(args);
    return;
  }
  if (command === "sweep") {
    const { runSweepCli } = await import("./surfaces/cli/sweep.js");
    await runSweepCli(args);
    return;
  }
  if (command === "runs") {
    const { runRunsCli } = await import("./surfaces/cli/runs.js");
    runRunsCli(args);
    return;
  }
  if (command === "reports") {
    const { runReportsCli } = await import("./surfaces/cli/reports.js");
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
  agent-ops code prepare <owner/repo> <base-branch> <task>
  agent-ops code show <job-id> [--json]
  agent-ops code approve <job-id> --digest <digest>
  agent-ops code reconcile <job-id> --digest <digest>
  agent-ops code reject|cancel|expire|recover <job-id>
  agent-ops history list [--target repo-target] [--source cli|discord] [--outcome completed] [--since ISO] [--until ISO] [--limit 20] [--cursor value] [--json]
  agent-ops history show <interaction-id> [--limit 50] [--cursor value] [--json]
  pnpm sweep -- <repo-target> [--ref main] [--harness-model MiniMax-M3] [--timeout-ms 120000]`);
}

main().catch((error: unknown) => {
  console.error(
    error instanceof TrustedEnvError
      ? error.message
      : error instanceof Error
        ? error.message
        : "agent_ops_cli_failed"
  );
  process.exitCode = 1;
});
