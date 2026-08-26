import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runSweepWorkflow } from "../src/workflows/sweep.js";

describe("sweep workflow", () => {
  it("records a skipped report when MiniMax credentials are missing", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
    fs.writeFileSync(path.join(repoPath, "README.md"), "# Demo\n");

    try {
      const result = await runSweepWorkflow(repoPath);

      expect(result.status).toBe("skipped");
      expect(fs.existsSync(result.reportPath)).toBe(true);
      expect(fs.readFileSync(result.reportPath, "utf8")).toContain("MINIMAX_API_KEY");
      expect(fs.existsSync(path.join(repoPath, ".agent-readiness", "agent-ops.db"))).toBe(true);
    } finally {
      if (originalKey) {
        process.env.MINIMAX_API_KEY = originalKey;
      } else {
        delete process.env.MINIMAX_API_KEY;
      }
    }
  });
});
