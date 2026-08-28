import type { WorkflowProgressEvent, WorkflowResult } from "../../harness/types.js";
import type { RegisteredTool } from "../../tools/registry.js";

export type ChatPlatform = "discord" | "slack";
export type ChatWorkflowName = "readiness_sweep";

export interface ChatMessage {
  platform: ChatPlatform;
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

export interface ChatHandlerOptions extends ChatRouterOptions {
  availableTools?: RegisteredTool[];
  enabledPluginSources?: Iterable<string>;
  onProgress?: (event: WorkflowProgressEvent) => void;
}

export type ChatResponse =
  | {
      kind: "message";
      status: "accepted" | "completed" | "failed" | "skipped";
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
