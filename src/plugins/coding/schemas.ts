import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

const id = Type.String({ pattern: "^[a-zA-Z0-9-]{1,128}$" });
const sha = Type.String({ pattern: "^[a-f0-9]{40}$" });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const principal = Type.String({ minLength: 1, maxLength: 128 });
const repo = Type.String({
  pattern: "^[A-Za-z0-9][A-Za-z0-9-]{0,38}/(?!\\.{1,2}$)[A-Za-z0-9_.-]{1,100}$"
});
const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
export const CodingTaskSchema = Type.Object(
  {
    repository: repo,
    baseBranch: Type.String({ minLength: 1, maxLength: 128 }),
    task: Type.String({ minLength: 1, maxLength: 8000 })
  },
  { additionalProperties: false }
);
const CodingStatusSchema = Type.Union([
  Type.Literal("preparing"),
  Type.Literal("proposal-ready"),
  Type.Literal("blocked"),
  Type.Literal("publishing"),
  Type.Literal("published"),
  Type.Literal("rejected"),
  Type.Literal("expired"),
  Type.Literal("failed"),
  Type.Literal("interrupted"),
  Type.Literal("publication-uncertain")
]);
export const CodingJobSchema = Type.Object(
  {
    id,
    principal,
    repository: repo,
    baseBranch: Type.String({ minLength: 1 }),
    baseCommit: sha,
    runId: Type.Integer({ minimum: 1 }),
    status: CodingStatusSchema,
    createdAt: timestamp,
    expiresAt: timestamp,
    proposalId: Type.Optional(id),
    cancelRequested: Type.Optional(Type.Boolean()),
    reason: Type.Optional(Type.String({ maxLength: 2048 })),
    conversationKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 }))
  },
  { additionalProperties: false }
);
export const SourceFileSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 512 }),
    content: Type.String(),
    mode: Type.Union([Type.Literal("100644"), Type.Literal("100755")])
  },
  { additionalProperties: false }
);
export const VerificationSchema = Type.Object(
  {
    command: Type.String({ minLength: 1, maxLength: 2048 }),
    exitCode: Type.Integer(),
    output: Type.String({ maxLength: 65536 }),
    truncated: Type.Boolean()
  },
  { additionalProperties: false }
);
export const CodingProposalSchema = Type.Object(
  {
    id,
    jobId: id,
    digest,
    repository: repo,
    baseBranch: Type.String(),
    baseCommit: sha,
    files: Type.Array(SourceFileSchema),
    deleted: Type.Array(Type.String()),
    checks: Type.Array(VerificationSchema, { minItems: 1 }),
    summary: Type.String({ maxLength: 8000 }),
    task: Type.String({ minLength: 1, maxLength: 8000 }),
    branch: Type.String({ pattern: "^agent-ops/[a-zA-Z0-9-]+$" }),
    title: Type.String({ minLength: 1, maxLength: 256 }),
    body: Type.String({ maxLength: 8000 }),
    createdAt: timestamp
  },
  { additionalProperties: false }
);
export const CodingApprovalSchema = Type.Object(
  {
    id,
    jobId: id,
    proposalId: id,
    digest,
    principal,
    runId: Type.Integer({ minimum: 1 }),
    expiresAt: timestamp,
    consumed: Type.Boolean()
  },
  { additionalProperties: false }
);
export const PublicationSchema = Type.Object(
  {
    id,
    jobId: id,
    proposalId: id,
    digest,
    runId: Type.Integer({ minimum: 1 }),
    activeRunId: Type.Optional(Type.Integer({ minimum: 1 })),
    status: Type.Union([
      Type.Literal("publishing"),
      Type.Literal("published"),
      Type.Literal("publication-uncertain"),
      Type.Literal("failed")
    ]),
    commitSha: Type.Optional(sha),
    prUrl: Type.Optional(Type.String({ pattern: "^https://github.com/" })),
    reason: Type.Optional(Type.String({ maxLength: 2048 }))
  },
  { additionalProperties: false }
);
export type CodingTask = Static<typeof CodingTaskSchema>;
export type CodingJob = Static<typeof CodingJobSchema>;
export type SourceFile = Static<typeof SourceFileSchema>;
export type CodingProposal = Static<typeof CodingProposalSchema>;
export type CodingApproval = Static<typeof CodingApprovalSchema>;
export type Publication = Static<typeof PublicationSchema>;
export function parseCoding<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) throw new Error("invalid_coding_contract");
  return value;
}
