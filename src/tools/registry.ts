import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import type { WorkflowProgressEvent } from "../harness/types.js";

export type ToolSurface = "cli" | "discord" | "slack";
export type ToolExposure = "direct" | "deferred" | "hidden";

export interface ToolSource {
  id: string;
  label: string;
  description?: string;
}

export interface ToolSourceContext {
  source: ToolSurface;
  guildId?: string;
  channelId?: string;
  threadId?: string;
  messageId?: string;
  userId?: string;
}

export interface RegisteredToolContext {
  surface: ToolSurface;
  requestContext?: ToolRequestContext;
  model?: string;
  timeoutMs?: number;
  sourceContext?: ToolSourceContext;
  onProgress?: (event: WorkflowProgressEvent) => void;
}

export interface ToolRequestContext {
  sourceText?: string;
  repoTarget?: string;
  ref?: string;
  reportPath?: string;
  model?: string;
  timeoutMs?: number;
}

export interface RegisteredToolResult<TResult> {
  result: TResult;
  text: string;
  terminate?: boolean;
}

export interface RegisteredTool<TParameters extends TSchema = TSchema, TResult = unknown> {
  pluginName: string;
  name: string;
  modelName?: string;
  label: string;
  description: string;
  parameters: TParameters;
  source?: ToolSource;
  exposure?: ToolExposure;
  readOnly?: boolean;
  requiresApproval?: boolean;
  allowedSurfaces?: ToolSurface[];
  execute: (
    params: unknown,
    context: RegisteredToolContext,
    signal?: AbortSignal
  ) => Promise<RegisteredToolResult<TResult>> | RegisteredToolResult<TResult>;
}

interface TypedRegisteredTool<TParameters extends TSchema, TResult> {
  pluginName: string;
  name: string;
  modelName?: string;
  label: string;
  description: string;
  parameters: TParameters;
  source?: ToolSource;
  exposure?: ToolExposure;
  readOnly?: boolean;
  requiresApproval?: boolean;
  allowedSurfaces?: ToolSurface[];
  execute: (
    params: Static<TParameters>,
    context: RegisteredToolContext,
    signal?: AbortSignal
  ) => Promise<RegisteredToolResult<TResult>> | RegisteredToolResult<TResult>;
}

export function defineRegisteredTool<TParameters extends TSchema, TResult>(
  tool: TypedRegisteredTool<TParameters, TResult>
): RegisteredTool<TParameters, TResult> {
  return {
    ...tool,
    execute(params, context, signal) {
      return tool.execute(validateToolParameters(tool, params), context, signal);
    }
  };
}

export class ToolParameterValidationError extends Error {
  constructor(toolName: string, errors: string[]) {
    super(`Invalid parameters for ${toolName}: ${errors.join("; ")}`);
    this.name = "ToolParameterValidationError";
  }
}

function validateToolParameters<TParameters extends TSchema, TResult>(
  tool: TypedRegisteredTool<TParameters, TResult>,
  params: unknown
): Static<TParameters> {
  if (Value.Check(tool.parameters, params)) return params;
  const errors = Value.Errors(tool.parameters, params)
    .slice(0, 5)
    .map((error) => {
      const path = error.instancePath || "/";
      return `${path} ${error.message}`;
    });
  throw new ToolParameterValidationError(registeredToolName(tool), errors);
}

interface ToolListOptions {
  surface?: ToolSurface;
  names?: string[];
  sources?: string[];
  includeHidden?: boolean;
  includeApprovalRequired?: boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    const key = registeredToolName(tool);
    if (this.tools.has(key)) throw new Error(`Tool already registered: ${key}`);
    this.tools.set(key, tool);
  }

  registerMany(tools: RegisteredTool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(options: ToolListOptions = {}): RegisteredTool[] {
    const requestedNames = options.names ? new Set(options.names) : undefined;
    const requestedSources = options.sources ? new Set(options.sources) : undefined;
    return [...this.tools.entries()]
      .filter(([name]) => !requestedNames || requestedNames.has(name))
      .map(([, tool]) => tool)
      .filter((tool) => !requestedSources || requestedSources.has(toolSourceId(tool)))
      .filter((tool) =>
        options.surface && tool.allowedSurfaces
          ? tool.allowedSurfaces.includes(options.surface)
          : true
      )
      .filter((tool) => options.includeHidden || tool.exposure !== "hidden")
      .filter((tool) => options.includeApprovalRequired || !tool.requiresApproval);
  }
}

export function registeredToolName(
  tool: Pick<RegisteredTool, "pluginName" | "name" | "modelName">
): string {
  return tool.modelName ?? `${tool.pluginName}_${tool.name}`;
}

export function toolSourceId(tool: Pick<RegisteredTool, "pluginName" | "source">): string {
  return tool.source?.id ?? tool.pluginName;
}
