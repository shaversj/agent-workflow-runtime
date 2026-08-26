import { describe, expect, it } from "vitest";

import { createLogger } from "../src/logger.js";

describe("logger", () => {
  it("redacts secret-shaped fields", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      stream: { write: (message) => lines.push(message) }
    });

    logger.info(
      {
        api_key: "top-secret",
        headers: { authorization: "Bearer token-value" },
        args: { token: "tool-token" },
        safe: "visible"
      },
      "logging.redaction_test"
    );

    const output = lines.join("");

    expect(output).toContain("[REDACTED]");
    expect(output).toContain("visible");
    expect(output).not.toContain("top-secret");
    expect(output).not.toContain("Bearer token-value");
    expect(output).not.toContain("tool-token");
  });

  it("supports pretty log output without dropping structured context", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      format: "pretty",
      stream: { write: (message) => lines.push(message) }
    });

    logger.info({ workflow_name: "readiness_sweep", run_id: 123 }, "readiness_sweep.started");

    const output = lines.join("");

    expect(output).toContain("info");
    expect(output).toContain("readiness_sweep.started");
    expect(output).toContain('workflow_name="readiness_sweep"');
    expect(output).toContain("run_id=123");
  });

  it("preserves error type context for failure logs", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "error",
      stream: { write: (message) => lines.push(message) }
    });
    const error = new Error("boom");

    logger.error(
      {
        err: error,
        error_type: error.name,
        workflow_name: "readiness_sweep"
      },
      "readiness_sweep.failed"
    );

    const record = JSON.parse(lines.join("")) as Record<string, unknown>;

    expect(record.error_type).toBe("Error");
    expect(record.workflow_name).toBe("readiness_sweep");
    expect(record.err).toMatchObject({ message: "boom" });
  });
});
