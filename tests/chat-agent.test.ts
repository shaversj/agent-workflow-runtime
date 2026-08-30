import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";

import { defineRegisteredTool } from "../src/tools/registry.js";
import { runChatAgentWorkflow } from "../src/workflows/chat-agent.js";
import type { ChatMessage } from "../src/surfaces/chat/types.js";
import { normalizedTargetRef, parseTargetRef, targetStatePath } from "../src/workspaces/index.js";

const mockAgentState = vi.hoisted(() => ({
  toolNames: [] as string[],
  prompts: [] as string[],
  stopDecisions: [] as boolean[]
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
    shouldStopAfterTurn?: (state: { toolResults: MockToolResult[] }) => boolean;
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
        const shouldStop = this.options.shouldStopAfterTurn?.({ toolResults: [result] }) ?? false;
        mockAgentState.stopDecisions.push(shouldStop);
        if (shouldStop) {
          this.listener?.({ type: "agent_end", messages: [] });
          return;
        }
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
    mockAgentState.stopDecisions = [];
    const toolCalls: unknown[] = [];
    const tool = defineRegisteredTool({
      pluginName: "demo",
      name: "echo",
      label: "Echo",
      description: "Echo a value.",
      parameters: Type.Object({ value: Type.String() }),
      resultSchema: Type.Object({ echoed: Type.String() }),
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
      resultSchema: Type.Object({ ok: Type.Boolean() }),
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

  it("renders valid workflow details as a readiness workflow summary", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = "test-key";
    mockAgentState.toolNames = [];
    mockAgentState.prompts = [];
    mockAgentState.stopDecisions = [];
    const workflowResult = workflowDetails();
    const tool = defineRegisteredTool({
      pluginName: "readiness",
      name: "run_sweep",
      label: "Run Sweep",
      description: "Run a readiness sweep.",
      parameters: Type.Object({ value: Type.String() }),
      resultSchema: Type.Unknown(),
      allowedSurfaces: ["discord"],
      execute() {
        return {
          result: workflowResult,
          text: "workflow complete",
          terminate: true
        };
      }
    });

    try {
      const response = await runChatAgentWorkflow(chatMessage("sweep this repo"), {
        availableTools: [tool]
      });

      expect(response).toMatchObject({
        kind: "message",
        status: "completed",
        result: workflowResult
      });
      expect(response.text).toContain("Readiness sweep completed for /tmp/demo.");
      expect(response.text).toContain("Run: 42");
      expect(response.text).toContain("Tokens: 30");
      expect(mockAgentState.stopDecisions).toEqual([true]);
    } finally {
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("treats incomplete workflow-like details as ordinary tool output", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = "test-key";
    mockAgentState.toolNames = [];
    mockAgentState.prompts = [];
    mockAgentState.stopDecisions = [];
    const incompleteWorkflowDetails = {
      ...workflowDetails(),
      usage: undefined
    };
    const tool = defineRegisteredTool({
      pluginName: "demo",
      name: "incomplete",
      label: "Incomplete",
      description: "Return incomplete workflow-like details.",
      parameters: Type.Object({ value: Type.String() }),
      resultSchema: Type.Unknown(),
      allowedSurfaces: ["discord"],
      execute() {
        return {
          result: incompleteWorkflowDetails,
          text: "ordinary output",
          terminate: false
        };
      }
    });

    try {
      const response = await runChatAgentWorkflow(chatMessage("inspect this"), {
        availableTools: [tool]
      });

      expect(response).toMatchObject({
        kind: "message",
        status: "completed",
        text: "Synthesized ordinary output"
      });
      expect("result" in response).toBe(false);
      expect(mockAgentState.stopDecisions).toEqual([false]);
    } finally {
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("treats workflow-like details with an invalid status as ordinary tool output", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = "test-key";
    mockAgentState.toolNames = [];
    mockAgentState.prompts = [];
    mockAgentState.stopDecisions = [];
    const invalidWorkflowDetails = {
      ...workflowDetails(),
      status: "done"
    };
    const tool = defineRegisteredTool({
      pluginName: "demo",
      name: "invalid_status",
      label: "Invalid Status",
      description: "Return workflow-like details with an invalid status.",
      parameters: Type.Object({ value: Type.String() }),
      resultSchema: Type.Unknown(),
      allowedSurfaces: ["discord"],
      execute() {
        return {
          result: invalidWorkflowDetails,
          text: "ordinary output",
          terminate: false
        };
      }
    });

    try {
      const response = await runChatAgentWorkflow(chatMessage("inspect this"), {
        availableTools: [tool]
      });

      expect(response).toMatchObject({
        kind: "message",
        status: "completed",
        text: "Synthesized ordinary output"
      });
      expect("result" in response).toBe(false);
      expect(mockAgentState.stopDecisions).toEqual([false]);
    } finally {
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("handles report lookup deterministically even when MiniMax credentials are configured", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.MINIMAX_API_KEY = "test-key";
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    mockAgentState.toolNames = [];
    mockAgentState.prompts = [];
    const repoPath = gitRepo();
    const reportPath = writeManagedReport(repoPath, "latest.md", "# Latest Report\n");

    try {
      const response = await runChatAgentWorkflow(
        chatMessage("where is the latest readiness report?"),
        {
          defaultRepoPath: repoPath
        }
      );

      expect(mockAgentState.toolNames).toEqual([]);
      expect(mockAgentState.prompts).toEqual([]);
      expect(response.kind).toBe("message");
      expect(response.text).toContain(reportPath);
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
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

function workflowDetails() {
  return {
    target: {
      source: "local-git",
      origin: "/tmp/demo",
      ref: "HEAD",
      commitSha: "abc123"
    },
    repoPath: "/tmp/demo-workspace",
    runId: 42,
    reportPath: "/tmp/demo/.agent-readiness/reports/latest.md",
    status: "completed",
    provider: "agent-ops-kit",
    model: "MiniMax-M3",
    usage: {
      requests: 1,
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30
    },
    toolCalls: [
      {
        name: "collect_readiness_evidence",
        args: {},
        isError: false,
        result: {}
      }
    ]
  };
}

function gitRepo() {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
  git(["init"], repoPath);
  git(["config", "user.email", "test@example.com"], repoPath);
  git(["config", "user.name", "Test User"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Demo\n");
  git(["add", "README.md"], repoPath);
  git(["commit", "-m", "Initial commit"], repoPath);
  return repoPath;
}

function writeManagedReport(repoPath: string, name: string, content: string): string {
  const reportDir = path.join(
    targetStatePath(normalizedTargetRef(parseTargetRef(repoPath))),
    "reports"
  );
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, name);
  fs.writeFileSync(reportPath, content);
  return reportPath;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
