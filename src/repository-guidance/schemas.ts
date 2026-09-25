import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const closed = { additionalProperties: false } as const;

const RepositoryGuidanceSourceKindSchema = Type.Union([
  Type.Literal("agents"),
  Type.Literal("claude"),
  Type.Literal("cursor"),
  Type.Literal("copilot"),
  Type.Literal("standard")
]);

const RepositoryGuidanceScopeSchema = Type.Union([
  Type.Object({ kind: Type.Literal("repository") }, closed),
  Type.Object({ kind: Type.Literal("subtree"), root: Type.String({ minLength: 1 }) }, closed),
  Type.Object(
    {
      kind: Type.Literal("path-glob"),
      patterns: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })
    },
    closed
  ),
  Type.Object({ kind: Type.Literal("unknown") }, closed)
]);

export const RepositoryGuidanceSourceSchema = Type.Object(
  {
    kind: RepositoryGuidanceSourceKindSchema,
    path: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String({ minLength: 1 })),
    scope: RepositoryGuidanceScopeSchema,
    languages: Type.Array(Type.String()),
    tools: Type.Array(Type.String()),
    excerpt: Type.String(),
    truncated: Type.Boolean(),
    untrusted: Type.Literal(true),
    warnings: Type.Array(Type.String())
  },
  closed
);

export const RepositoryGuidanceCoverageSchema = Type.Object(
  {
    capability: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal("observed"), Type.Literal("missing")]),
    expected: Type.Boolean(),
    paths: Type.Array(Type.String())
  },
  closed
);

export const RepositoryGuidanceInventorySchema = Type.Object(
  {
    version: Type.Literal(1),
    source_count: Type.Integer({ minimum: 0 }),
    sources: Type.Array(RepositoryGuidanceSourceSchema),
    coverage: Type.Array(RepositoryGuidanceCoverageSchema),
    warnings: Type.Array(Type.String()),
    truncated: Type.Boolean(),
    redacted_occurrences: Type.Integer({ minimum: 0 })
  },
  closed
);

export type RepositoryGuidanceSource = Static<typeof RepositoryGuidanceSourceSchema>;
export type RepositoryGuidanceCoverage = Static<typeof RepositoryGuidanceCoverageSchema>;
export type RepositoryGuidanceInventory = Static<typeof RepositoryGuidanceInventorySchema>;

export function parseRepositoryGuidanceInventory(value: unknown): RepositoryGuidanceInventory {
  if (!Value.Check(RepositoryGuidanceInventorySchema, value)) {
    throw new Error("invalid_repository_guidance");
  }
  return value;
}
