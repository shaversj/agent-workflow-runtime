import { Type } from "typebox";
import type { Static } from "typebox";

import type { WorkflowTargetSummarySchema, WorkspaceSummarySchema } from "./schemas.js";

const closedObject = { additionalProperties: false } as const;
const targetRef = Type.Optional(
  Type.String({ minLength: 1, maxLength: 1024, pattern: "^(?!-)[^\\u0000-\\u001f\\u007f]+$" })
);

const CliTargetProvenanceSchema = Type.Object({ source: Type.Literal("cli") }, closedObject);

const DiscordExplicitTargetProvenanceSchema = Type.Object(
  {
    source: Type.Literal("discord-explicit"),
    exactHost: Type.String({ minLength: 1, maxLength: 253 })
  },
  closedObject
);

const OperatorDefaultTargetProvenanceSchema = Type.Object(
  {
    source: Type.Literal("operator-default"),
    localPathCapability: Type.Literal("operator-default")
  },
  closedObject
);

export const TargetProvenanceSchema = Type.Union([
  CliTargetProvenanceSchema,
  DiscordExplicitTargetProvenanceSchema,
  OperatorDefaultTargetProvenanceSchema
]);

export const TargetTransportPolicySchema = Type.Object(
  {
    protocol: Type.Union([Type.Literal("local"), Type.Literal("https")]),
    exactHost: Type.Union([Type.String({ minLength: 1, maxLength: 253 }), Type.Null()]),
    allowRedirects: Type.Literal(false),
    allowSecondaryFetches: Type.Literal(false),
    localPathCapability: Type.Union([
      Type.Literal("none"),
      Type.Literal("direct-cli"),
      Type.Literal("operator-default")
    ])
  },
  closedObject
);

export const TargetRefSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("local-git"),
      path: Type.String({ minLength: 1, maxLength: 4096 }),
      ref: targetRef,
      provenance: TargetProvenanceSchema,
      policy: TargetTransportPolicySchema
    },
    closedObject
  ),
  Type.Object(
    {
      kind: Type.Literal("git-url"),
      url: Type.String({ minLength: 1, maxLength: 4096 }),
      ref: targetRef,
      provenance: TargetProvenanceSchema,
      policy: TargetTransportPolicySchema
    },
    closedObject
  )
]);

export type TargetProvenance = Static<typeof TargetProvenanceSchema>;
export type TargetTransportPolicy = Static<typeof TargetTransportPolicySchema>;
export type TargetRef = Static<typeof TargetRefSchema>;

export type WorkspaceSource = Static<typeof WorkflowTargetSummarySchema>["source"];

export interface WorkspaceLease {
  id: string;
  target: TargetRef;
  source: WorkspaceSource;
  origin: string;
  displayOrigin: string;
  ref: string;
  commitSha: string;
  path: string;
  cleanupPolicy: "delete";
  cleanup: () => Promise<void>;
}

export type WorkspaceSummary = Static<typeof WorkspaceSummarySchema>;
export type WorkflowTargetSummary = Static<typeof WorkflowTargetSummarySchema>;
