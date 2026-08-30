import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  getLatestInspectionReport,
  listInspectionRuns,
  readInspectionReport,
  showInspectionRun
} from "../src/db/inspection.js";
import { runSweepWorkflow } from "../src/workflows/sweep.js";
import { parseTargetRef, targetStorageKey } from "../src/workspaces/index.js";

describe("inspection read model", () => {
  it("returns empty results without creating target state", () => {
    const originalHome = process.env.AGENT_OPS_HOME;
    const agentOpsHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    process.env.AGENT_OPS_HOME = agentOpsHome;

    try {
      expect(listInspectionRuns()).toEqual({ runs: [], count: 0 });
      expect(getLatestInspectionReport()).toBeUndefined();
      expect(fs.existsSync(path.join(agentOpsHome, "targets"))).toBe(false);
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
    }
  });

  it("lists target-scoped runs with persisted token and failure metadata", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    delete process.env.MINIMAX_API_KEY;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();

    try {
      const result = await runSweepWorkflow(repoPath);
      const list = listInspectionRuns({ repoTarget: repoPath });

      expect(list.count).toBe(1);
      expect(list.runs[0]).toMatchObject({
        run_id: result.runId,
        status: "skipped",
        target: fs.realpathSync(repoPath),
        ref: "HEAD",
        short_commit: result.target.commitSha.slice(0, 12),
        report_path: result.reportPath,
        token_count: 0,
        tool_call_count: 1,
        failure_reason: "missing_minimax_api_key",
        harness_provider: "agent-ops-kit",
        model: "MiniMax-M3"
      });
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("requires target-qualified references when bare run IDs are ambiguous", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    delete process.env.MINIMAX_API_KEY;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const firstRepo = gitRepo();
    const secondRepo = gitRepo();

    try {
      const first = await runSweepWorkflow(firstRepo);
      await runSweepWorkflow(secondRepo);
      const ambiguous = showInspectionRun(String(first.runId));

      expect(ambiguous.found).toBe(false);
      expect(ambiguous.found === false ? ambiguous.reason : "").toContain("ambiguous");
      expect(ambiguous.found === false ? ambiguous.matches : []).toHaveLength(2);

      const runRef = listInspectionRuns({ repoTarget: firstRepo }).runs[0]!.run_ref;
      const found = showInspectionRun(runRef);
      expect(found).toMatchObject({
        found: true,
        run: {
          run_ref: runRef,
          target: fs.realpathSync(firstRepo)
        }
      });
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("reads legacy databases without mutating them", () => {
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = path.join(os.tmpdir(), "legacy-repo");
    const statePath = statePathForRepo(repoPath);
    createLegacyDatabase(statePath, repoPath);

    try {
      const before = runColumns(statePath);
      const list = listInspectionRuns({ repoTarget: repoPath });
      const after = runColumns(statePath);

      expect(before).not.toContain("token_count");
      expect(after).toEqual(before);
      expect(list.runs[0]).toMatchObject({
        target: path.resolve(repoPath),
        token_count: undefined,
        failure_reason: undefined
      });
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
    }
  });

  it("uses DB artifacts first and filesystem report lookup as fallback", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    delete process.env.MINIMAX_API_KEY;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();

    try {
      const result = await runSweepWorkflow(repoPath);
      expect(getLatestInspectionReport({ repoTarget: repoPath })).toMatchObject({
        report_path: fs.realpathSync(result.reportPath),
        run_id: result.runId,
        token_count: 0
      });

      const reportOnlyRepo = path.join(os.tmpdir(), "report-only-repo");
      const reportOnlyPath = writeManagedReport(reportOnlyRepo, "legacy.md", "# Legacy\n");
      expect(getLatestInspectionReport({ repoTarget: reportOnlyRepo })).toMatchObject({
        report_path: fs.realpathSync(reportOnlyPath),
        bytes: "# Legacy\n".length
      });
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("skips stale DB artifact paths when finding the latest report", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    delete process.env.MINIMAX_API_KEY;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();

    try {
      const result = await runSweepWorkflow(repoPath);
      const fallbackPath = writeManagedReport(repoPath, "fallback.md", "# Fallback\n");
      fs.rmSync(result.reportPath, { force: true });

      const latest = getLatestInspectionReport({ repoTarget: repoPath });
      expect(latest).toMatchObject({
        report_path: fs.realpathSync(fallbackPath),
        bytes: "# Fallback\n".length
      });
      expect(readInspectionReport({ repoTarget: repoPath }).content).toBe("# Fallback\n");
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("skips DB artifact paths that resolve outside the reports directory", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    delete process.env.MINIMAX_API_KEY;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();

    try {
      const result = await runSweepWorkflow(repoPath);
      const outsidePath = path.join(os.tmpdir(), `agent-ops-outside-${Date.now()}.md`);
      fs.writeFileSync(outsidePath, "outside\n");
      updateArtifactPath(statePathForRepo(repoPath), result.runId, outsidePath);
      const fallbackPath = writeManagedReport(repoPath, "fallback.md", "# Fallback\n");

      expect(getLatestInspectionReport({ repoTarget: repoPath })).toMatchObject({
        report_path: fs.realpathSync(fallbackPath)
      });
      expect(readInspectionReport({ repoTarget: repoPath }).content).toBe("# Fallback\n");
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("preserves report path protections when reading reports", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    delete process.env.MINIMAX_API_KEY;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();

    try {
      await runSweepWorkflow(repoPath);
      const outsidePath = path.join(os.tmpdir(), `agent-ops-secret-${Date.now()}.md`);
      fs.writeFileSync(outsidePath, "secret\n");

      expect(readInspectionReport({ repoTarget: repoPath }).content).toContain(
        "# Agent Readiness Sweep"
      );
      expect(() => readInspectionReport({ repoTarget: repoPath, reportPath: outsidePath })).toThrow(
        /outside the readiness reports directory/
      );
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("redacts credentialed Git URLs in inspection output", () => {
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const target = "https://token:secret@example.com/org/repo.git?api_key=abc";
    const statePath = statePathForRepo(target);
    createLegacyDatabase(statePath, target);

    try {
      const output = JSON.stringify(listInspectionRuns({ repoTarget: target }));

      expect(output).not.toContain("token");
      expect(output).not.toContain("secret");
      expect(output).not.toContain("abc");
      expect(output).toContain("[REDACTED]");
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
    }
  });
});

function createLegacyDatabase(statePath: string, repoTarget: string) {
  fs.mkdirSync(statePath, { recursive: true });
  const sqlite = new Database(path.join(statePath, "agent-ops.db"));
  sqlite.exec(`
    CREATE TABLE repository (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      local_path TEXT NOT NULL UNIQUE,
      remote_url TEXT,
      default_branch TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE task (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stable_key TEXT NOT NULL UNIQUE,
      repository_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      source TEXT NOT NULL DEFAULT 'cli',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      attempt_number INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'completed',
      model TEXT,
      summary TEXT,
      context TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT
    );
  `);
  sqlite
    .prepare("INSERT INTO repository (name, local_path, remote_url) VALUES (?, ?, ?)")
    .run(path.basename(repoTarget.replace(/\\.git$/, "")), repoTarget, repoTarget);
  sqlite
    .prepare(
      "INSERT INTO task (stable_key, repository_id, type, title, objective) VALUES (?, 1, ?, ?, ?)"
    )
    .run("repo-readiness:1", "repo_readiness_sweep", "Repo readiness sweep", "Sweep");
  sqlite
    .prepare(
      "INSERT INTO run (task_id, status, model, summary, context, started_at, finished_at) VALUES (1, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      "completed",
      "MiniMax-M3",
      "Legacy sweep completed.",
      JSON.stringify({ repoPath: repoTarget }),
      "2026-08-30T00:00:00.000Z",
      "2026-08-30T00:00:01.000Z"
    );
  sqlite.close();
}

function writeManagedReport(repoTarget: string, name: string, content: string): string {
  const reportDir = path.join(statePathForRepo(repoTarget), "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, name);
  fs.writeFileSync(reportPath, content);
  return reportPath;
}

function runColumns(statePath: string): string[] {
  const sqlite = new Database(path.join(statePath, "agent-ops.db"));
  const rows = sqlite.prepare("PRAGMA table_info(run)").all() as { name: string }[];
  sqlite.close();
  return rows.map((row) => row.name);
}

function updateArtifactPath(statePath: string, runId: number, reportPath: string) {
  const sqlite = new Database(path.join(statePath, "agent-ops.db"));
  sqlite
    .prepare("UPDATE artifact SET path_or_url = ?, created_at = ? WHERE run_id = ?")
    .run(reportPath, "2099-01-01T00:00:00.000Z", runId);
  sqlite.close();
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

function statePathForRepo(repoPath: string): string {
  const target = parseTargetRef(repoPath);
  const resolvedPath = fs.existsSync(repoPath) ? fs.realpathSync(repoPath) : path.resolve(repoPath);
  return path.join(
    process.env.AGENT_OPS_HOME ?? path.join(os.homedir(), ".agent-ops-kit"),
    "targets",
    target.kind === "local-git"
      ? targetStorageKey({ ...target, path: resolvedPath })
      : targetStorageKey(target)
  );
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
