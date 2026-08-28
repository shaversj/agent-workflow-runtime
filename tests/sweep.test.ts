import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { runSweepWorkflow } from "../src/workflows/sweep.js";
import { normalizedTargetRef, parseTargetRef, targetStatePath } from "../src/workspaces/index.js";

describe("sweep workflow", () => {
  it("records a skipped report when MiniMax credentials are missing", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    const agentOpsHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    process.env.AGENT_OPS_HOME = agentOpsHome;
    const repoPath = gitRepo();

    try {
      const result = await runSweepWorkflow(repoPath);

      expect(result.status).toBe("skipped");
      expect(result.target).toEqual({
        source: "local-git",
        origin: fs.realpathSync(repoPath),
        ref: "HEAD",
        commitSha: result.workspace?.commitSha
      });
      expect(result.workspace?.origin).toBe(fs.realpathSync(repoPath));
      expect(result.workspace?.commitSha).toMatch(/^[a-f0-9]{40}$/);
      expect(result.workspace?.path && fs.existsSync(result.workspace.path)).toBe(false);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.name).toBe("gather_readiness_evidence");
      expect(fs.existsSync(result.reportPath)).toBe(true);
      expect(fs.readFileSync(result.reportPath, "utf8")).toContain("MINIMAX_API_KEY");
      expect(result.reportPath.startsWith(agentOpsHome)).toBe(true);
      expect(fs.existsSync(path.join(statePathForRepo(repoPath), "agent-ops.db"))).toBe(true);
      expect(fs.existsSync(path.join(repoPath, ".agent-readiness"))).toBe(false);
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      if (originalKey) {
        process.env.MINIMAX_API_KEY = originalKey;
      } else {
        delete process.env.MINIMAX_API_KEY;
      }
    }
  });

  it("upgrades an existing Python-era sweep database", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();
    createPythonEraDatabase(statePathForRepo(repoPath));

    try {
      const result = await runSweepWorkflow(repoPath);

      expect(result.status).toBe("skipped");
      const sqlite = new Database(path.join(statePathForRepo(repoPath), "agent-ops.db"));
      const runColumns = sqlite.prepare("PRAGMA table_info(run)").all() as { name: string }[];
      expect(runColumns.map((column) => column.name)).toContain("provider");
      expect(sqlite.prepare("select count(*) as count from run").get()).toEqual({ count: 1 });
      sqlite.close();
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      if (originalKey) {
        process.env.MINIMAX_API_KEY = originalKey;
      } else {
        delete process.env.MINIMAX_API_KEY;
      }
    }
  });

  it("persists workflow source context on the run", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();

    try {
      const result = await runSweepWorkflow(repoPath, {
        sourceContext: {
          source: "discord",
          guildId: "guild-1",
          channelId: "channel-1",
          threadId: "thread-1",
          messageId: "message-1",
          userId: "user-1"
        }
      });

      const sqlite = new Database(path.join(statePathForRepo(repoPath), "agent-ops.db"));
      const row = sqlite.prepare("select context from run where id = ?").get(result.runId) as {
        context: string;
      };
      const context = JSON.parse(row.context) as {
        workspace: { origin: string; commitSha: string };
        source: {
          source: string;
          guildId: string;
          channelId: string;
          threadId: string;
          messageId: string;
          userId: string;
        };
      };
      expect(context.workspace.origin).toBe(fs.realpathSync(repoPath));
      expect(context.workspace.commitSha).toMatch(/^[a-f0-9]{40}$/);
      expect(context.source).toEqual({
        source: "discord",
        guildId: "guild-1",
        channelId: "channel-1",
        threadId: "thread-1",
        messageId: "message-1",
        userId: "user-1"
      });
      sqlite.close();
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      if (originalKey) {
        process.env.MINIMAX_API_KEY = originalKey;
      } else {
        delete process.env.MINIMAX_API_KEY;
      }
    }
  });

  it("can sweep a Git URL through a managed checkout", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    delete process.env.MINIMAX_API_KEY;
    const agentOpsHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    process.env.AGENT_OPS_HOME = agentOpsHome;
    const repoPath = gitRepo();

    try {
      const result = await runSweepWorkflow(`file://${repoPath}`);

      expect(result.status).toBe("skipped");
      expect(result.target.origin).toBe(`file://${repoPath}`);
      expect(result.target.source).toBe("git-url");
      expect(result.workspace?.source).toBe("git-url");
      expect(result.workspace?.origin).toBe(`file://${repoPath}`);
      expect(result.workspace?.path && fs.existsSync(result.workspace.path)).toBe(false);
      expect(result.reportPath.startsWith(agentOpsHome)).toBe(true);
      expect(fs.readFileSync(result.reportPath, "utf8")).toContain("Commit:");
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });
});

function createPythonEraDatabase(statePath: string) {
  const stateDir = statePath;
  fs.mkdirSync(stateDir, { recursive: true });
  const sqlite = new Database(path.join(stateDir, "agent-ops.db"));
  sqlite.exec(`
    CREATE TABLE repository (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR NOT NULL,
      local_path VARCHAR NOT NULL,
      remote_url VARCHAR,
      default_branch VARCHAR,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    );
    CREATE UNIQUE INDEX ix_repository_local_path ON repository(local_path);

    CREATE TABLE task (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stable_key VARCHAR NOT NULL,
      repository_id INTEGER NOT NULL,
      type VARCHAR NOT NULL,
      title VARCHAR NOT NULL,
      objective VARCHAR NOT NULL,
      status VARCHAR NOT NULL,
      source VARCHAR NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      FOREIGN KEY(repository_id) REFERENCES repository (id)
    );
    CREATE UNIQUE INDEX ix_task_stable_key ON task(stable_key);

    CREATE TABLE run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      attempt_number INTEGER NOT NULL,
      status VARCHAR NOT NULL,
      model VARCHAR,
      summary VARCHAR,
      context JSON NOT NULL,
      started_at DATETIME NOT NULL,
      finished_at DATETIME,
      FOREIGN KEY(task_id) REFERENCES task (id)
    );

    CREATE TABLE artifact (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      run_id INTEGER NOT NULL,
      type VARCHAR NOT NULL,
      title VARCHAR NOT NULL,
      path_or_url VARCHAR NOT NULL,
      metadata JSON NOT NULL,
      created_at DATETIME NOT NULL,
      FOREIGN KEY(task_id) REFERENCES task (id),
      FOREIGN KEY(run_id) REFERENCES run (id)
    );
  `);
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
  return targetStatePath(normalizedTargetRef(parseTargetRef(repoPath)));
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
