import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { codingBudget, isolatedCodingTools } from "../src/harness/coding-runtime.js";
import { beginInteraction } from "../src/harness/interaction.js";
import type { DockerWorker } from "../src/workspaces/docker.js";

describe("isolated coding loop tools", () => {
  it("shows the cumulative candidate and runs only an indexed required check", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-tools-"));
    const recording = beginInteraction(
      { source: "cli", kind: "coding_tools_test", userMessage: "Inspect" },
      { home }
    );
    const baseline = [{ path: "app.js", content: "old\n", mode: "100644" as const }];
    const command = vi.fn((value: string) =>
      Promise.resolve({ command: value, exitCode: 0, output: "passed", truncated: false })
    );
    const worker = {
      profile: {
        image: `node@sha256:${"a".repeat(64)}`,
        requiredChecks: ["node --test"],
        ignore: [],
        principal: "cli:test"
      },
      snapshot: () => Promise.resolve([{ ...baseline[0]!, content: "new\n" }]),
      command,
      rpc: vi.fn()
    } as unknown as DockerWorker;
    const budget = codingBudget();
    const tools = isolatedCodingTools(
      worker,
      recording,
      recording.signal,
      undefined,
      baseline,
      budget
    );
    try {
      const diff = await tools
        .find((tool) => tool.name === "show_diff")!
        .execute("diff", {}, recording.signal, undefined, undefined as never);
      const diffBlock = diff.content[0];
      if (!diffBlock || diffBlock.type !== "text") throw new Error("expected text result");
      const diffEnvelope = JSON.parse(diffBlock.text) as {
        content: Array<{ text: string }>;
      };
      expect(JSON.parse(diffEnvelope.content[0]!.text)).toEqual({
        files: [{ path: "app.js", status: "modified", beforeBytes: 4, afterBytes: 4 }]
      });

      const checked = await tools
        .find((tool) => tool.name === "run_required_check")!
        .execute("check", { check: 0 }, recording.signal, undefined, undefined as never);
      const checkBlock = checked.content[0];
      if (!checkBlock || checkBlock.type !== "text") throw new Error("expected text result");
      const checkEnvelope = JSON.parse(checkBlock.text) as {
        content: Array<{ text: string }>;
      };
      expect(JSON.parse(checkEnvelope.content[0]!.text)).toMatchObject({
        command: "node --test",
        exitCode: 0
      });
      expect(command).toHaveBeenCalledExactlyOnceWith("node --test", recording.signal);
      expect(budget.toolCalls).toBe(2);
    } finally {
      recording.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
