import crypto from "node:crypto";

import type Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { captureHistoryMetadata } from "../harness/history-capture.js";
import * as c from "../plugins/coding/schemas.js";
import {
  codingJobs,
  codingProposals,
  codingApprovals,
  codingPublications,
  runs
} from "./schema.js";

export const codingBootstrapSql = `
CREATE TABLE coding_job (id TEXT PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES run(id),
 status TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
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
    private readonly assertActive: () => void
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
  create(input: unknown): c.CodingJob {
    const job = c.parseCoding(c.CodingJobSchema, input);
    if (job.runId !== this.runId || job.status !== "preparing")
      throw new Error("coding_job_invalid_start");
    return this.write(() => {
      this.db
        .insert(codingJobs)
        .values({ id: job.id, runId: this.runId, status: job.status, data: job })
        .run();
      return job;
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
  seal(id: string, input: unknown, principal: string): c.CodingJob {
    const proposal = c.parseCoding(c.CodingProposalSchema, input);
    return this.write(() => {
      const job = this.required(id, principal);
      if (job.cancelRequested) throw new CodingDecisionError("coding_cancelled");
      if (
        job.status !== "preparing" ||
        job.runId !== this.runId ||
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
  approve(id: string, digest: string, principal: string): c.CodingApproval {
    return this.write(() => {
      const job = this.required(id, principal),
        proposal = this.proposal(id, principal);
      if (proposal.digest !== digest) throw new CodingDecisionError("coding_digest_mismatch");
      const prepared = this.db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, job.runId))
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
  recover(id: string, principal: string): c.CodingJob {
    return this.write(() => {
      const job = this.required(id, principal);
      const run = this.db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, job.runId))
        .get();
      if (
        !run ||
        run.status === "running" ||
        !["preparing", "interrupted", "failed"].includes(job.status)
      )
        throw new CodingDecisionError("coding_recovery_unavailable");
      if (job.status !== "preparing") return job;
      return this.update(job, { status: "interrupted", reason: "coding_owner_stopped" });
    });
  }
}
