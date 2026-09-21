import type { WorkflowProgressEvent, WorkflowResult } from "../../harness/types.js";
import type { InteractionRecorder } from "../../harness/interaction.js";
import type { RegisteredTool, ToolRequestContext, ToolSurface } from "../../tools/registry.js";
import type { TargetRef } from "../../workspaces/index.js";

export type ChatPlatform = Extract<ToolSurface, "discord" | "slack">;
export type ChatWorkflowName = "readiness_sweep";

export interface ChatMessage {
  platform: ChatPlatform;
  applicationId?: string;
  workspaceId?: string;
  channelId: string;
  threadId?: string;
  messageId: string;
  userId: string;
  text: string;
}

export type ChatIntent =
  | {
      kind: "run_workflow";
      workflow: ChatWorkflowName;
      repoPath: string;
      ref?: string;
      model?: string;
      timeoutMs?: number;
      sourceText: string;
    }
  | {
      kind: "clarify";
      question: string;
      sourceText: string;
    }
  | {
      kind: "unsupported";
      reason: string;
      sourceText: string;
    };

export interface ChatRouterOptions {
  defaultRepoPath?: string;
  defaultModel?: string;
  defaultTimeoutMs?: number;
}

export interface ChatRequestContext extends ToolRequestContext {
  sourceText: string;
  explicitRepoTarget?: string;
  repositoryTarget?: TargetRef;
}

export interface ChatHandlerOptions extends ChatRouterOptions {
  recording?: InteractionRecorder;
  signal?: AbortSignal;
  onResponseRecorded?: (messageId: number) => void;
  availableTools?: RegisteredTool[];
  enabledPluginSources?: Iterable<string>;
  onProgress?: (event: WorkflowProgressEvent) => void;
}

export type ChatResponse =
  | {
      kind: "message";
      status: "accepted" | "completed" | "failed" | "skipped" | "cancelled" | "interrupted";
      text: string;
      result?: WorkflowResult;
    }
  | {
      kind: "clarify";
      text: string;
    }
  | {
      kind: "ignored";
      text: string;
    };
