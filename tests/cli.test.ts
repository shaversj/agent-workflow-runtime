import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runReportsCli } from "../src/surfaces/cli/reports.js";
import { parseReportsCliArgs } from "../src/surfaces/cli/reports.js";
import { parseRunsCliArgs, runRunsCli } from "../src/surfaces/cli/runs.js";
import { runSweepWorkflow } from "../src/workflows/sweep.js";

describe("package contract", () => {
  it("is source-only and cannot be published to npm", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")
    ) as Record<string, unknown>;

    expect(packageJson.private).toBe(true);
    expect(packageJson).not.toHaveProperty("bin");
    expect(packageJson).not.toHaveProperty("files");
    expect(packageJson.scripts).toMatchObject({
      sweep: "tsx src/cli.ts sweep"
    });
  });

  it("rejects retired rules and standards commands without preparing state", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-cli-home-"));
    const environment = { ...process.env, AGENT_OPS_HOME: home };
    delete environment.AGENT_OPS_ENV_FILE;
    let failure: { status?: number; stdout?: string; stderr?: string } | undefined;
    try {
      execFileSync(
        "pnpm",
        [
          "exec",
          "tsx",
          path.join(import.meta.dirname, "..", "src", "cli.ts"),
          "rules",
          "inventory",
          home
        ],
        { cwd: path.join(import.meta.dirname, ".."), env: environment, encoding: "utf8" }
      );
    } catch (error: unknown) {
      failure = error as { status?: number; stdout?: string; stderr?: string };
    }
    expect(failure?.status).toBe(2);
    const output = `${failure?.stdout ?? ""}\n${failure?.stderr ?? ""}`;
    expect(output).toContain("Usage:");
    expect(output).not.toContain("Repository rules");
    expect(fs.readdirSync(home)).toEqual([]);
  });
});

describe("inspection CLI", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("lists and shows managed readiness runs", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    delete process.env.MINIMAX_API_KEY;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();

    try {
      const result = await runSweepWorkflow(repoPath);
      const listOutput = captureStdout(() => runRunsCli(["list", repoPath]));
      const runRef = String(result.runId);

      expect(listOutput).toContain("Recent readiness sweep runs:");
      expect(listOutput).toContain("status=skipped");
      expect(listOutput).toContain("tokens=unknown");
      expect(listOutput).toContain("tools=0");
      expect(runRef).toBeDefined();

      const showOutput = captureStdout(() => runRunsCli(["show", runRef]));
      expect(showOutput).toContain(`Run: ${runRef}`);
      expect(showOutput).toContain("Status: skipped");
      expect(showOutput).toContain(`Report: ${result.reportPath}`);
      expect(showOutput).toContain("Failure reason: missing_minimax_api_key");
      expect(showOutput).toContain("Tool call details:");
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("resolves global run IDs without target qualification", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    delete process.env.MINIMAX_API_KEY;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));

    try {
      await runSweepWorkflow(gitRepo());
      await runSweepWorkflow(gitRepo());

      const output = captureStdout(() => runRunsCli(["show", "1"]));

      expect(output).toContain("Run: 1");
      expect(output).not.toContain("ambiguous");
      expect(process.exitCode).toBeUndefined();
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("rejects invalid run list limits", () => {
    expect(() => runRunsCli(["list", "--limit", "0"])).toThrow(
      /--limit must be an integer between 1 and 100/
    );
    expect(() => runRunsCli(["list", "--limit", "101"])).toThrow(
      /--limit must be an integer between 1 and 100/
    );
    expect(() => runRunsCli(["list", "--limit", "2abc"])).toThrow(
      /--limit must be an integer between 1 and 100/
    );
  });

  it.each([
    ["runs", () => parseRunsCliArgs(["list", "repo-a", "repo-b"])],
    ["runs", () => parseRunsCliArgs(["list", "--limit", "2", "--limit", "3"])],
    ["runs", () => parseRunsCliArgs(["list", "--unknown"])],
    ["runs", () => parseRunsCliArgs(["show", "12", "repo", "extra"])],
    ["reports", () => parseReportsCliArgs(["latest", "repo", "extra"])],
    ["reports", () => parseReportsCliArgs(["latest", "--unknown"])],
    ["separator", () => parseRunsCliArgs(["list", "repo", "--"])]
  ])("rejects malformed %s grammar before inspection", (_label, parse) => {
    expect(parse).toThrow();
  });

  it("accepts one leading package-manager separator", () => {
    expect(parseRunsCliArgs(["--", "list", "repo", "--limit", "2"])).toEqual({
      command: "list",
      repoTarget: "repo",
      limit: 2
    });
    expect(parseReportsCliArgs(["--", "latest", "repo"])).toEqual({
      command: "latest",
      repoTarget: "repo"
    });
  });

  it("prints latest report metadata", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    delete process.env.MINIMAX_API_KEY;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();

    try {
      const result = await runSweepWorkflow(repoPath);
      const output = captureStdout(() => runReportsCli(["latest", repoPath]));

      expect(output).toContain("Latest readiness report");
      expect(output).toContain(`Report: ${fs.realpathSync(result.reportPath!)}`);
      expect(output).toContain(`Run: ${result.runId}`);
      expect(output).toContain("Status: skipped");
      expect(output).not.toContain("Tokens: 0");
      expect(output).toContain("Tool calls: 0");
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("redacts credentialed Git URL targets when no report exists", () => {
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoTarget = "https://token:secret@example.com/org/repo.git?api_key=abc";

    try {
      const output = captureStdout(() => runReportsCli(["latest", repoTarget]));

      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain("token");
      expect(output).not.toContain("secret");
      expect(output).not.toContain("abc");
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
    }
  });
});

function captureStdout(run: () => void): string {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line = "") => {
    lines.push(String(line));
  });
  run();
  return lines.join("\n");
}

function gitRepo(): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
  git(["init"], repoPath);
  git(["config", "user.email", "test@example.com"], repoPath);
  git(["config", "user.name", "Test User"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Demo\n");
  git(["add", "README.md"], repoPath);
  git(["commit", "-m", "Initial commit"], repoPath);
  return repoPath;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
