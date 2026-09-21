import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";

import type { InteractionRecorder } from "../harness/interaction.js";
import { codingProfile } from "../plugins/coding/config.js";
import type { CodingPolicy } from "../plugins/coding/config.js";
import { parseCoding } from "../plugins/coding/schemas.js";
import { DockerWorker } from "../workspaces/docker.js";
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
  return { job, proposal, publication, display: proposalDisplay(job, proposal) };
}

export function codingDecision(
  input: unknown,
  principal: string,
  policy: CodingPolicy,
  recording: InteractionRecorder,
  conversationKey?: string
): string {
  const decision = parseCoding(DecisionSchema, input);
  const { job } = inspectCoding(decision.jobId, principal, policy, recording, conversationKey);
  if (decision.action === "show") return job.status;
  if (decision.action === "cancel") {
    recording.coding((store) => store.requestCancellation(job.id, principal));
    cancelCodingJob(job.id, principal);
    return "Cancellation requested";
  }
  if (decision.action === "expire" && Date.parse(job.expiresAt) > Date.now())
    throw new Error("coding_job_not_expired");
  const next =
    decision.action === "expire" && job.status === "expired"
      ? job
      : recording.coding((store) =>
          store.transition(job.id, decision.action === "reject" ? "rejected" : "expired", principal)
        );
  if (decision.action === "expire")
    recording.coding((store) => store.removePrivateProposal(job.id, principal));
  if (decision.action === "expire")
    fs.rmSync(path.join(recording.artifactsPath, `${job.runId}-coding-proposal.md`), {
      force: true
    });
  return next.status;
}

export async function recoverCoding(
  jobId: string,
  principal: string,
  policy: CodingPolicy,
  recording: InteractionRecorder,
  conversationKey?: string
): Promise<string> {
  const details = inspectCoding(jobId, principal, policy, recording, conversationKey);
  recording.coding((store) => store.recover(details.job.id, principal));
  await recording.recordTool(
    {
      name: "coding.cleanup_workers",
      source: "coding",
      kind: "capability",
      input: { jobId: details.job.id }
    },
    () => DockerWorker.cleanupJob(details.job.id)
  );
  return "Stopped coding job recovered; owned workers removed. Work was not replayed.";
}
