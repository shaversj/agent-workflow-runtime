import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";

import type { InteractionRecorder } from "../harness/interaction.js";
import { codingProfile } from "../plugins/coding/config.js";
import type { CodingPolicy } from "../plugins/coding/config.js";
import { parseCoding } from "../plugins/coding/schemas.js";
import { codingExecutionDirectory } from "../workspaces/storage.js";
import { proposalDisplay, cancelCodingJob } from "./code.js";

const DecisionSchema = Type.Object(
  {
    jobId: Type.String({ pattern: "^[a-zA-Z0-9-]{1,128}$" }),
    action: Type.Union([
      Type.Literal("show"),
      Type.Literal("reject"),
      Type.Literal("cancel"),
      Type.Literal("expire")
    ])
  },
  { additionalProperties: false }
);

export function inspectCoding(
  jobId: string,
  principal: string,
  policy: CodingPolicy,
  recording: InteractionRecorder,
  conversationKey?: string
) {
  parseCoding(DecisionSchema.properties.jobId, jobId);
  const job = recording.coding((store) => store.get(jobId, principal));
  if (!job) throw new Error("coding_job_not_found");
  codingProfile(policy, principal, job.repository);
  if (job.conversationKey && job.conversationKey !== conversationKey)
    throw new Error("coding_conversation_denied");
  const proposal =
    job.proposalId && job.status !== "expired"
      ? recording.coding((store) => store.proposal(jobId, principal))
      : undefined;
  const publication = recording.coding((store) => store.publication(jobId, principal));
  const execution = recording.coding((store) => store.execution(jobId, principal));
  const executionSummary = `Execution: ${execution.phase}; resumes=${execution.resumeCount}; deadline=${execution.deadlineAt}`;
  const display = proposalDisplay(job, proposal);
  return {
    job,
    execution,
    proposal,
    publication,
    display,
    executionSummary,
    inspection: `${executionSummary}\n\n${display}`
  };
}

export function codingDecision(
  input: unknown,
  principal: string,
  policy: CodingPolicy,
  recording: InteractionRecorder,
  conversationKey?: string
): string {
  const decision = parseCoding(DecisionSchema, input);
  const { job, proposal } = inspectCoding(
    decision.jobId,
    principal,
    policy,
    recording,
    conversationKey
  );
  if (decision.action === "show") return job.status;
  if (decision.action === "cancel") {
    recording.coding((store) => store.requestCancellation(job.id, principal));
    cancelCodingJob(job.id, principal);
    return "Cancellation requested";
  }
  if (decision.action === "expire" && Date.parse(job.expiresAt) > Date.now())
    throw new Error("coding_job_not_expired");
  if (decision.action === "expire")
    recording.coding((store) => store.assertExecutionRemovable(job.id, principal));
  const next =
    decision.action === "expire" && job.status === "expired"
      ? job
      : recording.coding((store) =>
          store.transition(job.id, decision.action === "reject" ? "rejected" : "expired", principal)
        );
  if (decision.action === "expire")
    recording.coding((store) => store.removePrivateProposal(job.id, principal));
  if (decision.action === "expire")
    fs.rmSync(
      path.join(
        recording.artifactsPath,
        `${proposal?.id ?? `proposal-${job.id}`}-coding-proposal.md`
      ),
      {
        force: true
      }
    );
  if (decision.action === "expire")
    fs.rmSync(
      codingExecutionDirectory(job.id, path.dirname(path.dirname(recording.artifactsPath))),
      { recursive: true, force: true }
    );
  return next.status;
}
