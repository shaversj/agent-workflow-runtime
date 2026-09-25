import { Type, type Static, type TSchema } from "typebox";

const closed = { additionalProperties: false } as const;
const ApiVersionSchema = Type.Literal(1);
const ShortTextSchema = Type.String({ maxLength: 4_096 });
const OssRulesApiUrlSchema = Type.String({
  pattern: "^https://ossrules\\.md/api/v1(?:/|\\?|$)",
  maxLength: 2_048
});
const OssRulesSiteUrlSchema = Type.String({
  pattern: "^https://ossrules\\.md(?:/|$)",
  maxLength: 2_048
});
const GitHubSourceUrlSchema = Type.String({
  pattern: "^https://github\\.com/",
  maxLength: 2_048
});
const TimestampSchema = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$",
  maxLength: 64
});
const IdentifierSchema = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" });
const RepositorySchema = Type.String({
  pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
  maxLength: 256
});

export const BenchmarkStatusSchema = Type.Union([
  Type.Literal("live"),
  Type.Literal("revalidated"),
  Type.Literal("stale"),
  Type.Literal("unavailable")
]);

export const BenchmarkProvenanceSchema = Type.Object(
  {
    api_version: ApiVersionSchema,
    endpoint: Type.String({ minLength: 1, maxLength: 1_024 }),
    fetched_at: TimestampSchema,
    etag: Type.Optional(Type.String({ maxLength: 512 })),
    cache_age_ms: Type.Optional(Type.Integer({ minimum: 0 }))
  },
  closed
);

export const OssRulesCatalogSchema = Type.Object(
  {
    version: ApiVersionSchema,
    scope: ShortTextSchema,
    totals: Type.Object(
      {
        projects: Type.Integer({ minimum: 0 }),
        skills: Type.Integer({ minimum: 0 }),
        patterns: Type.Integer({ minimum: 0 })
      },
      closed
    ),
    languages: Type.Array(
      Type.Object(
        {
          value: Type.String({ minLength: 1, maxLength: 128 }),
          count: Type.Integer({ minimum: 0 })
        },
        closed
      ),
      { maxItems: 256 }
    ),
    links: Type.Object(
      {
        projects: OssRulesApiUrlSchema,
        skills: OssRulesApiUrlSchema,
        patterns: OssRulesApiUrlSchema
      },
      closed
    ),
    queries: Type.Object(
      {
        projects: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 }),
        skills: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 }),
        defaults: Type.Object(
          {
            limit: Type.Integer({ minimum: 1, maximum: 50 }),
            offset: Type.Integer({ minimum: 0 })
          },
          closed
        ),
        maxLimit: Type.Integer({ minimum: 1, maximum: 50 }),
        matching: ShortTextSchema,
        pagination: ShortTextSchema
      },
      closed
    )
  },
  closed
);

const OssRulesPatternSummarySchema = Type.Object(
  {
    id: IdentifierSchema,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    summary: ShortTextSchema,
    projectCount: Type.Integer({ minimum: 0 }),
    apiUrl: OssRulesApiUrlSchema,
    projectsUrl: OssRulesApiUrlSchema
  },
  closed
);

export const OssRulesPatternsSchema = Type.Object(
  {
    version: ApiVersionSchema,
    total: Type.Integer({ minimum: 0 }),
    items: Type.Array(OssRulesPatternSummarySchema, { maxItems: 50 })
  },
  closed
);

const OssRulesProjectSummarySchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 256 }),
    repository: RepositorySchema,
    language: Type.String({ minLength: 1, maxLength: 128 }),
    summaryPreview: ShortTextSchema,
    patterns: Type.Array(IdentifierSchema, { maxItems: 64 }),
    skillCount: Type.Integer({ minimum: 0 }),
    apiUrl: OssRulesApiUrlSchema
  },
  closed
);

export const OssRulesProjectsSchema = paginatedSchema(OssRulesProjectSummarySchema);

const OssRulesSkillSummarySchema = Type.Object(
  {
    id: IdentifierSchema,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    repository: RepositorySchema,
    descriptionPreview: ShortTextSchema,
    complete: Type.Boolean(),
    apiUrl: OssRulesApiUrlSchema
  },
  closed
);

export const OssRulesSkillsSchema = paginatedSchema(OssRulesSkillSummarySchema);

const SourceExcerptSchema = Type.Object(
  {
    text: Type.String({ maxLength: 2_000 }),
    startLine: Type.Integer({ minimum: 1 })
  },
  closed
);

const PatternExampleSchema = Type.Object(
  {
    projectApiUrl: OssRulesApiUrlSchema,
    technique: Type.Object(
      {
        title: Type.String({ maxLength: 512 }),
        body: Type.String({ maxLength: 2_000 }),
        quote: Type.String({ maxLength: 2_000 }),
        pattern: IdentifierSchema
      },
      closed
    ),
    excerpt: SourceExcerptSchema,
    path: Type.String({ minLength: 1, maxLength: 1_024 }),
    endLine: Type.Integer({ minimum: 1 }),
    sha: Type.String({ minLength: 7, maxLength: 128 }),
    sourceUrl: GitHubSourceUrlSchema
  },
  closed
);

export const OssRulesPatternDetailSchema = Type.Object(
  {
    version: ApiVersionSchema,
    id: IdentifierSchema,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    summary: ShortTextSchema,
    detail: Type.String({ maxLength: 8_000 }),
    url: OssRulesSiteUrlSchema,
    projectsUrl: OssRulesApiUrlSchema,
    application: Type.String({ maxLength: 4_096 }),
    moves: Type.Array(Type.String({ maxLength: 2_000 }), { maxItems: 32 }),
    examples: Type.Array(PatternExampleSchema, { maxItems: 12 })
  },
  closed
);

export const OssRulesProjectDetailSchema = Type.Object(
  {
    version: ApiVersionSchema,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    repository: RepositorySchema,
    language: Type.String({ minLength: 1, maxLength: 128 }),
    summaryPreview: ShortTextSchema,
    patterns: Type.Array(IdentifierSchema, { maxItems: 64 }),
    skillCount: Type.Integer({ minimum: 0 }),
    apiUrl: OssRulesApiUrlSchema,
    url: OssRulesSiteUrlSchema,
    summary: Type.String({ maxLength: 8_000 }),
    instructions: Type.Object(
      {
        evaluatedAt: Type.String({ maxLength: 128 }),
        primaryPath: Type.String({ maxLength: 1_024 }),
        sha: Type.String({ minLength: 7, maxLength: 128 })
      },
      closed
    ),
    skillDiscovery: Type.Object(
      {
        excludedCount: Type.Integer({ minimum: 0 }),
        invalidCount: Type.Integer({ minimum: 0 }),
        scannedAt: Type.String({ maxLength: 128 }),
        scope: Type.String({ maxLength: 1_024 }),
        sha: Type.String({ minLength: 7, maxLength: 128 })
      },
      closed
    ),
    links: Type.Object(
      {
        analysis: OssRulesApiUrlSchema,
        instructions: OssRulesApiUrlSchema,
        skillDiscovery: OssRulesApiUrlSchema,
        skills: OssRulesApiUrlSchema
      },
      closed
    )
  },
  closed
);

export const OssRulesSkillDetailSchema = Type.Object(
  {
    version: ApiVersionSchema,
    repository: RepositorySchema,
    sha: Type.String({ minLength: 7, maxLength: 128 }),
    scannedAt: Type.String({ maxLength: 128 }),
    repositoryLicense: Type.Union([
      Type.Object(
        {
          path: Type.String({ maxLength: 1_024 }),
          blob: Type.String({ minLength: 7, maxLength: 128 }),
          bytes: Type.Integer({ minimum: 0 }),
          text: Type.Boolean(),
          mode: Type.String({ maxLength: 16 })
        },
        closed
      ),
      Type.Null()
    ]),
    id: IdentifierSchema,
    path: Type.String({ minLength: 1, maxLength: 1_024 }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    description: Type.String({ maxLength: 8_000 }),
    files: Type.Array(
      Type.Object(
        {
          path: Type.String({ maxLength: 1_024 }),
          blob: Type.String({ minLength: 7, maxLength: 128 }),
          bytes: Type.Integer({ minimum: 0 }),
          text: Type.Boolean(),
          mode: Type.String({ maxLength: 16 }),
          sourceUrl: GitHubSourceUrlSchema,
          rawUrl: OssRulesSiteUrlSchema
        },
        closed
      ),
      { maxItems: 128 }
    ),
    contributions: Type.Object(
      {
        contributors: Type.Array(
          Type.Object(
            {
              id: Type.Integer({ minimum: 1 }),
              login: Type.String({ minLength: 1, maxLength: 256 }),
              commits: Type.Integer({ minimum: 0 })
            },
            closed
          ),
          { maxItems: 128 }
        ),
        unlinkedAuthors: Type.Integer({ minimum: 0 })
      },
      closed
    ),
    url: OssRulesSiteUrlSchema,
    sourceUrl: GitHubSourceUrlSchema,
    complete: Type.Boolean(),
    downloadUrl: Type.Optional(OssRulesSiteUrlSchema)
  },
  closed
);

export const BenchmarkCacheEnvelopeSchema = Type.Object(
  {
    version: Type.Literal(1),
    endpoint: Type.String({ minLength: 1, maxLength: 1_024 }),
    api_version: ApiVersionSchema,
    fetched_at: TimestampSchema,
    etag: Type.Optional(Type.String({ maxLength: 512 })),
    payload: Type.Unknown()
  },
  closed
);

export const BenchmarkToolResultSchema = Type.Union([
  benchmarkToolResultSchema("catalog", OssRulesCatalogSchema),
  benchmarkToolResultSchema("patterns", OssRulesPatternsSchema),
  benchmarkToolResultSchema("projects", OssRulesProjectsSchema),
  benchmarkToolResultSchema("skills", OssRulesSkillsSchema),
  benchmarkToolResultSchema("pattern", OssRulesPatternDetailSchema),
  benchmarkToolResultSchema("project", OssRulesProjectDetailSchema),
  benchmarkToolResultSchema("skill", OssRulesSkillDetailSchema)
]);

function paginatedSchema<T extends TSchema>(item: T) {
  return Type.Object(
    {
      version: ApiVersionSchema,
      total: Type.Integer({ minimum: 0 }),
      limit: Type.Integer({ minimum: 1, maximum: 50 }),
      offset: Type.Integer({ minimum: 0 }),
      nextUrl: Type.Union([OssRulesApiUrlSchema, Type.Null()]),
      previousUrl: Type.Union([OssRulesApiUrlSchema, Type.Null()]),
      items: Type.Array(item, { maxItems: 50 })
    },
    closed
  );
}

function benchmarkToolResultSchema<TKind extends string, TData extends TSchema>(
  kind: TKind,
  data: TData
) {
  return Type.Object(
    {
      status: BenchmarkStatusSchema,
      kind: Type.Literal(kind),
      provenance: BenchmarkProvenanceSchema,
      data: Type.Optional(data),
      unavailable_reason: Type.Optional(Type.String({ maxLength: 256 })),
      untrusted: Type.Literal(true)
    },
    closed
  );
}

export type BenchmarkStatus = Static<typeof BenchmarkStatusSchema>;
export type BenchmarkProvenance = Static<typeof BenchmarkProvenanceSchema>;
export type BenchmarkCacheEnvelope = Static<typeof BenchmarkCacheEnvelopeSchema>;
export type BenchmarkToolResult = Static<typeof BenchmarkToolResultSchema>;
export type OssRulesCatalog = Static<typeof OssRulesCatalogSchema>;
export type OssRulesPatterns = Static<typeof OssRulesPatternsSchema>;
export type OssRulesProjects = Static<typeof OssRulesProjectsSchema>;
export type OssRulesSkills = Static<typeof OssRulesSkillsSchema>;
export type OssRulesPatternDetail = Static<typeof OssRulesPatternDetailSchema>;
export type OssRulesProjectDetail = Static<typeof OssRulesProjectDetailSchema>;
export type OssRulesSkillDetail = Static<typeof OssRulesSkillDetailSchema>;
