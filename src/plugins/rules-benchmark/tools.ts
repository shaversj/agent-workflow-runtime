import { Type, type Static } from "typebox";

import { defineRegisteredTool, type RegisteredTool } from "../../tools/registry.js";
import { definePlugin } from "../manifest.js";
import { RulesBenchmarkClient, type BenchmarkResponse } from "./client.js";
import { rulesBenchmarkPluginManifest } from "./manifest.js";
import {
  BenchmarkToolResultSchema,
  type BenchmarkToolResult,
  type OssRulesCatalog,
  type OssRulesPatternDetail,
  type OssRulesPatterns,
  type OssRulesProjectDetail,
  type OssRulesProjects,
  type OssRulesSkillDetail,
  type OssRulesSkills
} from "./schemas.js";

const ListCorpusParamsSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("catalog"),
      Type.Literal("patterns"),
      Type.Literal("projects"),
      Type.Literal("skills")
    ]),
    language: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    pattern_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" })),
    repository: Type.Optional(
      Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", maxLength: 256 })
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 }))
  },
  { additionalProperties: false }
);

const ReadCorpusEntryParamsSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("pattern"), Type.Literal("project"), Type.Literal("skill")]),
    id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" })),
    repository: Type.Optional(
      Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", maxLength: 256 })
    )
  },
  { additionalProperties: false }
);

type ListCorpusParams = Static<typeof ListCorpusParamsSchema>;
type ReadCorpusEntryParams = Static<typeof ReadCorpusEntryParamsSchema>;

export function createRulesBenchmarkTools(client = new RulesBenchmarkClient()): RegisteredTool[] {
  return definePlugin({
    manifest: rulesBenchmarkPluginManifest,
    tools: [
      defineRegisteredTool({
        pluginName: rulesBenchmarkPluginManifest.name,
        name: "list_corpus",
        label: "List OSS Rules Corpus",
        description: "List bounded metadata from the validated public ossrules corpus.",
        parameters: ListCorpusParamsSchema,
        resultSchema: BenchmarkToolResultSchema,
        async execute(params: ListCorpusParams) {
          switch (params.kind) {
            case "catalog":
              return toolResult("catalog", await client.catalog());
            case "patterns":
              return toolResult("patterns", await client.listPatterns());
            case "projects":
              return toolResult(
                "projects",
                await client.listProjects({
                  language: params.language,
                  pattern: params.pattern_id,
                  limit: params.limit
                })
              );
            case "skills":
              return toolResult(
                "skills",
                await client.listSkills({
                  repository: required(params.repository, "ossrules_repository_required"),
                  limit: params.limit
                })
              );
          }
        }
      }),
      defineRegisteredTool({
        pluginName: rulesBenchmarkPluginManifest.name,
        name: "read_corpus_entry",
        label: "Read OSS Rules Corpus Entry",
        description: "Read one bounded corpus entry previously returned during this sweep.",
        parameters: ReadCorpusEntryParamsSchema,
        resultSchema: BenchmarkToolResultSchema,
        async execute(params: ReadCorpusEntryParams) {
          switch (params.kind) {
            case "pattern":
              return toolResult(
                "pattern",
                await client.readPattern(required(params.id, "ossrules_identifier_required"))
              );
            case "project":
              return toolResult(
                "project",
                await client.readProject(
                  required(params.repository, "ossrules_repository_required")
                )
              );
            case "skill":
              return toolResult(
                "skill",
                await client.readSkill(
                  required(params.repository, "ossrules_repository_required"),
                  required(params.id, "ossrules_identifier_required")
                )
              );
          }
        }
      })
    ]
  }).tools;
}

export const rulesBenchmarkTools = createRulesBenchmarkTools();

interface BenchmarkDataByKind {
  catalog: OssRulesCatalog;
  patterns: OssRulesPatterns;
  projects: OssRulesProjects;
  skills: OssRulesSkills;
  pattern: OssRulesPatternDetail;
  project: OssRulesProjectDetail;
  skill: OssRulesSkillDetail;
}

function toolResult<TKind extends keyof BenchmarkDataByKind>(
  kind: TKind,
  response: BenchmarkResponse<BenchmarkDataByKind[TKind]>
) {
  const result = {
    kind,
    status: response.status,
    provenance: response.provenance,
    ...(response.data === undefined ? {} : { data: response.data }),
    ...(response.unavailable_reason ? { unavailable_reason: response.unavailable_reason } : {}),
    untrusted: true as const
  } as Extract<BenchmarkToolResult, { kind: TKind }>;
  return {
    result,
    text: `UNTRUSTED PUBLIC REFERENCE DATA\n${JSON.stringify(result, null, 2)}`
  };
}

function required(value: string | undefined, code: string): string {
  if (!value) throw new Error(code);
  return value;
}
