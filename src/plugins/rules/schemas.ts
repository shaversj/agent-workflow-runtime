import { Type, type Static } from "typebox";

const closed = { additionalProperties: false } as const;

const RuleSourceKindSchema = Type.Union([
  Type.Literal("agents"),
  Type.Literal("claude"),
  Type.Literal("cursor"),
  Type.Literal("copilot"),
  Type.Literal("standard")
]);

const RuleScopeSchema = Type.Union([
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

export const RuleSourceSchema = Type.Object(
  {
    kind: RuleSourceKindSchema,
    path: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String({ minLength: 1 })),
    scope: RuleScopeSchema,
    languages: Type.Array(Type.String()),
    tools: Type.Array(Type.String()),
    excerpt: Type.String(),
    truncated: Type.Boolean(),
    untrusted: Type.Literal(true),
    warnings: Type.Array(Type.String())
  },
  closed
);

export const RulesCoverageSchema = Type.Object(
  {
    capability: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal("observed"), Type.Literal("missing")]),
    expected: Type.Boolean(),
    paths: Type.Array(Type.String())
  },
  closed
);

export const RulesInventorySchema = Type.Object(
  {
    plugin: Type.Literal("rules"),
    source_count: Type.Integer({ minimum: 0 }),
    sources: Type.Array(RuleSourceSchema),
    coverage: Type.Array(RulesCoverageSchema),
    warnings: Type.Array(Type.String()),
    truncated: Type.Boolean(),
    redacted_occurrences: Type.Integer({ minimum: 0 })
  },
  closed
);

export const RuleSourceReadResultSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    content: Type.String(),
    truncated: Type.Boolean(),
    untrusted: Type.Literal(true),
    redacted_occurrences: Type.Integer({ minimum: 0 })
  },
  closed
);

export type RuleSource = Static<typeof RuleSourceSchema>;
export type RulesCoverage = Static<typeof RulesCoverageSchema>;
export type RulesInventory = Static<typeof RulesInventorySchema>;
export type RuleSourceReadResult = Static<typeof RuleSourceReadResultSchema>;
