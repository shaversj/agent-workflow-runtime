import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type { RegisteredTool, ToolSource } from "../tools/registry.js";

const ToolSurfaceSchema = Type.Union([
  Type.Literal("cli"),
  Type.Literal("discord"),
  Type.Literal("slack")
]);

const ToolExposureSchema = Type.Union([
  Type.Literal("direct"),
  Type.Literal("deferred"),
  Type.Literal("hidden")
]);

const AccessLevelSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("read-only"),
  Type.Literal("read-write")
]);

const NetworkAccessSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("model-provider"),
  Type.Literal("open")
]);

const PluginAuthoritySchema = Type.Object(
  {
    target: AccessLevelSchema,
    managedState: AccessLevelSchema,
    network: NetworkAccessSchema
  },
  { additionalProperties: false }
);

const PluginToolDefaultsSchema = Type.Object(
  {
    exposure: Type.Optional(ToolExposureSchema),
    readOnly: Type.Optional(Type.Boolean()),
    requiresApproval: Type.Optional(Type.Boolean()),
    allowedSurfaces: Type.Optional(Type.Array(ToolSurfaceSchema, { minItems: 1 }))
  },
  { additionalProperties: false }
);

const PluginToolSummarySchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    exposure: Type.Optional(ToolExposureSchema),
    readOnly: Type.Optional(Type.Boolean()),
    requiresApproval: Type.Optional(Type.Boolean()),
    allowedSurfaces: Type.Optional(Type.Array(ToolSurfaceSchema, { minItems: 1 }))
  },
  { additionalProperties: false }
);

const PluginSourceSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String())
  },
  { additionalProperties: false }
);

export const AgentOpsPluginManifestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    displayName: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    capabilities: Type.Array(Type.String({ minLength: 1 })),
    authority: PluginAuthoritySchema,
    source: Type.Optional(PluginSourceSchema),
    toolDefaults: Type.Optional(PluginToolDefaultsSchema),
    tools: Type.Array(PluginToolSummarySchema)
  },
  { additionalProperties: false }
);

export type AgentOpsPluginManifest = Static<typeof AgentOpsPluginManifestSchema>;

interface AgentOpsPlugin {
  manifest: AgentOpsPluginManifest;
  tools: RegisteredTool[];
}

export class PluginManifestValidationError extends Error {
  constructor(pluginName: string, errors: string[]) {
    super(`Invalid plugin manifest for ${pluginName}: ${errors.join("; ")}`);
    this.name = "PluginManifestValidationError";
  }
}

export class PluginToolManifestError extends Error {
  constructor(pluginName: string, reason: string) {
    super(`Invalid plugin tools for ${pluginName}: ${reason}`);
    this.name = "PluginToolManifestError";
  }
}

export function definePluginManifest(manifest: unknown): AgentOpsPluginManifest {
  const pluginName = isRecord(manifest) && typeof manifest.name === "string" ? manifest.name : "?";
  if (Value.Check(AgentOpsPluginManifestSchema, manifest)) return manifest;
  throw new PluginManifestValidationError(pluginName, formatValueErrors(manifest));
}

export function definePlugin(options: {
  manifest: unknown;
  tools: RegisteredTool[];
}): AgentOpsPlugin {
  const manifest = definePluginManifest(options.manifest);
  validateToolManifestAlignment(manifest, options.tools);
  return {
    manifest,
    tools: options.tools.map((tool) => applyManifestDefaults(manifest, tool))
  };
}

function validateToolManifestAlignment(
  manifest: AgentOpsPluginManifest,
  tools: RegisteredTool[]
): void {
  const summaryNames = manifest.tools.map((tool) => tool.name);
  const duplicateSummary = firstDuplicate(summaryNames);
  if (duplicateSummary) {
    throw new PluginToolManifestError(
      manifest.name,
      `tool summary is duplicated: ${duplicateSummary}`
    );
  }

  const toolNames = tools.map((tool) => tool.name);
  const duplicateTool = firstDuplicate(toolNames);
  if (duplicateTool) {
    throw new PluginToolManifestError(
      manifest.name,
      `registered tool is duplicated: ${duplicateTool}`
    );
  }

  for (const tool of tools) {
    if (tool.pluginName !== manifest.name) {
      throw new PluginToolManifestError(
        manifest.name,
        `tool ${tool.name} belongs to plugin ${tool.pluginName}`
      );
    }
  }

  const summaryNameSet = new Set(summaryNames);
  const toolNameSet = new Set(toolNames);
  const summariesByName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  const missingSummaries = toolNames.filter((name) => !summaryNameSet.has(name));
  if (missingSummaries.length) {
    throw new PluginToolManifestError(
      manifest.name,
      `missing tool summaries: ${missingSummaries.join(", ")}`
    );
  }

  const missingTools = summaryNames.filter((name) => !toolNameSet.has(name));
  if (missingTools.length) {
    throw new PluginToolManifestError(
      manifest.name,
      `missing registered tools: ${missingTools.join(", ")}`
    );
  }

  const source = manifest.source ?? manifestSource(manifest);
  for (const tool of tools) {
    const summary = summariesByName.get(tool.name);
    if (!summary) continue;
    if (summary.label !== tool.label) {
      throw new PluginToolManifestError(
        manifest.name,
        `tool ${tool.name} label does not match manifest summary`
      );
    }
    if (summary.description !== tool.description) {
      throw new PluginToolManifestError(
        manifest.name,
        `tool ${tool.name} description does not match manifest summary`
      );
    }
    if (tool.source && !sameSource(tool.source, source)) {
      throw new PluginToolManifestError(
        manifest.name,
        `tool ${tool.name} source does not match manifest source`
      );
    }
  }
}

function applyManifestDefaults(
  manifest: AgentOpsPluginManifest,
  tool: RegisteredTool
): RegisteredTool {
  const summary = manifest.tools.find((candidate) => candidate.name === tool.name);
  const source = manifest.source ?? manifestSource(manifest);
  return {
    ...tool,
    source,
    exposure: tool.exposure ?? summary?.exposure ?? manifest.toolDefaults?.exposure,
    readOnly: tool.readOnly ?? summary?.readOnly ?? manifest.toolDefaults?.readOnly,
    requiresApproval:
      tool.requiresApproval ?? summary?.requiresApproval ?? manifest.toolDefaults?.requiresApproval,
    allowedSurfaces:
      tool.allowedSurfaces ?? summary?.allowedSurfaces ?? manifest.toolDefaults?.allowedSurfaces
  };
}

function sameSource(left: ToolSource, right: ToolSource): boolean {
  return (
    left.id === right.id && left.label === right.label && left.description === right.description
  );
}

function manifestSource(manifest: AgentOpsPluginManifest): ToolSource {
  return {
    id: manifest.name,
    label: manifest.displayName,
    description: manifest.description
  };
}

function firstDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function formatValueErrors(value: unknown): string[] {
  return [...Value.Errors(AgentOpsPluginManifestSchema, value)].slice(0, 5).map((error) => {
    const path = error.instancePath || "/";
    return `${path} ${error.message}`;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
