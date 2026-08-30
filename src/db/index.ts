import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { logger } from "../logger.js";
import { defaultBranch, remoteUrl, repoName } from "../repository.js";
import type { WorkspaceSummary } from "../workspaces/types.js";
import { artifacts, repositories, runs, tasks, toolCalls } from "./schema.js";
import { quoteIdentifier } from "./sql.js";

function databasePathFor(statePath: string): string {
  const stateDir = path.resolve(statePath);
  fs.mkdirSync(stateDir, { recursive: true });
  return path.join(stateDir, "agent-ops.db");
}

function openStore(statePath: string) {
  const sqlite = new Database(databasePathFor(statePath));
  const db = drizzle(sqlite);
  ensureSchema(sqlite);
  return { db, sqlite };
}

export function createWorkflowRun(input: {
  repoPath: string;
  statePath: string;
  repositoryIdentity?: string;
  repositoryName?: string;
  repositoryRemoteUrl?: string;
  repositoryDefaultBranch?: string;
  harnessProvider: string;
  modelRuntime: string;
  modelProvider: string;
  model: string;
  workspace?: WorkspaceSummary;
  sourceContext?: Record<string, unknown>;
}) {
  const absoluteRepoPath = path.resolve(input.repoPath);
  const absoluteStatePath = path.resolve(input.statePath);
  const repositoryIdentity = input.repositoryIdentity ?? absoluteRepoPath;
  const store = openStore(absoluteStatePath);
  const existingRepository = store.db
    .select()
    .from(repositories)
    .where(eq(repositories.localPath, repositoryIdentity))
    .get();

  const repository =
    existingRepository ??
    store.db
      .insert(repositories)
      .values({
        name: input.repositoryName ?? repoName(absoluteRepoPath),
        localPath: repositoryIdentity,
        remoteUrl: input.repositoryRemoteUrl ?? remoteUrl(absoluteRepoPath),
        defaultBranch: input.repositoryDefaultBranch ?? defaultBranch(absoluteRepoPath)
      })
      .returning()
      .get();

  if (existingRepository) {
    store.db
      .update(repositories)
      .set({
        remoteUrl: input.repositoryRemoteUrl ?? remoteUrl(absoluteRepoPath),
        defaultBranch: input.repositoryDefaultBranch ?? defaultBranch(absoluteRepoPath),
        updatedAt: new Date().toISOString()
      })
      .where(eq(repositories.id, repository.id))
      .run();
  }

  const stableKey = `repo-readiness:${repository.id}`;
  const existingTask = store.db.select().from(tasks).where(eq(tasks.stableKey, stableKey)).get();
  const task =
    existingTask ??
    store.db
      .insert(tasks)
      .values({
        stableKey,
        repositoryId: repository.id,
        type: "repo_readiness_sweep",
        title: "Repo readiness sweep",
        objective: "Interpret repository readiness through an agent workflow and explicit tools."
      })
      .returning()
      .get();

  const run = store.db
    .insert(runs)
    .values({
      taskId: task.id,
      provider: input.harnessProvider,
      model: input.model,
      context: {
        repoPath: absoluteRepoPath,
        statePath: absoluteStatePath,
        ...(input.workspace ? { workspace: input.workspace } : {}),
        ...(input.sourceContext ? { source: input.sourceContext } : {})
      }
    })
    .returning()
    .get();

  logger.info(
    {
      workflow_name: "readiness_sweep",
      repo_name: repository.name,
      ...targetLogFields({
        identity: repositoryIdentity,
        remoteUrl: input.repositoryRemoteUrl
      }),
      state_path: absoluteStatePath,
      repository_id: repository.id,
      task_id: task.id,
      run_id: run.id,
      harness_provider: input.harnessProvider,
      model_runtime: input.modelRuntime,
      model_provider: input.modelProvider,
      model: input.model,
      source: input.sourceContext?.source
    },
    "workflow_run.created"
  );

  return { ...store, repository, task, run };
}

export function completeWorkflowRun(input: {
  repoPath: string;
  statePath: string;
  runId: number;
  taskId: number;
  status: "completed" | "failed" | "skipped";
  harnessProvider: string;
  modelRuntime: string;
  modelProvider: string;
  model: string;
  tokenCount?: number;
  failureReason?: string;
  summary: string;
  reportPath: string;
  calls: { name: string; args: unknown; isError: boolean; result: unknown }[];
  workspace?: WorkspaceSummary;
}) {
  const store = openStore(input.statePath);
  store.db
    .update(runs)
    .set({
      status: input.status,
      tokenCount: input.tokenCount,
      failureReason: input.failureReason,
      summary: input.summary,
      finishedAt: new Date().toISOString()
    })
    .where(eq(runs.id, input.runId))
    .run();

  for (const call of input.calls) {
    store.db
      .insert(toolCalls)
      .values({
        runId: input.runId,
        name: call.name,
        args: call.args ?? {},
        isError: call.isError,
        result: call.result ?? {}
      })
      .run();
  }

  store.db
    .insert(artifacts)
    .values({
      taskId: input.taskId,
      runId: input.runId,
      type: "markdown_report",
      title: "Agent Readiness Sweep",
      pathOrUrl: input.reportPath
    })
    .run();
  logger.debug(
    {
      workflow_name: "readiness_sweep",
      task_id: input.taskId,
      run_id: input.runId,
      status: input.status,
      state_path: input.statePath,
      report_path: input.reportPath,
      tool_call_count: input.calls.length
    },
    "workflow_run.completed"
  );
  store.sqlite.close();
}

function ensureSchema(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS repository (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      local_path TEXT NOT NULL UNIQUE,
      remote_url TEXT,
      default_branch TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS ix_repository_local_path ON repository(local_path);

    CREATE TABLE IF NOT EXISTS task (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stable_key TEXT NOT NULL UNIQUE,
      repository_id INTEGER NOT NULL REFERENCES repository(id),
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      source TEXT NOT NULL DEFAULT 'cli',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS ix_task_stable_key ON task(stable_key);

    CREATE TABLE IF NOT EXISTS run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES task(id),
      attempt_number INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'running',
      provider TEXT,
      model TEXT,
      token_count INTEGER,
      failure_reason TEXT,
      summary TEXT,
      context TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS artifact (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES task(id),
      run_id INTEGER NOT NULL REFERENCES run(id),
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      path_or_url TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tool_call (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES run(id),
      name TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '{}',
      is_error INTEGER NOT NULL DEFAULT 0,
      result TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  ensureColumn(sqlite, "run", "provider", "TEXT");
  ensureColumn(sqlite, "run", "token_count", "INTEGER");
  ensureColumn(sqlite, "run", "failure_reason", "TEXT");
}

function ensureColumn(
  sqlite: Database.Database,
  tableName: string,
  columnName: string,
  definition: string
) {
  const columns = sqlite.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as {
    name: string;
  }[];
  if (columns.some((column) => column.name === columnName)) return;
  sqlite.exec(
    `ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(columnName)} ${definition}`
  );
}

function targetLogFields(input: { identity: string; remoteUrl?: string }) {
  return input.remoteUrl ? { target_url: input.remoteUrl } : { target_path: input.identity };
}
