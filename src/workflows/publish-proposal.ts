import type { InteractionRecorder } from "../harness/interaction.js";
import { codingProfile } from "../plugins/coding/config.js";
import type { CodingPolicy } from "../plugins/coding/config.js";
import { validateProposal } from "../plugins/coding/proposal.js";
import type { Publication } from "../plugins/coding/schemas.js";
import { GitHubPublicationClient } from "../plugins/github/publication/client.js";
import { logger } from "../logger.js";

export async function publishProposal(
  jobId: string,
  digest: string,
  principal: string,
  policy: CodingPolicy,
  parent: InteractionRecorder,
  reconcile = false,
  client?: GitHubPublicationClient,
  conversationKey?: string
): Promise<Publication> {
  if (!policy.publicationEnabled || !policy.writeToken)
    throw new Error("coding_publication_disabled");
  const recording = parent.childRun({ kind: reconcile ? "coding_reconcile" : "coding_publish" });
  const signal = AbortSignal.any([
    recording.signal,
    AbortSignal.timeout(Math.min(policy.timeoutMs, 300000))
  ]);
  let operation: Publication | undefined;
  try {
    const job = recording.coding((store) => store.get(jobId, principal));
    if (!job) throw new Error("coding_job_not_found");
    if (job.conversationKey && job.conversationKey !== conversationKey)
      throw new Error("coding_conversation_denied");
    const profile = codingProfile(policy, principal, job.repository);
    const proposal = validateProposal(
      recording.coding((store) => store.proposal(jobId, principal)),
      profile.requiredChecks
    );
    if (digest !== proposal.digest || (!reconcile && Date.parse(job.expiresAt) <= Date.now()))
      throw new Error("coding_approval_unavailable");
    recording.updateRun({
      target: job.repository,
      ref: job.baseBranch,
      commitSha: job.baseCommit,
      metadata: { jobId, proposalId: proposal.id, digest }
    });
    const github = client ?? new GitHubPublicationClient(policy.writeToken);
    github.audit(recording);
    if (reconcile) {
      operation = recording.coding((store) => store.resumePublication(jobId, principal));
      if (!operation || !["publishing", "publication-uncertain"].includes(operation.status))
        throw new Error("coding_reconciliation_unavailable");
    } else {
      const approval = recording.coding((store) => store.approve(jobId, digest, principal));
      operation = recording.coding((store) => store.claim(approval.id, principal));
    }
    const observe = <T>(name: string, action: () => Promise<T>) =>
      recording.recordTool(
        {
          name: `github.publication_${name}`,
          source: "github",
          kind: "capability",
          input: { jobId, digest }
        },
        action,
        signal
      );
    const save = (next: Publication) => {
      recording.assertHealthy();
      operation = recording.coding((store) => store.publicationResult(jobId, next, principal));
    };
    const base = await observe("base", () => github.base(proposal, signal));
    if (base !== proposal.baseCommit) throw new Error("coding_base_moved");
    const branch = await observe("branch", () => github.branch(proposal, signal));
    if (branch && (!reconcile || branch !== operation.commitSha))
      throw new Error("coding_branch_conflict");
    if (!operation.commitSha) {
      const commitSha = await observe("commit", () => github.commit(proposal, signal));
      save({ ...operation, commitSha });
    }
    const commitSha = operation.commitSha!;
    if (!branch) {
      if ((await observe("base", () => github.base(proposal, signal))) !== proposal.baseCommit)
        throw new Error("coding_base_moved");
      await observe("create_branch", () => github.createBranch(proposal, commitSha, signal));
    }
    // Never treat an ambiguous response as absence or silently rebase an approved snapshot.
    if ((await observe("base", () => github.base(proposal, signal))) !== proposal.baseCommit)
      throw new Error("coding_base_moved_partial_branch");
    if ((await observe("branch", () => github.branch(proposal, signal))) !== commitSha)
      throw new Error("coding_branch_conflict");
    const existing = await observe("find_pull", () => github.findPull(proposal, commitSha, signal));
    const prUrl =
      existing ??
      (await observe("create_pull", () => github.createPull(proposal, commitSha, signal)));
    save({ ...operation, status: "published", prUrl, reason: undefined });
    recording.updateRun({
      metadata: { jobId, proposalId: proposal.id, status: "published", prUrl }
    });
    recording.finishRun({ status: "completed" });
    logger.info(
      {
        interaction_id: recording.interactionId,
        run_id: recording.runId,
        job_id: jobId,
        status: "published"
      },
      "coding.publication_completed"
    );
    return operation;
  } catch (error) {
    recording.assertHealthy();
    const reason =
      error instanceof Error && /^coding_[a-z_]+$/.test(error.message)
        ? error.message
        : "coding_publication_stopped";
    if (operation) {
      // Preserve a claimed operation on every failure; explicit recovery observes remote state first.
      operation = recording.coding((store) =>
        store.publicationResult(
          jobId,
          { ...operation!, status: "publication-uncertain", reason },
          principal
        )
      );
    }
    recording.finishRun({ status: "failed", error: reason });
    logger.warn(
      {
        interaction_id: recording.interactionId,
        run_id: recording.runId,
        job_id: jobId,
        error_type: "PublicationStopped",
        status: operation?.status
      },
      "coding.publication_stopped"
    );
    throw error instanceof Error && error.message.startsWith("coding_")
      ? error
      : new Error("coding_publication_stopped");
  } finally {
    recording.close();
  }
}
