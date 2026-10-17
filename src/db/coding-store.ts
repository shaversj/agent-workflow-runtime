import crypto from "node:crypto";
import os from "node:os";

import type Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { captureHistoryMetadata } from "../harness/history-capture.js";
import * as c from "../plugins/coding/schemas.js";
import {
  codingJobs,
  codingExecutions,
  codingProposals,
  codingApprovals,
  codingPublications,
  runs
} from "./schema.js";

export const codingExecutionSql = `
CREATE TABLE coding_execution (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES coding_job(id),
 conversation_id INTEGER, task_id INTEGER, task TEXT NOT NULL, profile_fingerprint TEXT NOT NULL,
 deadline_at TEXT NOT NULL, fence INTEGER NOT NULL DEFAULT 0,
 owner_token TEXT, owner_pid INTEGER, owner_host TEXT,
 active_run_id INTEGER REFERENCES run(id), terminal_run_id INTEGER REFERENCES run(id), phase TEXT NOT NULL,
 resume_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
`;

export const codingBootstrapSql = `
CREATE TABLE coding_job (id TEXT PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES run(id),
 status TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
${codingExecutionSql}
CREATE TABLE coding_proposal (id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES coding_job(id),
 data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE coding_approval (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES coding_job(id),
 run_id INTEGER NOT NULL REFERENCES run(id), consumed INTEGER NOT NULL CHECK(consumed IN (0,1)),
 data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE coding_publication (id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES coding_job(id),
 run_id INTEGER NOT NULL REFERENCES run(id), data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TRIGGER coding_proposal_immutable BEFORE UPDATE ON coding_proposal
 BEGIN SELECT RAISE(ABORT, 'proposal is immutable'); END;
`;

export class CodingDecisionError extends Error {}

export class CodingStore {
  private readonly db;
  constructor(
    private readonly sqlite: Database.Database,
    private readonly runId: number,
    private readonly assertActive: () => void,
    private readonly owner: Readonly<{ token: string; pid: number; host: string }>
  ) {
    this.db = drizzle(sqlite);
  }
  private write<T>(operation: () => T): T {
    return this.sqlite
      .transaction(() => {
        this.assertActive();
        return operation();
      })
      .immediate();
  }
  get(id: string, principal: string): c.CodingJob | undefined {
    const row = this.db.select().from(codingJobs).where(eq(codingJobs.id, id)).get();
    if (!row) return undefined;
    const job = c.parseCoding(c.CodingJobSchema, row.data);
    if (job.id !== row.id || job.status !== row.status || job.runId !== row.runId)
      throw new Error("coding_store_integrity_failed");
    if (job.principal !== principal) throw new CodingDecisionError("coding_principal_denied");
    return job;
  }
  private required(id: string, principal: string): c.CodingJob {
    const job = this.get(id, principal);
    if (!job) throw new CodingDecisionError("coding_job_not_found");
    return job;
  }
  create(
    input: unknown,
    execution: { profileFingerprint: string; deadlineAt: string; task: string }
  ): c.CodingJob {
    const job = c.parseCoding(c.CodingJobSchema, input);
    const preparedExecution = c.parseCoding(c.CodingExecutionSchema, {
      id: crypto.randomUUID(),
      jobId: job.id,
      task: execution.task,
      profileFingerprint: execution.profileFingerprint,
      deadlineAt: execution.deadlineAt,
      fence: 0,
      phase: "waiting-runtime",
      resumeCount: 0,
      updatedAt: new Date().toISOString()
    });
    if (job.runId !== this.runId || job.status !== "preparing")
      throw new Error("coding_job_invalid_start");
    return this.write(() => {
      this.db
        .insert(codingJobs)
        .values({ id: job.id, runId: this.runId, status: job.status, data: job })
        .run();
      this.db.insert(codingExecutions).values(preparedExecution).run();
      return job;
    });
  }
  execution(id: string, principal: string): c.CodingExecution {
    this.required(id, principal);
    return this.executionRecord(id);
  }
  private executionRecord(id: string): c.CodingExecution {
    const row = this.db.select().from(codingExecutions).where(eq(codingExecutions.jobId, id)).get();
    if (!row) throw new CodingDecisionError("coding_execution_not_found");
    return c.parseCoding(c.CodingExecutionSchema, compactExecution(row));
  }
  claimExecution(
    id: string,
    principal: string,
    options: { allowCancelled?: boolean } = {}
  ): c.CodingExecution {
    return this.write(() => {
      const job = this.required(id, principal);
      if (job.status !== "preparing" || (job.cancelRequested && !options.allowCancelled))
        throw new CodingDecisionError("coding_execution_unavailable");
      const current = this.executionRecord(id);
      if (current.ownerToken === this.owner.token) {
        if (current.activeRunId === this.runId) return current;
        throw new CodingDecisionError("coding_execution_owned");
      }
      if (current.ownerToken && !ownerIsProvablyAbsent(current))
        throw new CodingDecisionError("coding_execution_owned");
      const next = c.parseCoding(c.CodingExecutionSchema, {
        ...current,
        fence: current.fence + 1,
        ownerToken: this.owner.token,
        ownerPid: this.owner.pid,
        ownerHost: this.owner.host,
        activeRunId: this.runId,
        phase: "preparing",
        resumeCount: current.fence === 0 ? 0 : current.resumeCount + 1,
        updatedAt: new Date().toISOString()
      });
      const updated = this.db
        .update(codingExecutions)
        .set(next)
        .where(and(eq(codingExecutions.id, current.id), eq(codingExecutions.fence, current.fence)))
        .run();
      if (updated.changes !== 1) throw new Error("coding_execution_conflict");
      return next;
    });
  }
  updateExecution(
    id: string,
    fence: number,
    principal: string,
    changes: Pick<c.CodingExecution, "phase"> &
      Partial<Pick<c.CodingExecution, "conversationId" | "taskId" | "terminalRunId">>
  ): c.CodingExecution {
    return this.write(() => {
      this.required(id, principal);
      const current = this.executionRecord(id);
      assertExecutionOwner(current, fence, this.owner.token);
      const next = c.parseCoding(c.CodingExecutionSchema, {
        ...current,
        ...changes,
        updatedAt: new Date().toISOString()
      });
      const updated = this.db
        .update(codingExecutions)
        .set(next)
        .where(
          and(
            eq(codingExecutions.id, current.id),
            eq(codingExecutions.fence, fence),
            eq(codingExecutions.ownerToken, this.owner.token)
          )
        )
        .run();
      if (updated.changes !== 1) throw new Error("coding_execution_ownership_lost");
      return next;
    });
  }
  releaseExecution(id: string, fence: number, principal: string): c.CodingExecution {
    return this.write(() => {
      this.required(id, principal);
      const current = this.executionRecord(id);
      assertExecutionOwner(current, fence, this.owner.token);
      const next = c.parseCoding(c.CodingExecutionSchema, {
        ...current,
        ownerToken: undefined,
        ownerPid: undefined,
        ownerHost: undefined,
        activeRunId: undefined,
        phase: current.phase === "terminal" ? "terminal" : "waiting-runtime",
        updatedAt: new Date().toISOString()
      });
      const updated = this.db
        .update(codingExecutions)
        .set({
          ownerToken: null,
          ownerPid: null,
          ownerHost: null,
          activeRunId: null,
          phase: next.phase,
          updatedAt: next.updatedAt
        })
        .where(
          and(
            eq(codingExecutions.id, current.id),
            eq(codingExecutions.fence, fence),
            eq(codingExecutions.ownerToken, this.owner.token)
          )
        )
        .run();
      if (updated.changes !== 1) throw new Error("coding_execution_ownership_lost");
      return next;
    });
  }
  claimLegacyCleanup(id: string, principal: string): c.CodingExecution {
    return this.write(() => {
      const job = this.required(id, principal);
      const current = this.executionRecord(id);
      if (
        job.status !== "interrupted" ||
        job.reason !== "coding_legacy_interrupted" ||
        current.profileFingerprint !== "0".repeat(64) ||
        !["blocked", "preparing"].includes(current.phase) ||
        (current.ownerToken && !ownerIsProvablyAbsent(current))
      )
        throw new CodingDecisionError("coding_legacy_cleanup_unavailable");
      const next = c.parseCoding(c.CodingExecutionSchema, {
        ...current,
        fence: current.fence + 1,
        ownerToken: this.owner.token,
        ownerPid: this.owner.pid,
        ownerHost: this.owner.host,
        activeRunId: this.runId,
        phase: "preparing",
        updatedAt: new Date().toISOString()
      });
      const updated = this.db
        .update(codingExecutions)
        .set(next)
        .where(and(eq(codingExecutions.id, current.id), eq(codingExecutions.fence, current.fence)))
        .run();
      if (updated.changes !== 1) throw new Error("coding_execution_conflict");
      return next;
    });
  }
  finishLegacyCleanup(
    id: string,
    fence: number,
    principal: string,
    completed: boolean
  ): c.CodingExecution {
    return this.write(() => {
      this.required(id, principal);
      const current = this.executionRecord(id);
      assertExecutionOwner(current, fence, this.owner.token);
      const next = c.parseCoding(c.CodingExecutionSchema, {
        ...current,
        ownerToken: undefined,
        ownerPid: undefined,
        ownerHost: undefined,
        activeRunId: undefined,
        terminalRunId: completed ? this.runId : current.terminalRunId,
        phase: completed ? "terminal" : "blocked",
        updatedAt: new Date().toISOString()
      });
      const updated = this.db
        .update(codingExecutions)
        .set({
          ownerToken: null,
          ownerPid: null,
          ownerHost: null,
          activeRunId: null,
          terminalRunId: next.terminalRunId ?? null,
          phase: next.phase,
          updatedAt: next.updatedAt
        })
        .where(
          and(
            eq(codingExecutions.id, current.id),
            eq(codingExecutions.fence, fence),
            eq(codingExecutions.ownerToken, this.owner.token)
          )
        )
        .run();
      if (updated.changes !== 1) throw new Error("coding_execution_ownership_lost");
      return next;
    });
  }
  proposal(id: string, principal: string): c.CodingProposal {
    const job = this.required(id, principal);
    const row = this.db.select().from(codingProposals).where(eq(codingProposals.jobId, id)).get();
    if (!row) throw new CodingDecisionError("coding_proposal_not_found");
    const proposal = c.parseCoding(c.CodingProposalSchema, row.data);
    if (
      row.id !== proposal.id ||
      row.jobId !== proposal.jobId ||
      proposal.id !== job.proposalId ||
      proposal.baseCommit !== job.baseCommit ||
      proposal.repository !== job.repository ||
      proposal.baseBranch !== job.baseBranch
    )
      throw new Error("coding_store_integrity_failed");
    return proposal;
  }
  private update(job: c.CodingJob, changes: Partial<c.CodingJob>): c.CodingJob {
    const data = c.parseCoding(c.CodingJobSchema, { ...job, ...changes });
    const updated = this.db
      .update(codingJobs)
      .set({ status: data.status, data })
      .where(and(eq(codingJobs.id, job.id), eq(codingJobs.status, job.status)))
      .run();
    if (updated.changes !== 1) throw new Error("coding_lifecycle_conflict");
    return data;
  }
  sealOrLoad(id: string, input: unknown, principal: string): c.CodingJob {
    const proposal = c.parseCoding(c.CodingProposalSchema, input);
    return this.write(() => {
      const job = this.required(id, principal);
      const existing = this.db
        .select()
        .from(codingProposals)
        .where(eq(codingProposals.jobId, id))
        .get();
      if (existing) {
        const stored = c.parseCoding(c.CodingProposalSchema, existing.data);
        if (JSON.stringify(stored) !== JSON.stringify(proposal) || job.proposalId !== stored.id)
          throw new Error("coding_proposal_conflict");
        return job;
      }
      if (job.cancelRequested) throw new CodingDecisionError("coding_cancelled");
      const execution = this.executionRecord(id);
      if (
        job.status !== "preparing" ||
        execution.activeRunId !== this.runId ||
        execution.ownerToken !== this.owner.token ||
        proposal.jobId !== job.id ||
        proposal.repository !== job.repository ||
        proposal.baseCommit !== job.baseCommit ||
        proposal.baseBranch !== job.baseBranch
      )
        throw new Error("coding_proposal_conflict");
      const retained = this.sqlite
        .prepare("SELECT coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM coding_proposal")
        .get() as { bytes: number };
      if (retained.bytes + Buffer.byteLength(JSON.stringify(proposal)) > 128 * 1024 * 1024)
        throw new CodingDecisionError("coding_retention_limit");
      this.db.insert(codingProposals).values({ id: proposal.id, jobId: id, data: proposal }).run();
      return this.update(job, {
        proposalId: proposal.id,
        status: proposal.checks.every((check) => check.exitCode === 0 && !check.truncated)
          ? "proposal-ready"
          : "blocked"
      });
    });
  }
  seal(id: string, input: unknown, principal: string): c.CodingJob {
    return this.sealOrLoad(id, input, principal);
  }
  approve(id: string, digest: string, principal: string): c.CodingApproval {
    return this.write(() => {
      const job = this.required(id, principal),
        proposal = this.proposal(id, principal);
      if (proposal.digest !== digest) throw new CodingDecisionError("coding_digest_mismatch");
      const execution = this.executionRecord(id);
      const prepared = this.db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, execution.terminalRunId ?? job.runId))
        .get();
      if (
        job.status !== "proposal-ready" ||
        prepared?.status !== "completed" ||
        Date.parse(job.expiresAt) <= Date.now()
      )
        throw new CodingDecisionError("coding_approval_unavailable");
      const data = c.parseCoding(c.CodingApprovalSchema, {
        id: crypto.randomUUID(),
        jobId: id,
        proposalId: proposal.id,
        digest,
        principal,
        runId: this.runId,
        consumed: false,
        expiresAt: new Date(Math.min(Date.parse(job.expiresAt), Date.now() + 300_000)).toISOString()
      });
      this.db
        .insert(codingApprovals)
        .values({ id: data.id, jobId: id, runId: this.runId, consumed: false, data })
        .run();
      return data;
    });
  }
  claim(approvalId: string, principal: string): c.Publication {
    return this.write(() => {
      const row = this.db
        .select()
        .from(codingApprovals)
        .where(eq(codingApprovals.id, approvalId))
        .get();
      if (!row) throw new CodingDecisionError("coding_approval_not_found");
      const approval = c.parseCoding(c.CodingApprovalSchema, row.data);
      if (
        approval.id !== row.id ||
        approval.jobId !== row.jobId ||
        approval.consumed !== row.consumed ||
        approval.runId !== row.runId
      )
        throw new Error("coding_store_integrity_failed");
      const job = this.required(approval.jobId, principal),
        proposal = this.proposal(job.id, principal);
      if (
        approval.principal !== principal ||
        approval.consumed ||
        approval.digest !== proposal.digest ||
        approval.proposalId !== proposal.id ||
        job.status !== "proposal-ready" ||
        Date.parse(approval.expiresAt) <= Date.now() ||
        Date.parse(job.expiresAt) <= Date.now()
      )
        throw new CodingDecisionError("coding_approval_unavailable");
      const consumed = { ...approval, consumed: true };
      const result = this.db
        .update(codingApprovals)
        .set({ consumed: true, data: consumed })
        .where(and(eq(codingApprovals.id, approvalId), eq(codingApprovals.consumed, false)))
        .run();
      if (result.changes !== 1) throw new Error("coding_lifecycle_conflict");
      const operation = c.parseCoding(c.PublicationSchema, {
        id: crypto.randomUUID(),
        jobId: job.id,
        proposalId: proposal.id,
        digest: proposal.digest,
        runId: this.runId,
        status: "publishing",
        activeRunId: this.runId
      });
      this.db
        .insert(codingPublications)
        .values({ id: operation.id, jobId: job.id, runId: this.runId, data: operation })
        .run();
      this.update(job, { status: "publishing" });
      return operation;
    });
  }
  publication(id: string, principal: string): c.Publication | undefined {
    this.required(id, principal);
    const row = this.db
      .select()
      .from(codingPublications)
      .where(eq(codingPublications.jobId, id))
      .get();
    if (!row) return undefined;
    const data = c.parseCoding(c.PublicationSchema, row.data);
    if (data.id !== row.id || data.jobId !== row.jobId || data.runId !== row.runId)
      throw new Error("coding_store_integrity_failed");
    return data;
  }
  publicationResult(id: string, input: unknown, principal: string): c.Publication {
    const operation = c.parseCoding(c.PublicationSchema, input);
    return this.write(() => {
      const current = this.publication(id, principal),
        job = this.required(id, principal);
      if (
        !current ||
        current.id !== operation.id ||
        current.digest !== operation.digest ||
        current.proposalId !== operation.proposalId ||
        current.jobId !== operation.jobId ||
        current.runId !== operation.runId ||
        (current.activeRunId ?? current.runId) !== this.runId ||
        operation.activeRunId !== current.activeRunId ||
        !["publishing", "publication-uncertain"].includes(job.status)
      )
        throw new Error("coding_publication_conflict");
      this.db
        .update(codingPublications)
        .set({ data: operation })
        .where(eq(codingPublications.id, current.id))
        .run();
      this.update(job, { status: operation.status, reason: operation.reason });
      return operation;
    });
  }
  requestCancellation(id: string, principal: string): c.CodingJob {
    return this.write(() => {
      const job = this.required(id, principal);
      if (job.status !== "preparing") throw new CodingDecisionError("coding_job_not_active");
      return this.update(job, { cancelRequested: true });
    });
  }
  assertExecutionRemovable(id: string, principal: string): void {
    const execution = this.execution(id, principal);
    if (execution.ownerToken && !ownerIsProvablyAbsent(execution))
      throw new CodingDecisionError("coding_cleanup_active");
  }
  resumePublication(id: string, principal: string): c.Publication {
    return this.write(() => {
      const operation = this.publication(id, principal);
      const job = this.required(id, principal);
      if (
        !operation ||
        !["publishing", "publication-uncertain"].includes(job.status) ||
        !["publishing", "publication-uncertain"].includes(operation.status)
      )
        throw new CodingDecisionError("coding_reconciliation_unavailable");
      const owner = this.db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, operation.activeRunId ?? operation.runId))
        .get();
      if (!owner || owner.status === "running")
        throw new CodingDecisionError("coding_publication_active");
      const next = c.parseCoding(c.PublicationSchema, {
        ...operation,
        activeRunId: this.runId,
        status: "publishing"
      });
      this.db
        .update(codingPublications)
        .set({ data: next })
        .where(eq(codingPublications.id, operation.id))
        .run();
      this.update(job, { status: "publishing" });
      return next;
    });
  }
  transition(
    id: string,
    status: c.CodingJob["status"],
    principal: string,
    reason?: string
  ): c.CodingJob {
    return this.write(() => {
      const job = this.required(id, principal);
      const allowed: Record<string, string[]> = {
        preparing: ["failed", "interrupted", "blocked"],
        "proposal-ready": ["rejected", "expired"],
        blocked: ["rejected", "expired"],
        failed: ["expired"],
        interrupted: ["expired"],
        rejected: ["expired"]
      };
      if (!allowed[job.status]?.includes(status))
        throw new CodingDecisionError("coding_lifecycle_conflict");
      return this.update(job, {
        status,
        ...(reason ? { reason: captureHistoryMetadata(reason).text.slice(0, 2048) } : {})
      });
    });
  }
  removePrivateProposal(id: string, principal: string): void {
    this.write(() => {
      const job = this.required(id, principal);
      if (job.status !== "expired") throw new CodingDecisionError("coding_cleanup_unavailable");
      this.db.delete(codingApprovals).where(eq(codingApprovals.jobId, id)).run();
      this.db.delete(codingProposals).where(eq(codingProposals.jobId, id)).run();
    });
  }
}

export function compactExecution(row: typeof codingExecutions.$inferSelect): c.CodingExecution {
  return {
    id: row.id,
    jobId: row.jobId,
    task: row.task,
    profileFingerprint: row.profileFingerprint,
    deadlineAt: row.deadlineAt,
    fence: row.fence,
    phase: row.phase,
    resumeCount: row.resumeCount,
    updatedAt: row.updatedAt,
    ...(row.conversationId === null ? {} : { conversationId: row.conversationId }),
    ...(row.taskId === null ? {} : { taskId: row.taskId }),
    ...(row.ownerToken === null ? {} : { ownerToken: row.ownerToken }),
    ...(row.ownerPid === null ? {} : { ownerPid: row.ownerPid }),
    ...(row.ownerHost === null ? {} : { ownerHost: row.ownerHost }),
    ...(row.activeRunId === null ? {} : { activeRunId: row.activeRunId }),
    ...(row.terminalRunId === null ? {} : { terminalRunId: row.terminalRunId })
  };
}

function assertExecutionOwner(
  execution: c.CodingExecution,
  fence: number,
  ownerToken: string
): void {
  if (execution.fence !== fence || execution.ownerToken !== ownerToken)
    throw new Error("coding_execution_ownership_lost");
}

function ownerIsProvablyAbsent(execution: c.CodingExecution): boolean {
  if (
    execution.ownerHost !== os.hostname() ||
    execution.ownerPid === undefined ||
    execution.ownerPid === process.pid
  )
    return false;
  try {
    process.kill(execution.ownerPid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
