import { Type } from "typebox";
import type { Static } from "typebox";

import { CodingProfileSchema } from "../../workspaces/execution.js";
import type { CodingProfile } from "../../workspaces/execution.js";
import { parseCoding, CodingTaskSchema } from "./schemas.js";

export const CodingPolicySchema = Type.Object(
  {
    enabled: Type.Boolean(),
    publicationEnabled: Type.Boolean(),
    principals: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 }),
    profiles: Type.Record(CodingTaskSchema.properties.repository, CodingProfileSchema),
    model: Type.String({ minLength: 1, maxLength: 128 }),
    timeoutMs: Type.Integer({ minimum: 1000, maximum: 1200000 }),
    maxModelCalls: Type.Integer({ minimum: 1, maximum: 30 }),
    maxTokens: Type.Integer({ minimum: 1024, maximum: 100000 }),
    retentionMs: Type.Optional(Type.Integer({ minimum: 60000, maximum: 86400000 })),
    readToken: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    writeToken: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 }))
  },
  { additionalProperties: false }
);
export type CodingPolicy = Static<typeof CodingPolicySchema>;

export function loadCodingPolicy(env = process.env): CodingPolicy {
  if (env.CODING_ENABLED !== undefined && !["true", "false"].includes(env.CODING_ENABLED))
    throw new Error("coding_config_invalid");
  if (
    env.CODING_PUBLICATION_ENABLED !== undefined &&
    !["true", "false"].includes(env.CODING_PUBLICATION_ENABLED)
  )
    throw new Error("coding_config_invalid");
  try {
    const principals: unknown = JSON.parse(env.CODING_ALLOWED_PRINCIPALS ?? "[]");
    const profiles: unknown = JSON.parse(env.CODING_PROFILES ?? "{}");
    return parseCoding(CodingPolicySchema, {
      enabled: env.CODING_ENABLED === "true",
      publicationEnabled: env.CODING_PUBLICATION_ENABLED === "true",
      principals,
      profiles,
      model: env.CODING_MODEL ?? "MiniMax-M3",
      timeoutMs: Number(env.CODING_TIMEOUT_MS ?? 1200000),
      maxModelCalls: Number(env.CODING_MAX_MODEL_CALLS ?? 30),
      maxTokens: Number(env.CODING_MAX_TOKENS ?? 100000),
      retentionMs: Number(env.CODING_PROPOSAL_RETENTION_MS ?? 86400000),
      ...(env.CODING_GITHUB_READ_TOKEN ? { readToken: env.CODING_GITHUB_READ_TOKEN } : {}),
      ...(env.CODING_GITHUB_WRITE_TOKEN ? { writeToken: env.CODING_GITHUB_WRITE_TOKEN } : {})
    });
  } catch {
    throw new Error("coding_config_invalid");
  }
}

export function codingProfile(
  policy: CodingPolicy,
  principal: string,
  repository: string
): CodingProfile {
  parseCoding(CodingPolicySchema, policy);
  if (!policy.enabled || !policy.principals.includes(principal))
    throw new Error("coding_permission_denied");
  const key = Object.keys(policy.profiles).find(
    (key) => key.toLowerCase() === repository.toLowerCase()
  );
  const profile = key ? policy.profiles[key] : undefined;
  if (!profile || profile.principal !== principal) throw new Error("coding_target_denied");
  return profile;
}
