import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openHistoryReader } from "../src/db/index.js";
import { runSweepCli } from "../src/surfaces/cli/sweep.js";

const model = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("../src/harness/model.js", () => ({
  createMinimaxHarnessModel: () => ({
    modelProvider: "minimax",
    modelRuntime: "pi-ai",
    model: {},
    models: { completeSimple: model.complete }
  })
}));

let home: string;
let repo: string;
let output: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-cli-"));
  vi.stubEnv("AGENT_OPS_HOME", home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("MINIMAX_API_KEY", "");
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  repo = path.join(home, "source");
  fs.mkdirSync(repo);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# Test\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "Initial"]);
  output = "";
  model.complete.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  fs.rmSync(home, { recursive: true, force: true });
});

function captureOutput(fail = false) {
  return vi.spyOn(process.stdout, "write").mockImplementation((chunk, ...args) => {
    output += String(chunk);
    const snapshot = history();
    expect(snapshot.messages.at(-1)?.content.text + "\n").toBe(output);
    expect(snapshot.interaction.status).not.toBe("running");
    expect(snapshot.deliveries[0]?.status).toBe("pending");
    const callback = args.find((arg) => typeof arg === "function") as (error?: Error) => void;
    callback(fail ? new Error("stdout_failed") : undefined);
    if (fail) process.stdout.emit("error", new Error("stdout_failed"));
    return true;
  });
}

function history() {
  const reader = openHistoryReader()!;
  try {
    const interaction = reader.listInteractions()[0]!;
    const messages = reader.listMessages(interaction.id);
    return {
      interaction,
      messages,
      runs: reader.listRuns(interaction.id),
      deliveries: reader.listDeliveryAttempts(messages.at(-1)!.id)
    };
  } finally {
    reader.close();
  }
}

describe("sweep CLI recording", () => {
  it("records the canonical summary before stdout and acknowledges the stream", async () => {
    const write = captureOutput();
    await runSweepCli([repo]);
    write.mockRestore();
    const snapshot = history();
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.interaction.status).toBe("skipped");
    expect(snapshot.interaction.incomplete).toBe(false);
    expect(snapshot.deliveries).toMatchObject([
      { status: "acknowledged", surfaceMessageId: "stdout" }
    ]);
    expect(output).toContain("Workflow evidence activities: 1");
    expect(output).not.toContain("undefined");
  });

  it("keeps generated output and execution status when stdout fails", async () => {
    const write = captureOutput(true);
    await expect(runSweepCli([repo])).rejects.toThrow("stdout_failed");
    write.mockRestore();
    const snapshot = history();
    expect(snapshot.interaction.status).toBe("skipped");
    expect(snapshot.runs[0]?.status).toBe("skipped");
    expect(snapshot.deliveries).toMatchObject([{ status: "failed" }]);
    expect(snapshot.messages.at(-1)?.content.text).toContain("Report:");
  });

  it("renders no report and exits nonzero after preparation fails", async () => {
    const write = captureOutput();
    await runSweepCli([path.join(home, "missing")]);
    write.mockRestore();
    expect(output).toContain("Status: failed");
    expect(output).toContain("Report: none");
    expect(output).not.toContain("undefined");
    expect(process.exitCode).toBe(1);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "records %s cancellation and restores handlers after cleanup",
    async (signal) => {
      vi.stubEnv("MINIMAX_API_KEY", "synthetic-key");
      const originalHandlers = process.listenerCount(signal);
      model.complete.mockImplementation(
        (_model: unknown, _input: unknown, options: { signal: AbortSignal }) => {
          process.emit(signal);
          expect(options.signal.aborted).toBe(true);
          return new Promise(() => {});
        }
      );
      const write = captureOutput();
      await runSweepCli([repo]);
      write.mockRestore();
      expect(history().interaction.status).toBe("cancelled");
      expect(history().runs[0]?.status).toBe("cancelled");
      expect(process.exitCode).toBe(signal === "SIGINT" ? 130 : 143);
      expect(process.listenerCount(signal)).toBe(originalHandlers);
      expect(fs.readdirSync(path.join(home, "workspaces"))).toEqual([]);
      expect(output).toContain("Report: none");
    }
  );

  it.each([false, true])("runs the actual CLI in a temporary cwd, prep failure=%s", (fail) => {
    const projectRoot = fileURLToPath(new URL("../", import.meta.url));
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        path.join(projectRoot, "src/cli.ts"),
        "sweep",
        fail ? path.join(home, "missing") : repo
      ],
      {
        cwd: home,
        encoding: "utf8",
        timeout: 15000,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          AGENT_OPS_HOME: home,
          MINIMAX_API_KEY: "",
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          LOG_LEVEL: "silent"
        }
      }
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(fail ? 1 : 0);
    expect(child.stdout).toContain(fail ? "Status: failed" : "Status: skipped");
    expect(child.stdout).not.toContain("undefined");
    expect(history().runs).toHaveLength(1);
    expect(history().deliveries).toMatchObject([
      { status: "acknowledged", surfaceMessageId: "stdout" }
    ]);
    expect(fs.existsSync(path.join(home, "targets"))).toBe(false);
  });
});
