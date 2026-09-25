import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import type { InteractionRecorder, RecordedToolInput } from "../harness/interaction.js";
import { assertToolExecution } from "../harness/execution-policy.js";
import type { ExecutionAuthority } from "../harness/execution-policy.js";
import type { WorkflowProgressEvent } from "../harness/types.js";
import type { TargetRef } from "../workspaces/types.js";
import type { ToolAuthority } from "./authority.js";

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
  executionAuthority?: ExecutionAuthority;
  recording?: InteractionRecorder;
  providerCallId?: string;
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
  repositoryTarget?: TargetRef;
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
  recordingKind?: RecordedToolInput["kind"];
  source?: ToolSource;
  exposure?: ToolExposure;
  readOnly?: boolean;
  requiresApproval?: boolean;
  allowedSurfaces?: ToolSurface[];
  authority?: ToolAuthority;
  requiredCredentials?: string[];
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
  recordingKind?: RecordedToolInput["kind"];
  source?: ToolSource;
  exposure?: ToolExposure;
  readOnly?: boolean;
  requiresApproval?: boolean;
  allowedSurfaces?: ToolSurface[];
  authority?: ToolAuthority;
  requiredCredentials?: string[];
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
  const envelope = Type.Object({
    result: tool.resultSchema,
    text: Type.String(),
    terminate: Type.Optional(Type.Boolean())
  });
  return {
    ...tool,
    [registeredToolBrand]: true,
    execute(params, context, signal) {
      const { pluginName, name, requiresApproval, allowedSurfaces, requiredCredentials } = this;
      const effectiveTool = {
        pluginName,
        name,
        requiresApproval,
        allowedSurfaces,
        requiredCredentials
      };
      const execute = (toolContext: RegisteredToolContext, toolSignal?: AbortSignal) => {
        const parsed = validateToolParameters(tool, params);
        assertToolExecution(
          effectiveTool,
          toolContext.surface,
          parsed,
          toolContext.executionAuthority
        );
        const output = tool.execute(parsed, toolContext, toolSignal);
        if (isPromiseLike(output)) {
          return output.then((result) => validateToolResult(tool, envelope, result));
        }
        return validateToolResult(tool, envelope, output);
      };
      if (!context.recording) return execute(context, signal);
      return context.recording.recordTool(
        {
          name: registeredToolName(tool),
          source: toolSourceId(tool),
          kind: tool.recordingKind ?? "capability",
          providerCallId: context.providerCallId,
          input: params
        },
        (recording, combinedSignal) =>
          execute({ ...context, recording, providerCallId: undefined }, combinedSignal),
        signal
      );
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
  envelope: TSchema,
  output: RegisteredToolResult<Static<TResultSchema>>
): RegisteredToolResult<Static<TResultSchema>> {
  if (Value.Check(envelope, output)) return output;
  const errors = Value.Errors(envelope, output)
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
