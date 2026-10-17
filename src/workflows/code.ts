import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { codingProfile } from "../plugins/coding/config.js";
import type { CodingPolicy } from "../plugins/coding/config.js";
import { CodingGitHubSource } from "../plugins/coding/github-source.js";
import {
  assertCandidateChangePolicy,
  freezeProposal,
  restoreCandidate,
  sourceManifestDigest,
  validateSource
} from "../plugins/coding/proposal.js";
import { codingInstructions } from "../plugins/coding/skill.js";
import { CodingTaskSchema, parseCoding } from "../plugins/coding/schemas.js";
import type {
  CodingJob,
  CodingExecution,
  CodingProposal,
  SourceFile,
  CodingTask
} from "../plugins/coding/schemas.js";
import type { InteractionRecorder } from "../harness/interaction.js";
import type {
  runDurableCodingTurn,
  runDurableCodingVerification,
  checkpointDurableCodingProposal,
  validateDurableCodingExecution
} from "../harness/coding-durable.js";
import { beginInteraction } from "../harness/interaction.js";
import { codingProfileFingerprint } from "../harness/coding-runtime.js";
import { captureHistory } from "../harness/history-capture.js";
import { openHistoryStore } from "../db/index.js";
import { DockerWorker } from "../workspaces/docker.js";
import { prepareCodingExecutionDatabase } from "../workspaces/storage.js";
import { logger } from "../logger.js";

const activeJobs = new Map<string, { principal: string; controller: AbortController }>();
export function cancelCodingJob(id: string, principal: string): boolean {
  const active = activeJobs.get(id);
  if (!active || active.principal !== principal) return false;
  active.controller.abort(new Error("coding_cancelled"));
  return true;
}

export async function cleanupLegacyCodingWorkers(
  options: {
    home?: string;
    signal?: AbortSignal;
    cleanup?: (jobId: string) => Promise<void>;
    limit?: number;
  } = {}
): Promise<number> {
  const store = openHistoryStore(options.home ? { home: options.home } : {});
  let candidates: ReturnType<typeof store.listLegacyCodingCleanup>;
  try {
    candidates = store.listLegacyCodingCleanup(options.limit ?? 100);
  } finally {
    store.close();
  }
  let completed = 0;
  for (const { job } of candidates) {
    const recording = beginInteraction(
      {
        source: "runtime",
        kind: "coding_legacy_cleanup",
        userMessage: `Clean legacy coding workers for job ${job.id}`,
        target: job.repository,
        metadata: { jobId: job.id }
      },
      { ...(options.home ? { home: options.home } : {}), signal: options.signal }
    );
    let fence: number | undefined;
    try {
      const execution = recording.coding((store) =>
        store.claimLegacyCleanup(job.id, job.principal)
      );
      fence = execution.fence;
      await recording.recordTool(
        {
          name: "coding.cleanup_legacy_workers",
          source: "coding",
          kind: "capability",
          input: { jobId: job.id }
        },
        () => (options.cleanup ?? DockerWorker.cleanupJob)(job.id)
      );
      recording.coding((store) =>
        store.finishLegacyCleanup(job.id, execution.fence, job.principal, true)
      );
      recording.finishRun({ status: "completed" });
      recording.finishInteraction({ status: "completed" });
      ++completed;
    } catch {
      if (fence !== undefined) {
        try {
          recording.coding((store) =>
            store.finishLegacyCleanup(job.id, fence!, job.principal, false)
          );
        } catch {
          // Ownership or storage failure is already durable; a later process may reclaim it.
        }
      }
      recording.finishRun({ status: "failed", error: "coding_legacy_cleanup_failed" });
      recording.finishInteraction({ status: "failed", error: "coding_legacy_cleanup_failed" });
      logger.warn({ job_id: job.id }, "coding.legacy_cleanup_failed");
    } finally {
      recording.close();
    }
  }
  return completed;
}

interface CodingDependencies {
  source?: CodingGitHubSource;
  worker?: typeof DockerWorker.start;
  turn?: typeof runDurableCodingTurn;
  verify?: typeof runDurableCodingVerification;
  checkpointProposal?: typeof checkpointDurableCodingProposal;
  validateExecution?: typeof validateDurableCodingExecution;
  preflight?: typeof DockerWorker.preflight;
  onJob?: (job: CodingJob) => void | Promise<void>;
  conversationKey?: string;
  expectedBaseCommit?: string;
  resumeJobId?: string;
}

export async function prepareCoding(
  input: CodingTask,
  principal: string,
  policy: CodingPolicy,
  parent: InteractionRecorder,
  dependencies: CodingDependencies = {}
): Promise<CodingJob> {
  const task = parseCoding(CodingTaskSchema, input);
  const profile = codingProfile(policy, principal, task.repository);
  const profileFingerprint = codingProfileFingerprint(profile, policy);
  if (activeJobs.size >= 4) throw new Error("coding_admission_limit");
  const recording = parent.childRun({
    kind: "coding_prepare",
    target: task.repository,
    ref: task.baseBranch
  });
  const controller = new AbortController();
  const deadlineController = new AbortController();
  let deadlineAt = new Date(Date.now() + policy.timeoutMs).toISOString();
  let deadlineTimer = setTimeout(
    () => deadlineController.abort(new Error("coding_deadline_exceeded")),
    policy.timeoutMs
  );
  const reservationId = crypto.randomUUID();
  activeJobs.set(reservationId, { principal, controller });
  const signal = AbortSignal.any([recording.signal, controller.signal, deadlineController.signal]);
  const source = dependencies.source ?? new CodingGitHubSource(policy.readToken);
  const start = dependencies.worker ?? DockerWorker.start;
  let job: CodingJob | undefined;
  let fence: number | undefined;
  let cancellationPoll: ReturnType<typeof setInterval> | undefined;
  try {
    let baseCommit: string;
    if (dependencies.resumeJobId) {
      job = recording.coding((store) => store.get(dependencies.resumeJobId!, principal));
      if (!job || job.status !== "preparing") throw new Error("coding_resume_unavailable");
      const existing = recording.coding((store) => store.execution(job!.id, principal));
      if (
        existing.task !== task.task ||
        existing.profileFingerprint !== profileFingerprint ||
        Date.parse(existing.deadlineAt) <= Date.now()
      )
        throw new Error("coding_resume_policy_changed");
      deadlineAt = existing.deadlineAt;
      clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(
        () => deadlineController.abort(new Error("coding_deadline_exceeded")),
        Date.parse(deadlineAt) - Date.now()
      );
      baseCommit = job.baseCommit;
    } else {
      baseCommit = await recording.recordTool(
        {
          name: "coding.resolve_base",
          source: "coding",
          kind: "capability",
          input: task.repository
        },
        () => source.base(task, signal),
        signal
      );
      if (dependencies.expectedBaseCommit && dependencies.expectedBaseCommit !== baseCommit)
        throw new Error("coding_confirmed_base_moved");
      job = recording.coding((store) => {
        const createdAt = new Date().toISOString();
        return store.create(
          {
            id: crypto.randomUUID(),
            principal,
            repository: task.repository,
            baseBranch: task.baseBranch,
            baseCommit,
            runId: recording.runId,
            status: "preparing",
            ...(dependencies.conversationKey
              ? { conversationKey: dependencies.conversationKey }
              : {}),
            createdAt,
            expiresAt: new Date(Date.now() + (policy.retentionMs ?? 86400000)).toISOString()
          },
          {
            task: task.task,
            profileFingerprint,
            deadlineAt
          }
        );
      });
    }
    recording.updateRun({ commitSha: baseCommit, metadata: { jobId: job.id } });
    logger.info(
      {
        interaction_id: recording.interactionId,
        run_id: recording.runId,
        job_id: job.id,
        target_url: `https://github.com/${job.repository}`,
        workspace_commit_sha: baseCommit,
        model: policy.model,
        timeout_ms: policy.timeoutMs
      },
      "coding.started"
    );
    activeJobs.set(job.id, { principal, controller });
    activeJobs.delete(reservationId);
    cancellationPoll = setInterval(() => {
      try {
        if (recording.coding((store) => store.get(job!.id, principal))?.cancelRequested)
          controller.abort(new Error("coding_cancelled"));
      } catch {
        controller.abort(new Error("coding_recording_stopped"));
      }
    }, 250);
    await dependencies.onJob?.(job);
    if (
      dependencies.resumeJobId === undefined &&
      recording.coding((store) => store.get(job!.id, principal))?.cancelRequested
    ) {
      controller.abort(new Error("coding_cancelled"));
      throw new Error("coding_cancelled");
    }
    const execution = recording.coding((store) =>
      store.claimExecution(job!.id, principal, {
        allowCancelled: dependencies.resumeJobId !== undefined
      })
    );
    fence = execution.fence;
    const assertOwned = () => {
      const current = recording.coding((store) => store.execution(job!.id, principal));
      if (current.fence !== fence || current.activeRunId !== recording.runId)
        throw new Error("coding_execution_ownership_lost");
    };
    const projectExecution = (current: CodingExecution) => {
      recording.updateRun({
        metadata: {
          jobId: job!.id,
          execution: {
            phase: current.phase,
            fence: current.fence,
            resumeCount: current.resumeCount,
            deadlineAt: current.deadlineAt,
            ...(current.conversationId === undefined
              ? {}
              : { conversationId: current.conversationId }),
            ...(current.taskId === undefined ? {} : { taskId: current.taskId })
          }
        }
      });
      return current;
    };
    const updateExecution = (
      changes: Pick<CodingExecution, "phase"> &
        Partial<Pick<CodingExecution, "conversationId" | "taskId" | "terminalRunId">>
    ) =>
      projectExecution(
        recording.coding((store) => store.updateExecution(job!.id, fence!, principal, changes))
      );
    projectExecution(execution);
    await DockerWorker.cleanupJob(job.id);
    if (recording.coding((store) => store.get(job!.id, principal))?.cancelRequested) {
      controller.abort(new Error("coding_cancelled"));
      throw new Error("coding_cancelled");
    }
    const databasePath = prepareCodingExecutionDatabase(
      job.id,
      path.dirname(path.dirname(recording.artifactsPath))
    );
    const validateExecution =
      dependencies.validateExecution ??
      (await import("../harness/coding-durable.js")).validateDurableCodingExecution;
    await validateExecution(databasePath, signal);
    const preflight =
      dependencies.preflight ?? (dependencies.worker ? undefined : DockerWorker.preflight);
    await preflight?.(profile, signal);
    let base: SourceFile[] | undefined;
    await recording.recordTool(
      {
        name: "coding.acquire_source",
        source: "coding",
        kind: "capability",
        input: { baseCommit }
      },
      async () => {
        const files = await source.files(task, baseCommit, signal);
        validateSource(files);
        base = files;
        return { files: files.length, manifestDigest: sourceManifestDigest(files) };
      },
      signal
    );
    if (!base) throw new Error("coding_source_result_missing");
    recording.assertHealthy();
    signal.throwIfAborted();
    const baseline = base;
    const turn =
      dependencies.turn ?? (await import("../harness/coding-durable.js")).runDurableCodingTurn;
    updateExecution({ phase: "preparing" });
    let turnResult = await turn({
      databasePath,
      baseline,
      profile,
      jobId: job.id,
      fence,
      task: task.task,
      instructions: codingInstructions(baseline),
      requestId: "initial",
      deadlineAt: execution.deadlineAt,
      policy,
      model: policy.model,
      recording,
      signal,
      assertOwned,
      start,
      apiKey: process.env.MINIMAX_API_KEY
    });
    updateExecution({
      phase: "verifying",
      conversationId: turnResult.conversationId,
      taskId: turnResult.submissionId
    });
    let summary = turnResult.summary;
    recording.assertHealthy();
    signal.throwIfAborted();
    let final = restoreCandidate(baseline, turnResult.candidate);
    validateSource(final);
    assertCandidateChangePolicy(profile, baseline, final);
    const verify =
      dependencies.verify ??
      (await import("../harness/coding-durable.js")).runDurableCodingVerification;
    const durableVerify = (candidate: typeof turnResult.candidate) =>
      verify({
        databasePath,
        baseline,
        candidate,
        profile,
        jobId: job!.id,
        fence: fence!,
        recording,
        signal,
        assertOwned,
        start
      });
    let checks = await durableVerify(turnResult.candidate);
    for (
      let attempt = 1;
      attempt <= (policy.maxRepairAttempts ?? 1) && repairable(checks);
      attempt++
    ) {
      logger.info(
        { run_id: recording.runId, job_id: job.id, repair_attempt: attempt },
        "coding.repair_started"
      );
      updateExecution({ phase: "repairing" });
      turnResult = await turn({
        databasePath,
        baseline,
        profile,
        jobId: job.id,
        fence,
        task: repairTask(task.task, checks),
        instructions: codingInstructions(baseline),
        requestId: `repair-${attempt}`,
        deadlineAt: execution.deadlineAt,
        policy,
        repairAttempt: attempt,
        model: policy.model,
        recording,
        signal,
        assertOwned,
        start,
        apiKey: process.env.MINIMAX_API_KEY
      });
      summary = turnResult.summary;
      recording.assertHealthy();
      signal.throwIfAborted();
      final = restoreCandidate(baseline, turnResult.candidate);
      validateSource(final);
      assertCandidateChangePolicy(profile, baseline, final);
      updateExecution({
        phase: "verifying",
        conversationId: turnResult.conversationId,
        taskId: turnResult.submissionId
      });
      checks = await durableVerify(turnResult.candidate);
    }
    updateExecution({ phase: "sealing" });
    const proposal = freezeProposal(
      {
        id: `proposal-${job.id}`,
        jobId: job.id,
        repository: task.repository,
        baseBranch: task.baseBranch,
        baseCommit,
        task: task.task,
        summary,
        createdAt: job.createdAt
      },
      baseline,
      final,
      checks
    );
    const checkpointProposal =
      dependencies.checkpointProposal ??
      (await import("../harness/coding-durable.js")).checkpointDurableCodingProposal;
    await checkpointProposal({
      databasePath,
      proposal,
      signal,
      assertOwned
    });
    const jobId = job.id;
    const artifact = path.join(recording.artifactsPath, `${proposal.id}-coding-proposal.md`);
    const projected = {
      ...job,
      proposalId: proposal.id,
      status: proposal.checks.every((check) => check.exitCode === 0 && !check.truncated)
        ? ("proposal-ready" as const)
        : ("blocked" as const)
    };
    const display = proposalDisplay(projected, proposal);
    try {
      await fs.writeFile(artifact, display, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await fs.readFile(artifact, "utf8")) !== display)
        throw new Error("coding_artifact_conflict");
    }
    recording.registerArtifact({
      path: artifact,
      type: "coding-proposal",
      title: `Coding proposal ${job.id}`
    });
    job = recording.coding((store) => store.sealOrLoad(jobId, proposal, principal));
    recording.updateRun({
      metadata: {
        jobId: job.id,
        proposalId: proposal.id,
        digest: proposal.digest,
        status: job.status
      }
    });
    updateExecution({ phase: "terminal", terminalRunId: recording.runId });
    recording.coding((store) => store.releaseExecution(job!.id, fence!, principal));
    recording.finishRun({
      status: job.status === "proposal-ready" ? "completed" : "failed",
      ...(job.status === "blocked" ? { error: "coding_required_checks_failed" } : {})
    });
    logger.info(
      { run_id: recording.runId, job_id: job.id, status: job.status },
      "coding.proposal_sealed"
    );
    return job;
  } catch (error) {
    recording.assertHealthy();
    const cancelled =
      controller.signal.aborted &&
      controller.signal.reason instanceof Error &&
      controller.signal.reason.message === "coding_cancelled";
    const deadlineExceeded = deadlineController.signal.aborted;
    const reason = cancelled
      ? "coding_cancelled"
      : deadlineExceeded
        ? "coding_deadline_exceeded"
        : signal.aborted
          ? "coding_preparation_interrupted"
          : error instanceof Error && /^coding_[a-z_]+$/.test(error.message)
            ? error.message
            : "coding_preparation_stopped";
    if (job && job.status === "preparing") {
      // The run remains active until its job decision is durable; cancellation must not bypass recording.
      if (!recording.signal.aborted && (cancelled || deadlineExceeded || !signal.aborted))
        recording.coding((store) =>
          store.transition(job!.id, cancelled ? "interrupted" : "failed", principal, reason)
        );
    }
    if (job && fence !== undefined && !recording.signal.aborted) {
      try {
        recording.coding((store) => store.releaseExecution(job!.id, fence!, principal));
      } catch {
        // Lost ownership is already durable and must not mask the preparation failure.
      }
    }
    logger.warn(
      {
        interaction_id: recording.interactionId,
        run_id: recording.runId,
        job_id: job?.id,
        error_type: "CodingStopped"
      },
      "coding.failed"
    );
    recording.finishRun({
      status: signal.aborted && !deadlineExceeded ? "cancelled" : "failed",
      error: reason
    });
    throw error instanceof Error && error.message.startsWith("coding_")
      ? error
      : new Error(reason, { cause: error });
  } finally {
    if (cancellationPoll) clearInterval(cancellationPoll);
    clearTimeout(deadlineTimer);
    activeJobs.delete(reservationId);
    if (job) activeJobs.delete(job.id);
    if (job && fence !== undefined)
      await DockerWorker.cleanupJobFence(job.id, fence).catch(() => {});
    recording.close();
  }
}

export async function resumeCoding(
  jobId: string,
  principal: string,
  policy: CodingPolicy,
  parent: InteractionRecorder,
  dependencies: Omit<CodingDependencies, "resumeJobId"> = {}
): Promise<CodingJob> {
  const job = parent.coding((store) => store.get(jobId, principal));
  if (!job) throw new Error("coding_job_not_found");
  const execution = parent.coding((store) => store.execution(job.id, principal));
  return prepareCoding(
    {
      repository: job.repository,
      baseBranch: job.baseBranch,
      task: execution.task
    },
    principal,
    policy,
    parent,
    { ...dependencies, resumeJobId: job.id, conversationKey: job.conversationKey }
  );
}

function repairable(checks: CodingProposal["checks"]): boolean {
  return checks.some((check) => check.exitCode !== 0) && checks.every((check) => !check.truncated);
}

function repairTask(task: string, checks: CodingProposal["checks"]): string {
  const diagnostics = checks
    .filter((check) => check.exitCode !== 0)
    .map(
      (check) =>
        `Command: ${check.command}\nExit: ${check.exitCode}\nOutput:\n${captureHistory(check.output).text}`
    )
    .join("\n\n");
  return `Repair the current candidate for the original task below. A fresh read-only verifier failed. Make only changes needed to resolve these failures, review the cumulative diff, and rerun the configured checks.\n\nOriginal task:\n${task}\n\nVerifier failures:\n${diagnostics}`.slice(
    0,
    32768
  );
}

export function proposalDisplay(job: CodingJob, proposal?: CodingProposal): string {
  const sections = [
    `# Coding Proposal`,
    `Job: ${job.id}`,
    `Repository: ${job.repository}`,
    `Base: ${job.baseBranch} @ ${job.baseCommit}`,
    `Status: ${job.status}`,
    `Expires: ${job.expiresAt}`,
    ...(job.reason ? [`Reason: ${job.reason}`] : []),
    ...(proposal
      ? [
          `Digest: ${proposal.digest}`,
          `Draft branch: ${proposal.branch}`,
          `Title: ${proposal.title}`,
          `\n## Task\n${proposal.task}`,
          `\n## Summary\n${proposal.summary}`,
          `\n## Changed Files\n${proposal.files.map((file) => `- ${file.path} (${file.mode})`).join("\n")}\n${proposal.deleted.map((file) => `- deleted ${file}`).join("\n")}`,
          `\n## Verification\n${proposal.checks.map((check) => `### ${check.command}\nExit: ${check.exitCode}; truncated: ${check.truncated}\n\n${check.output}`).join("\n\n")}`,
          `\n## Proposed Changes\n${proposal.files.map((file) => `### ${file.path}\n\n${file.content}`).join("\n\n")}`,
          `\n## Draft PR Body\n${proposal.body}`,
          "Offline verification only. Human review is required. No remote branch or PR has been created."
        ]
      : [])
  ];
  let bytes = 0;
  const safe: string[] = [];
  for (const section of sections) {
    const display =
      section.length <= 65536
        ? captureHistory(section).text
        : "[Section omitted: exceeds display limit. Inspect exact private proposal locally before approval.]";
    bytes += Buffer.byteLength(display);
    if (bytes > 256 * 1024) {
      safe.push("[Remaining display omitted: size limit.]");
      break;
    }
    safe.push(display);
  }
  return safe.join("\n\n");
}
