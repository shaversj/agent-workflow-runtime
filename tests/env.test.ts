import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadLocalEnv } from "../src/env.js";

describe("env loading", () => {
  it("loads variables from a local .env file", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
    const key = "AGENT_OPS_KIT_TEST_ENV_FILE_LOADED";
    delete process.env[key];
    fs.writeFileSync(path.join(repoPath, ".env"), `${key}=yes\n`);

    try {
      loadLocalEnv(repoPath);
      expect(process.env[key]).toBe("yes");
    } finally {
      delete process.env[key];
    }
  });
});
