import type { Static, TSchema } from "typebox";

import type { WorkflowProgressEvent } from "../harness/types.js";
import type { ChatPlatform } from "../surfaces/chat/types.js";

export type ToolSurface = "cli" | ChatPlatform;

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
  defaultRepoPath?: string;
  model?: string;
  timeoutMs?: number;
  sourceContext?: ToolSourceContext;
  onProgress?: (event: WorkflowProgressEvent) => void;
}

export interface RegisteredToolResult<TResult> {
  result: TResult;
  text: string;
  terminate?: boolean;
}

export interface RegisteredTool<TParameters extends TSchema = TSchema, TResult = unknown> {
  pluginName: string;
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
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
  label: string;
  description: string;
  parameters: TParameters;
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
      return tool.execute(params as Static<TParameters>, context, signal);
    }
  };
}

interface ToolListOptions {
  surface?: ToolSurface;
  names?: string[];
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
    return [...this.tools.entries()]
      .filter(([name]) => !requestedNames || requestedNames.has(name))
      .map(([, tool]) => tool)
      .filter((tool) =>
        options.surface && tool.allowedSurfaces
          ? tool.allowedSurfaces.includes(options.surface)
          : true
      );
  }
}

export function registeredToolName(tool: Pick<RegisteredTool, "pluginName" | "name">): string {
  return `${tool.pluginName}_${tool.name}`;
}
