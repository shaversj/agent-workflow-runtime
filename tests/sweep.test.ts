import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { runSweepWorkflow } from "../src/workflows/sweep.js";

describe("sweep workflow", () => {
  it("records a skipped report when MiniMax credentials are missing", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
    fs.writeFileSync(path.join(repoPath, "README.md"), "# Demo\n");

    try {
      const result = await runSweepWorkflow(repoPath);

      expect(result.status).toBe("skipped");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.name).toBe("gather_readiness_evidence");
      expect(fs.existsSync(result.reportPath)).toBe(true);
      expect(fs.readFileSync(result.reportPath, "utf8")).toContain("MINIMAX_API_KEY");
      expect(fs.existsSync(path.join(repoPath, ".agent-readiness", "agent-ops.db"))).toBe(true);
    } finally {
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
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
    fs.writeFileSync(path.join(repoPath, "README.md"), "# Demo\n");
    createPythonEraDatabase(repoPath);

    try {
      const result = await runSweepWorkflow(repoPath);

      expect(result.status).toBe("skipped");
      const sqlite = new Database(path.join(repoPath, ".agent-readiness", "agent-ops.db"));
      const runColumns = sqlite.prepare("PRAGMA table_info(run)").all() as { name: string }[];
      expect(runColumns.map((column) => column.name)).toContain("provider");
      expect(sqlite.prepare("select count(*) as count from run").get()).toEqual({ count: 1 });
      sqlite.close();
    } finally {
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
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
    fs.writeFileSync(path.join(repoPath, "README.md"), "# Demo\n");

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

      const sqlite = new Database(path.join(repoPath, ".agent-readiness", "agent-ops.db"));
      const row = sqlite.prepare("select context from run where id = ?").get(result.runId) as {
        context: string;
      };
      const context = JSON.parse(row.context) as {
        source: {
          source: string;
          guildId: string;
          channelId: string;
          threadId: string;
          messageId: string;
          userId: string;
        };
      };
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
      if (originalKey) {
        process.env.MINIMAX_API_KEY = originalKey;
      } else {
        delete process.env.MINIMAX_API_KEY;
      }
    }
  });
});

function createPythonEraDatabase(repoPath: string) {
  const stateDir = path.join(repoPath, ".agent-readiness");
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
