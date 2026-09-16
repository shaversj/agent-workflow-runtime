import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { codingProfile } from "../plugins/coding/config.js";
import type { CodingPolicy } from "../plugins/coding/config.js";
import { CodingGitHubSource } from "../plugins/coding/github-source.js";
import { freezeProposal, validateSource } from "../plugins/coding/proposal.js";
import { codingInstructions } from "../plugins/coding/skill.js";
import { CodingTaskSchema, parseCoding } from "../plugins/coding/schemas.js";
import type {
  CodingJob,
  CodingProposal,
  CodingTask,
  SourceFile
} from "../plugins/coding/schemas.js";
import type { InteractionRecorder } from "../harness/interaction.js";
import type { runIsolatedCoding } from "../harness/coding-runtime.js";
import { captureHistory } from "../harness/history-capture.js";
import { DockerWorker } from "../workspaces/docker.js";
import { logger } from "../logger.js";

const activeJobs = new Map<string, { principal: string; controller: AbortController }>();
export function cancelCodingJob(id: string, principal: string): boolean {
  const active = activeJobs.get(id);
  if (!active || active.principal !== principal) return false;
  active.controller.abort(new Error("coding_cancelled"));
  return true;
}

interface CodingDependencies {
  source?: CodingGitHubSource;
  worker?: typeof DockerWorker.start;
  runtime?: typeof runIsolatedCoding;
  onJob?: (job: CodingJob) => void | Promise<void>;
  conversationKey?: string;
  expectedBaseCommit?: string;
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
  if (activeJobs.size >= 4) throw new Error("coding_admission_limit");
  const recording = parent.childRun({
    kind: "coding_prepare",
    target: task.repository,
    ref: task.baseBranch
  });
  const controller = new AbortController();
  const reservationId = crypto.randomUUID();
  activeJobs.set(reservationId, { principal, controller });
  const signal = AbortSignal.any([
    recording.signal,
    controller.signal,
    AbortSignal.timeout(policy.timeoutMs)
  ]);
  const source = dependencies.source ?? new CodingGitHubSource(policy.readToken);
  const start = dependencies.worker ?? DockerWorker.start;
  let worker: DockerWorker | undefined,
    verifier: DockerWorker | undefined,
    job: CodingJob | undefined;
  let cancellationPoll: ReturnType<typeof setInterval> | undefined;
  const abort = () => {
    void worker?.close().catch(() => {});
    void verifier?.close().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const baseCommit = await recording.recordTool(
      { name: "coding.resolve_base", source: "coding", kind: "capability", input: task.repository },
      () => source.base(task, signal),
      signal
    );
    if (dependencies.expectedBaseCommit && dependencies.expectedBaseCommit !== baseCommit)
      throw new Error("coding_confirmed_base_moved");
    recording.updateRun({ commitSha: baseCommit });
    job = recording.coding((store) =>
      store.create({
        id: crypto.randomUUID(),
        principal,
        repository: task.repository,
        baseBranch: task.baseBranch,
        baseCommit,
        runId: recording.runId,
        status: "preparing",
        ...(dependencies.conversationKey ? { conversationKey: dependencies.conversationKey } : {}),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + (policy.retentionMs ?? 86400000)).toISOString()
      })
    );
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
    const base = await recording.recordTool(
      {
        name: "coding.acquire_source",
        source: "coding",
        kind: "capability",
        input: { baseCommit }
      },
      async () => {
        const files = await source.files(task, baseCommit, signal);
        validateSource(files);
        return files;
      },
      signal
    );
    recording.assertHealthy();
    signal.throwIfAborted();
    worker = await start(profile, signal, job.id);
    if (signal.aborted) {
      await worker.close();
      signal.throwIfAborted();
    }
    recording.updateRun({ metadata: { jobId: job.id, workerId: worker.id } });
    await worker.importFiles(base);
    const baseline = await worker.snapshot();
    const runtime =
      dependencies.runtime ?? (await import("../harness/coding-runtime.js")).runIsolatedCoding;
    const summary = await runtime(
      worker,
      task.task,
      codingInstructions(baseline),
      recording,
      policy,
      signal
    );
    recording.assertHealthy();
    signal.throwIfAborted();
    const final = await worker.snapshot();
    validateSource(final);
    await worker.close();
    worker = undefined;
    verifier = await start(profile, signal, job.id, true);
    if (signal.aborted) {
      await verifier.close();
      signal.throwIfAborted();
    }
    await verifier.importFiles(final);
    await verifier.freeze();
    const sealed = await verifier.snapshot();
    const checks: CodingProposal["checks"] = [];
    for (const command of profile.requiredChecks) {
      const current = verifier;
      const result = await recording.recordTool(
        { name: "coding.verify", source: "coding", kind: "capability", input: { command } },
        () => current.command(command, signal),
        signal
      );
      checks.push(result);
    }
    const after = await verifier.snapshot();
    if (!sameSnapshot(sealed, after)) throw new Error("coding_verification_mutated_snapshot");
    await verifier.close();
    verifier = undefined;
    const proposal = freezeProposal(
      {
        id: crypto.randomUUID(),
        jobId: job.id,
        repository: task.repository,
        baseBranch: task.baseBranch,
        baseCommit,
        task: task.task,
        summary,
        createdAt: new Date().toISOString()
      },
      baseline,
      final,
      checks
    );
    const jobId = job.id;
    job = recording.coding((store) => store.seal(jobId, proposal, principal));
    const artifact = path.join(recording.artifactsPath, `${recording.runId}-coding-proposal.md`);
    await fs.writeFile(artifact, proposalDisplay(job, proposal), { mode: 0o600, flag: "wx" });
    recording.registerArtifact({
      path: artifact,
      type: "coding-proposal",
      title: `Coding proposal ${job.id}`
    });
    recording.updateRun({
      metadata: {
        jobId: job.id,
        proposalId: proposal.id,
        digest: proposal.digest,
        status: job.status
      }
    });
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
    const reason =
      controller.signal.aborted &&
      controller.signal.reason instanceof Error &&
      controller.signal.reason.message === "coding_cancelled"
        ? "coding_cancelled"
        : signal.aborted
          ? "coding_preparation_interrupted"
          : error instanceof Error && /^coding_[a-z_]+$/.test(error.message)
            ? error.message
            : "coding_preparation_stopped";
    if (job && job.status === "preparing") {
      // The run remains active until its job decision is durable; cancellation must not bypass recording.
      if (!recording.signal.aborted)
        recording.coding((store) =>
          store.transition(job!.id, signal.aborted ? "interrupted" : "failed", principal, reason)
        );
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
      status: signal.aborted ? "cancelled" : "failed",
      error: reason
    });
    throw error instanceof Error && error.message.startsWith("coding_") ? error : new Error(reason);
  } finally {
    if (cancellationPoll) clearInterval(cancellationPoll);
    signal.removeEventListener("abort", abort);
    activeJobs.delete(reservationId);
    if (job) activeJobs.delete(job.id);
    const cleanup: Promise<void>[] = [];
    if (worker) cleanup.push(worker.close());
    if (verifier) cleanup.push(verifier.close());
    for (const operation of cleanup) await operation;
    recording.close();
  }
}

function sameSnapshot(a: SourceFile[], b: SourceFile[]): boolean {
  const stable = (files: SourceFile[]) =>
    JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path, "en")));
  return stable(a) === stable(b);
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
