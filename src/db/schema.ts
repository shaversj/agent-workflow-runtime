import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import type {
  AppendMessageInput,
  CaptureEnvelope,
  ExecutionStatus,
  StartToolCallInput
} from "../harness/history-schemas.js";
import type {
  CodingJob,
  CodingProposal,
  CodingApproval,
  Publication
} from "../plugins/coding/schemas.js";

const capture = (name: string) => text(name, { mode: "json" }).$type<CaptureEnvelope>();
const lifecycle = () => ({
  status: text("status").$type<ExecutionStatus>().notNull().default("running"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  error: capture("error")
});

export const interactions = sqliteTable(
  "interaction",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    applicationId: text("application_id"),
    sourceMessageId: text("source_message_id"),
    conversationKey: text("conversation_key"),
    target: text("target"),
    ownerToken: text("owner_token").notNull(),
    ownerPid: integer("owner_pid").notNull(),
    ownerHost: text("owner_host").notNull(),
    incomplete: integer("incomplete", { mode: "boolean" }).notNull().default(false),
    metadata: capture("metadata").notNull(),
    ...lifecycle()
  },
  (t) => [
    uniqueIndex("ux_interaction_source").on(t.source, t.applicationId, t.sourceMessageId),
    index("ix_interaction_time").on(t.startedAt, t.id),
    index("ix_interaction_target").on(t.target, t.startedAt, t.id),
    index("ix_interaction_source_time").on(t.source, t.startedAt, t.id),
    index("ix_interaction_status").on(t.status, t.startedAt, t.id),
    index("ix_interaction_owner").on(t.ownerHost, t.ownerPid),
    check(
      "ck_interaction_source",
      sql`(${t.source} = 'cli' AND ${t.applicationId} IS NULL AND ${t.sourceMessageId} IS NULL) OR (${t.source} = 'discord' AND ${t.applicationId} IS NOT NULL AND ${t.sourceMessageId} IS NOT NULL)`
    )
  ]
);

export const runs = sqliteTable(
  "run",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    interactionId: text("interaction_id")
      .notNull()
      .references(() => interactions.id),
    parentRunId: integer("parent_run_id"),
    triggeringToolCallId: integer("triggering_tool_call_id").references(
      (): AnySQLiteColumn => toolCalls.id
    ),
    kind: text("kind").notNull(),
    target: text("target"),
    ref: text("ref"),
    commitSha: text("commit_sha"),
    metadata: capture("metadata").notNull(),
    ...lifecycle()
  },
  (t) => [
    uniqueIndex("ux_run_interaction").on(t.id, t.interactionId),
    uniqueIndex("ux_run_root")
      .on(t.interactionId)
      .where(sql`${t.parentRunId} IS NULL`),
    foreignKey({
      columns: [t.parentRunId, t.interactionId],
      foreignColumns: [t.id, t.interactionId]
    }),
    index("ix_run_activity").on(t.interactionId, t.startedAt, t.id)
  ]
);

export const messages = sqliteTable(
  "message",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    interactionId: text("interaction_id")
      .notNull()
      .references(() => interactions.id),
    runId: integer("run_id"),
    sequence: integer("sequence").notNull(),
    role: text("role").$type<AppendMessageInput["role"]>().notNull(),
    content: capture("content").notNull(),
    createdAt: text("created_at").notNull()
  },
  (t) => [
    uniqueIndex("ux_message_sequence").on(t.interactionId, t.sequence),
    foreignKey({
      columns: [t.runId, t.interactionId],
      foreignColumns: [runs.id, runs.interactionId]
    })
  ]
);

export const toolCalls = sqliteTable(
  "tool_call",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id")
      .notNull()
      .references(() => runs.id),
    parentCallId: integer("parent_call_id").references((): AnySQLiteColumn => toolCalls.id),
    ordinal: integer("ordinal").notNull(),
    providerCallId: text("provider_call_id"),
    source: text("source"),
    name: text("name").notNull(),
    kind: text("kind").$type<StartToolCallInput["kind"]>().notNull(),
    input: capture("input").notNull(),
    result: capture("result"),
    ...lifecycle()
  },
  (t) => [
    uniqueIndex("ux_tool_ordinal").on(t.runId, t.ordinal),
    index("ix_tool_activity").on(t.runId, t.startedAt, t.id)
  ]
);

export const modelCalls = sqliteTable(
  "model_call",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id")
      .notNull()
      .references(() => runs.id),
    ordinal: integer("ordinal").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    usageState: text("usage_state").$type<"unknown" | "known">().notNull().default("unknown"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    ...lifecycle()
  },
  (t) => [
    uniqueIndex("ux_model_ordinal").on(t.runId, t.ordinal),
    index("ix_model_activity").on(t.runId, t.startedAt, t.id),
    check(
      "ck_model_usage",
      sql`(${t.usageState} = 'unknown' AND ${t.inputTokens} IS NULL AND ${t.outputTokens} IS NULL AND ${t.totalTokens} IS NULL) OR (${t.usageState} = 'known' AND ${t.inputTokens} IS NOT NULL AND ${t.outputTokens} IS NOT NULL AND ${t.totalTokens} IS NOT NULL AND ${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0 AND ${t.totalTokens} >= 0)`
    )
  ]
);

export const artifacts = sqliteTable(
  "artifact",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    interactionId: text("interaction_id")
      .notNull()
      .references(() => interactions.id),
    runId: integer("run_id"),
    path: text("path").notNull(),
    type: text("type").notNull(),
    title: text("title"),
    availability: text("availability").$type<"available" | "missing">().notNull(),
    createdAt: text("created_at").notNull()
  },
  (t) => [
    foreignKey({
      columns: [t.runId, t.interactionId],
      foreignColumns: [runs.id, runs.interactionId]
    }),
    index("ix_artifact_interaction").on(t.interactionId, t.id),
    index("ix_artifact_run").on(t.runId, t.id)
  ]
);

export const deliveryAttempts = sqliteTable(
  "delivery_attempt",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id),
    part: integer("part").notNull(),
    attempt: integer("attempt").notNull(),
    status: text("status")
      .$type<"pending" | "acknowledged" | "failed" | "uncertain">()
      .notNull()
      .default("pending"),
    surfaceMessageId: text("surface_message_id"),
    error: capture("error"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at")
  },
  (t) => [
    uniqueIndex("ux_delivery_attempt").on(t.messageId, t.part, t.attempt),
    index("ix_delivery_pending")
      .on(t.messageId)
      .where(sql`${t.status} = 'pending'`)
  ]
);

export const codingJobs = sqliteTable("coding_job", {
  id: text("id").primaryKey(),
  runId: integer("run_id")
    .notNull()
    .references(() => runs.id),
  status: text("status").notNull(),
  data: text("data", { mode: "json" }).$type<CodingJob>().notNull()
});
export const codingProposals = sqliteTable("coding_proposal", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .unique()
    .references(() => codingJobs.id),
  data: text("data", { mode: "json" }).$type<CodingProposal>().notNull()
});
export const codingApprovals = sqliteTable("coding_approval", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .references(() => codingJobs.id),
  runId: integer("run_id")
    .notNull()
    .references(() => runs.id),
  consumed: integer("consumed", { mode: "boolean" }).notNull(),
  data: text("data", { mode: "json" }).$type<CodingApproval>().notNull()
});
export const codingPublications = sqliteTable("coding_publication", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .unique()
    .references(() => codingJobs.id),
  runId: integer("run_id")
    .notNull()
    .references(() => runs.id),
  data: text("data", { mode: "json" }).$type<Publication>().notNull()
});
