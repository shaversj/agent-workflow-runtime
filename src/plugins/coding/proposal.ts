import crypto from "node:crypto";

import { Type } from "typebox";

import { redactApplicationText } from "../../harness/redaction.js";
import { CodingProposalSchema, SourceFileSchema, parseCoding } from "./schemas.js";
import type { CodingProposal, SourceFile } from "./schemas.js";

export function validateSource(files: SourceFile[]): void {
  parseCoding(Type.Array(SourceFileSchema, { maxItems: 10000 }), files);
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    if (
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.split("/").some((part) => !part || [".", "..", ".git"].includes(part)) ||
      paths.has(file.path) ||
      file.content.includes("\0")
    )
      throw new Error("coding_source_path_denied");
    paths.add(file.path);
    bytes += Buffer.byteLength(file.content);
    if (Buffer.byteLength(file.content) > 1024 * 1024 || bytes > 32 * 1024 * 1024)
      throw new Error("coding_source_limit");
  }
}

export function proposalDigest(proposal: CodingProposal): string {
  const bound = proposal;
  // Fixed schema fields in fixed order; file/check ordering is validated, not normalized after approval.
  const ordered = {
    id: bound.id,
    jobId: bound.jobId,
    repository: bound.repository,
    baseBranch: bound.baseBranch,
    baseCommit: bound.baseCommit,
    task: bound.task,
    files: bound.files.map(({ path, content, mode }) => ({ path, content, mode })),
    deleted: bound.deleted,
    checks: bound.checks.map(({ command, exitCode, output, truncated }) => ({
      command,
      exitCode,
      output,
      truncated
    })),
    summary: bound.summary,
    branch: bound.branch,
    title: bound.title,
    body: bound.body,
    createdAt: bound.createdAt
  };
  return crypto.createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

export function freezeProposal(
  input: Omit<
    CodingProposal,
    "digest" | "files" | "deleted" | "checks" | "branch" | "title" | "body"
  >,
  base: SourceFile[],
  final: SourceFile[],
  checks: CodingProposal["checks"]
): CodingProposal {
  validateSource(base);
  validateSource(final);
  const previous = new Map(base.map((file) => [file.path, file]));
  const current = new Map(final.map((file) => [file.path, file]));
  const files = final
    .filter((file) => {
      const old = previous.get(file.path);
      return !old || old.content !== file.content || old.mode !== file.mode;
    })
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  const deleted = base
    .filter((file) => !current.has(file.path))
    .map((file) => file.path)
    .sort();
  if (!files.length && !deleted.length) throw new Error("coding_no_changes");
  if (
    files.length + deleted.length > 200 ||
    files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 10 * 1024 * 1024
  )
    throw new Error("coding_change_limit");
  for (const file of files) {
    if (
      redactApplicationText(file.content) !== file.content ||
      redactApplicationText(file.path) !== file.path ||
      file.path
        .split("/")
        .some((name) =>
          /^\.env(?:\.|$)|^\.npmrc$|^credentials\.|^id_(rsa|ed25519)$|\.(pem|key|p12)$/i.test(name)
        )
    )
      throw new Error("coding_secret_gate_blocked");
  }
  const proposal = parseCoding(CodingProposalSchema, {
    ...input,
    task: redactApplicationText(input.task),
    summary: redactApplicationText(input.summary).slice(0, 8000),
    digest: "0".repeat(64),
    files,
    deleted,
    checks: checks.map((check) => ({ ...check, output: redactApplicationText(check.output) })),
    branch: `agent-ops/${input.jobId}`,
    title: `Agent Ops: ${redactApplicationText(input.task).split("\n")[0]!.slice(0, 220)}`,
    body: `Task: ${redactApplicationText(input.task)}\n\n${redactApplicationText(input.summary)}\n\nBase: ${input.baseCommit}\n\nPrepared offline. Required checks:\n${checks.map((check) => `- ${check.command}: exit ${check.exitCode}${check.truncated ? " (truncated)" : ""}`).join("\n")}`.slice(
      0,
      8000
    )
  });
  return { ...proposal, digest: proposalDigest(proposal) };
}

export function validateProposal(input: unknown, requiredChecks: string[]): CodingProposal {
  const proposal = parseCoding(CodingProposalSchema, input);
  validateSource(proposal.files);
  validateSource(proposal.deleted.map((path) => ({ path, content: "", mode: "100644" })));
  if (
    proposal.digest !== proposalDigest(proposal) ||
    proposal.branch !== `agent-ops/${proposal.jobId}` ||
    proposal.files.length + proposal.deleted.length > 200 ||
    proposal.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) >
      10 * 1024 * 1024 ||
    proposal.deleted.some((path) => proposal.files.some((file) => file.path === path)) ||
    proposal.checks.length !== requiredChecks.length ||
    proposal.checks.some(
      (check, index) =>
        check.command !== requiredChecks[index] || check.exitCode !== 0 || check.truncated
    )
  )
    throw new Error("coding_proposal_not_publishable");
  for (const file of proposal.files)
    if (redactApplicationText(file.content) !== file.content)
      throw new Error("coding_secret_gate_blocked");
  return proposal;
}
