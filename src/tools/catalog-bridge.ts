import { Type, type Static } from "typebox";

import { describeTool, summarizeToolSources, type ToolSourceSummary } from "./catalog.js";
import {
  defineRegisteredTool,
  registeredToolName,
  type RegisteredTool,
  type RegisteredToolContext,
  type ToolSurface
} from "./registry.js";

const CATALOG_PLUGIN_NAME = "catalog";

const SearchToolsParams = Type.Object({
  query: Type.Optional(
    Type.String({ description: "Natural-language capability or tool search query." })
  ),
  source: Type.Optional(Type.String({ description: "Optional plugin source id to restrict to." })),
  max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 8 }))
});

const ToolSourceSummarySchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  description: Type.Optional(Type.String()),
  toolCount: Type.Number()
});

const ToolDescriptionSchema = Type.Object({
  name: Type.String(),
  source: Type.String(),
  label: Type.String(),
  description: Type.String(),
  parameters: Type.Unknown(),
  exposure: Type.Union([Type.Literal("direct"), Type.Literal("deferred"), Type.Literal("hidden")]),
  read_only: Type.Boolean(),
  requires_approval: Type.Boolean(),
  allowed_surfaces: Type.Array(Type.String())
});

const SearchToolsResult = Type.Object({
  sources: Type.Array(ToolSourceSummarySchema),
  tools: Type.Array(ToolDescriptionSchema)
});

const ExecuteToolParams = Type.Object({
  tool_name: Type.String({ description: "Exact tool name returned by searchTools." }),
  arguments: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "JSON object arguments for the selected tool."
    })
  )
});

const ExecuteToolResult = Type.Unknown({
  description: "The selected tool result. The selected tool validates its own result schema."
});

type SearchToolsParamsType = Static<typeof SearchToolsParams>;
type ExecuteToolParamsType = Static<typeof ExecuteToolParams>;

export function createCatalogBridgeTools(
  tools: RegisteredTool[],
  surface: ToolSurface
): RegisteredTool[] {
  return [createSearchToolsTool(tools, surface), createExecuteToolTool(tools, surface)];
}

function createSearchToolsTool(tools: RegisteredTool[], surface: ToolSurface): RegisteredTool {
  return defineRegisteredTool({
    pluginName: CATALOG_PLUGIN_NAME,
    name: "search_tools",
    modelName: "searchTools",
    label: "Search Tools",
    description:
      "Search available plugin tools by source, name, label, and description before choosing a tool to execute.",
    parameters: SearchToolsParams,
    resultSchema: SearchToolsResult,
    source: {
      id: "tool-catalog",
      label: "Tool Catalog",
      description: "Generic bridge for discovering enabled plugin tools."
    },
    exposure: "direct",
    readOnly: true,
    allowedSurfaces: [surface],
    execute(params: SearchToolsParamsType) {
      const maxResults = params.max_results ?? 8;
      const matches = searchCatalogTools(tools, params.query, params.source).slice(0, maxResults);
      const result = {
        sources: summarizeToolSources(matches),
        tools: matches.map((tool) => describeTool(tool))
      };
      return {
        result,
        text: renderSearchToolsText(result)
      };
    }
  });
}

function createExecuteToolTool(tools: RegisteredTool[], surface: ToolSurface): RegisteredTool {
  const toolsByName = new Map(tools.map((tool) => [registeredToolName(tool), tool]));
  return defineRegisteredTool({
    pluginName: CATALOG_PLUGIN_NAME,
    name: "execute_tool",
    modelName: "executeTool",
    label: "Execute Tool",
    description:
      "Execute one exact tool name returned by searchTools. Use only after selecting the intended plugin tool.",
    parameters: ExecuteToolParams,
    resultSchema: ExecuteToolResult,
    source: {
      id: "tool-catalog",
      label: "Tool Catalog",
      description: "Generic bridge for executing enabled plugin tools."
    },
    exposure: "direct",
    readOnly: false,
    allowedSurfaces: [surface],
    async execute(
      params: ExecuteToolParamsType,
      context: RegisteredToolContext,
      signal?: AbortSignal
    ) {
      const tool = toolsByName.get(params.tool_name);
      if (!tool) throw new Error(`Tool is not available: ${params.tool_name}`);
      return tool.execute(params.arguments ?? {}, context, signal);
    }
  });
}

function searchCatalogTools(
  tools: RegisteredTool[],
  query: string | undefined,
  source: string | undefined
): RegisteredTool[] {
  const normalizedQuery = query?.trim().toLowerCase();
  const normalizedSource = source?.trim().toLowerCase();
  return tools
    .filter((tool) => {
      if (!normalizedSource) return true;
      return (tool.source?.id ?? tool.pluginName).toLowerCase() === normalizedSource;
    })
    .map((tool) => ({
      tool,
      score: normalizedQuery ? scoreTool(tool, normalizedQuery) : 1
    }))
    .filter((match) => !normalizedQuery || match.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return registeredToolName(left.tool).localeCompare(registeredToolName(right.tool));
    })
    .map((match) => match.tool);
}

function scoreTool(tool: RegisteredTool, query: string): number {
  const haystacks = [
    registeredToolName(tool),
    tool.source?.id,
    tool.label,
    tool.description
  ].flatMap((value) => (value ? [value.toLowerCase()] : []));
  const terms = query.split(/\s+/).filter(Boolean);
  return terms.reduce(
    (score, term) => score + haystacks.filter((haystack) => haystack.includes(term)).length,
    0
  );
}

function renderSearchToolsText(result: {
  sources: ToolSourceSummary[];
  tools: ReturnType<typeof describeTool>[];
}): string {
  return JSON.stringify(result, null, 2);
}
