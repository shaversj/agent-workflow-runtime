import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import type { WorkflowProgressEvent } from "../harness/types.js";

const registeredToolBrand: unique symbol = Symbol("agentOpsRegisteredTool");

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
  explicitRepoTarget?: string;
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

export interface RegisteredTool<
  TParameters extends TSchema = TSchema,
  TResult = unknown,
  TResultSchema extends TSchema = TSchema
> {
  readonly [registeredToolBrand]: true;
  pluginName: string;
  name: string;
  modelName?: string;
  label: string;
  description: string;
  parameters: TParameters;
  resultSchema: TResultSchema;
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

interface TypedRegisteredTool<TParameters extends TSchema, TResultSchema extends TSchema> {
  pluginName: string;
  name: string;
  modelName?: string;
  label: string;
  description: string;
  parameters: TParameters;
  resultSchema: TResultSchema;
  source?: ToolSource;
  exposure?: ToolExposure;
  readOnly?: boolean;
  requiresApproval?: boolean;
  allowedSurfaces?: ToolSurface[];
  execute: (
    params: Static<TParameters>,
    context: RegisteredToolContext,
    signal?: AbortSignal
  ) =>
    | Promise<RegisteredToolResult<Static<TResultSchema>>>
    | RegisteredToolResult<Static<TResultSchema>>;
}

export function defineRegisteredTool<TParameters extends TSchema, TResultSchema extends TSchema>(
  tool: TypedRegisteredTool<TParameters, TResultSchema>
): RegisteredTool<TParameters, Static<TResultSchema>, TResultSchema> {
  return {
    ...tool,
    [registeredToolBrand]: true,
    execute(params, context, signal) {
      const output = tool.execute(validateToolParameters(tool, params), context, signal);
      if (isPromiseLike(output)) {
        return output.then((result) => validateToolResult(tool, result));
      }
      return validateToolResult(tool, output);
    }
  };
}

export class UnvalidatedToolError extends Error {
  constructor(toolName: string) {
    super(`Tool must be created with defineRegisteredTool: ${toolName}`);
    this.name = "UnvalidatedToolError";
  }
}

function assertRegisteredTool(tool: RegisteredTool): void {
  if (tool[registeredToolBrand] !== true) {
    throw new UnvalidatedToolError(registeredToolName(tool));
  }
}

export class ToolParameterValidationError extends Error {
  constructor(toolName: string, errors: string[]) {
    super(`Invalid parameters for ${toolName}: ${errors.join("; ")}`);
    this.name = "ToolParameterValidationError";
  }
}

export class ToolResultValidationError extends Error {
  constructor(toolName: string, errors: string[]) {
    super(`Invalid result for ${toolName}: ${errors.join("; ")}`);
    this.name = "ToolResultValidationError";
  }
}

function validateToolParameters<TParameters extends TSchema, TResultSchema extends TSchema>(
  tool: TypedRegisteredTool<TParameters, TResultSchema>,
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

function validateToolResult<TParameters extends TSchema, TResultSchema extends TSchema>(
  tool: TypedRegisteredTool<TParameters, TResultSchema>,
  output: RegisteredToolResult<Static<TResultSchema>>
): RegisteredToolResult<Static<TResultSchema>> {
  if (Value.Check(tool.resultSchema, output.result)) return output;
  const errors = Value.Errors(tool.resultSchema, output.result)
    .slice(0, 5)
    .map((error) => {
      const path = error.instancePath || "/";
      return `${path} ${error.message}`;
    });
  throw new ToolResultValidationError(registeredToolName(tool), errors);
}

function isPromiseLike<T>(value: Promise<T> | T): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
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
    assertRegisteredTool(tool);
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
