import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const repositories = sqliteTable(
  "repository",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    localPath: text("local_path").notNull().unique(),
    remoteUrl: text("remote_url"),
    defaultBranch: text("default_branch"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [index("ix_repository_local_path").on(table.localPath)]
);

export const tasks = sqliteTable(
  "task",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    stableKey: text("stable_key").notNull().unique(),
    repositoryId: integer("repository_id")
      .notNull()
      .references(() => repositories.id),
    type: text("type").notNull(),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    status: text("status").notNull().default("open"),
    source: text("source").notNull().default("cli"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [index("ix_task_stable_key").on(table.stableKey)]
);

export const runs = sqliteTable("run", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: integer("task_id")
    .notNull()
    .references(() => tasks.id),
  attemptNumber: integer("attempt_number").notNull().default(1),
  status: text("status").notNull().default("running"),
  provider: text("provider"),
  model: text("model"),
  summary: text("summary"),
  context: text("context", { mode: "json" }).notNull().default({}),
  startedAt: text("started_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  finishedAt: text("finished_at")
});

export const artifacts = sqliteTable("artifact", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: integer("task_id")
    .notNull()
    .references(() => tasks.id),
  runId: integer("run_id")
    .notNull()
    .references(() => runs.id),
  type: text("type").notNull(),
  title: text("title").notNull(),
  pathOrUrl: text("path_or_url").notNull(),
  metadata: text("metadata", { mode: "json" }).notNull().default({}),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
});

export const toolCalls = sqliteTable("tool_call", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id")
    .notNull()
    .references(() => runs.id),
  name: text("name").notNull(),
  args: text("args", { mode: "json" }).notNull().default({}),
  isError: integer("is_error", { mode: "boolean" }).notNull().default(false),
  result: text("result", { mode: "json" }).notNull().default({}),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
});
