import { isDeepStrictEqual } from "node:util";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import type { RegisteredTool, ToolSurface } from "../tools/registry.js";

const ExecutionRequestSchema = Type.Object(
  {
    principal: Type.String({ minLength: 1, maxLength: 128 }),
    allowedPrincipals: Type.Array(Type.String()),
    allowedRepositories: Type.Array(Type.String()),
    repository: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }),
    surface: Type.Union([Type.Literal("cli"), Type.Literal("discord"), Type.Literal("slack")]),
    toolName: Type.String({ minLength: 1 }),
    parameters: Type.Unknown(),
    credentialCapabilities: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })
    )
  },
  { additionalProperties: false }
);

export interface ExecutionAuthority {
  readonly principal: string;
}
const authorities = new WeakMap<
  ExecutionAuthority,
  {
    toolName: string;
    surface: ToolSurface;
    parameters: unknown;
    repository: string;
    credentialCapabilities: string[];
    expiresAt: number;
  }
>();

// Only trusted surface/application code calls this; model parameters cannot carry a grant.
export function authorizeExecution(
  input: Static<typeof ExecutionRequestSchema>
): ExecutionAuthority {
  if (
    !Value.Check(ExecutionRequestSchema, input) ||
    !input.allowedPrincipals.includes(input.principal) ||
    !input.allowedRepositories.some((repo) => repo.toLowerCase() === input.repository.toLowerCase())
  )
    throw new Error("execution_authorization_denied");
  const authority = Object.freeze({ principal: input.principal });
  authorities.set(authority, {
    toolName: input.toolName,
    surface: input.surface,
    parameters: structuredClone(input.parameters),
    repository: input.repository,
    credentialCapabilities: [...(input.credentialCapabilities ?? [])],
    expiresAt: Date.now() + 120_000
  });
  return authority;
}

export function assertToolExecution(
  tool: Pick<
    RegisteredTool,
    "pluginName" | "name" | "requiresApproval" | "allowedSurfaces" | "requiredCredentials"
  >,
  surface: ToolSurface,
  parameters: unknown,
  authority?: ExecutionAuthority
): void {
  if (tool.allowedSurfaces && !tool.allowedSurfaces.includes(surface))
    throw new Error("tool_surface_denied");
  if (!tool.requiresApproval && !tool.requiredCredentials?.length) return;
  const grant = authority && authorities.get(authority);
  if (
    !grant ||
    grant.surface !== surface ||
    grant.toolName !== `${tool.pluginName}.${tool.name}` ||
    grant.expiresAt < Date.now() ||
    !isDeepStrictEqual(grant.parameters, parameters)
  )
    throw new Error("execution_authorization_denied");
  if (
    tool.requiredCredentials?.some(
      (requirement) => !grant.credentialCapabilities.includes(requirement)
    )
  )
    throw new Error("tool_credential_capability_denied");
}

export function assertExecutionRepository(authority: ExecutionAuthority, repository: string): void {
  const grant = authorities.get(authority);
  if (!grant || grant.repository.toLowerCase() !== repository.toLowerCase())
    throw new Error("execution_repository_denied");
}
