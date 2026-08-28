import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";

import { defineRegisteredTool } from "../src/tools/registry.js";
import { runChatAgentWorkflow } from "../src/workflows/chat-agent.js";
import type { ChatMessage } from "../src/surfaces/chat/types.js";

const mockAgentState = vi.hoisted(() => ({
  toolNames: [] as string[],
  prompts: [] as string[]
}));

vi.mock("@earendil-works/pi-agent-core", () => {
  interface MockTextContent {
    type: "text";
    text: string;
  }

  interface MockToolResult {
    content: MockTextContent[];
    details: unknown;
    terminate?: boolean;
  }

  interface MockTool {
    name: string;
    execute: (
      toolCallId: string,
      params: Record<string, string>,
      signal?: AbortSignal
    ) => Promise<MockToolResult>;
  }

  interface MockAgentOptions {
    initialState: {
      tools: MockTool[];
    };
  }

  type MockAgentEvent = Record<string, unknown>;
  type MockAgentListener = (event: MockAgentEvent) => void;

  return {
    Agent: class MockAgent {
      private listener?: MockAgentListener;

      constructor(private readonly options: MockAgentOptions) {
        mockAgentState.toolNames = options.initialState.tools.map((tool) => tool.name);
      }

      subscribe(listener: MockAgentListener) {
        this.listener = listener;
        return () => undefined;
      }

      async prompt(input: string) {
        mockAgentState.prompts.push(input);
        const tool = this.options.initialState.tools[0];
        if (!tool) throw new Error("No mock tool configured.");
        this.listener?.({ type: "turn_start" });
        this.listener?.({
          type: "tool_execution_start",
          toolCallId: "tool-call-1",
          toolName: tool.name,
          args: { value: "demo" }
        });
        const result = await tool.execute("tool-call-1", { value: "demo" });
        this.listener?.({
          type: "tool_execution_end",
          toolCallId: "tool-call-1",
          toolName: tool.name,
          result,
          isError: false
        });
        this.listener?.({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: `Synthesized ${result.content[0]?.text}` }]
            }
          ]
        });
      }

      abort() {
        return undefined;
      }
    }
  };
});

vi.mock("../src/harness/model.js", () => ({
  createMinimaxHarnessModel: () => ({
    modelProvider: "minimax",
    modelRuntime: "pi-ai",
    name: "MiniMax-M3",
    model: {},
    models: {
      streamSimple: () => undefined
    }
  })
}));

describe("chat agent workflow", () => {
  it("uses the model branch to execute available Pi tools and synthesize the result", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = "test-key";
    mockAgentState.toolNames = [];
    mockAgentState.prompts = [];
    const toolCalls: unknown[] = [];
    const tool = defineRegisteredTool({
      pluginName: "demo",
      name: "echo",
      label: "Echo",
      description: "Echo a value.",
      parameters: Type.Object({ value: Type.String() }),
      allowedSurfaces: ["discord"],
      execute(params, context) {
        toolCalls.push({ params, context });
        return {
          result: { echoed: params.value },
          text: `tool:${params.value}`,
          terminate: false
        };
      }
    });

    try {
      const response = await runChatAgentWorkflow(chatMessage("please use the echo tool"), {
        availableTools: [tool]
      });

      expect(mockAgentState.toolNames).toEqual(["demo_echo"]);
      expect(toolCalls).toHaveLength(1);
      expect(response).toMatchObject({
        kind: "message",
        status: "completed",
        text: "Synthesized tool:demo"
      });
    } finally {
      if (originalKey) {
        process.env.MINIMAX_API_KEY = originalKey;
      } else {
        delete process.env.MINIMAX_API_KEY;
      }
    }
  });

  it("routes deferred plugin tools through searchTools and executeTool", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = "test-key";
    mockAgentState.toolNames = [];
    mockAgentState.prompts = [];
    const tool = defineRegisteredTool({
      pluginName: "readiness",
      name: "run_sweep",
      label: "Run Sweep",
      description: "Run a readiness sweep.",
      parameters: Type.Object({ repo_path: Type.Optional(Type.String()) }),
      source: {
        id: "readiness",
        label: "Readiness"
      },
      exposure: "deferred",
      readOnly: true,
      allowedSurfaces: ["discord"],
      execute() {
        return {
          result: { ok: true },
          text: "sweep complete"
        };
      }
    });

    try {
      const response = await runChatAgentWorkflow(
        chatMessage("what readiness tools are available?"),
        {
          availableTools: [tool],
          enabledPluginSources: ["readiness"]
        }
      );

      expect(mockAgentState.toolNames).toEqual(["searchTools", "executeTool"]);
      expect(response.kind).toBe("message");
    } finally {
      if (originalKey) {
        process.env.MINIMAX_API_KEY = originalKey;
      } else {
        delete process.env.MINIMAX_API_KEY;
      }
    }
  });
});

function chatMessage(text: string): ChatMessage {
  return {
    platform: "discord",
    channelId: "channel-1",
    messageId: "message-1",
    userId: "user-1",
    text
  };
}
