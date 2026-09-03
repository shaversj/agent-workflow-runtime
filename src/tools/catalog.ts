import {
  registeredToolName,
  toolSourceId,
  ToolRegistry,
  type RegisteredTool,
  type ToolExposure,
  type ToolSurface
} from "./registry.js";

export interface ToolSourceSummary {
  id: string;
  label: string;
  description?: string;
  toolCount: number;
}

interface ToolCatalog {
  registry: ToolRegistry;
  tools: RegisteredTool[];
  directTools: RegisteredTool[];
  catalogTools: RegisteredTool[];
  hiddenTools: RegisteredTool[];
  sourceSummaries: ToolSourceSummary[];
}

interface ToolCatalogOptions {
  tools: RegisteredTool[];
  surface: ToolSurface;
  enabledSources?: Iterable<string>;
  includeApprovalRequired?: boolean;
}

export function createToolCatalog(options: ToolCatalogOptions): ToolCatalog {
  const enabledSources = options.enabledSources
    ? new Set([...options.enabledSources].filter(Boolean))
    : undefined;
  const surfaceTools = options.tools.filter((tool) =>
    isToolEnabledForSurface(tool, options.surface, enabledSources, options.includeApprovalRequired)
  );
  const directTools = surfaceTools.filter((tool) => toolExposure(tool) === "direct");
  const catalogTools = surfaceTools.filter((tool) => toolExposure(tool) === "deferred");
  const hiddenTools = surfaceTools.filter((tool) => toolExposure(tool) === "hidden");
  const registry = new ToolRegistry();
  registry.registerMany([...directTools, ...catalogTools]);

  return {
    registry,
    tools: surfaceTools,
    directTools,
    catalogTools,
    hiddenTools,
    sourceSummaries: summarizeToolSources([...directTools, ...catalogTools])
  };
}

function toolExposure(tool: RegisteredTool): ToolExposure {
  return tool.exposure ?? "direct";
}

export function summarizeToolSources(tools: RegisteredTool[]): ToolSourceSummary[] {
  const summaries = new Map<string, ToolSourceSummary>();
  for (const tool of tools) {
    const sourceId = toolSourceId(tool);
    const existing = summaries.get(sourceId);
    if (existing) {
      existing.toolCount += 1;
      continue;
    }
    summaries.set(sourceId, {
      id: sourceId,
      label: tool.source?.label ?? tool.pluginName,
      description: tool.source?.description,
      toolCount: 1
    });
  }
  return [...summaries.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function isToolEnabledForSurface(
  tool: RegisteredTool,
  surface: ToolSurface,
  enabledSources: Set<string> | undefined,
  includeApprovalRequired: boolean | undefined
): boolean {
  if (tool.allowedSurfaces && !tool.allowedSurfaces.includes(surface)) return false;
  if (enabledSources && !enabledSources.has(toolSourceId(tool))) return false;
  if (tool.requiresApproval && !includeApprovalRequired) return false;
  return true;
}

export function describeTool(tool: RegisteredTool) {
  return {
    name: registeredToolName(tool),
    source: toolSourceId(tool),
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    exposure: toolExposure(tool),
    read_only: tool.readOnly ?? false,
    requires_approval: tool.requiresApproval ?? false,
    allowed_surfaces: tool.allowedSurfaces ?? []
  };
}
