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

  it("summarizes common context in pretty log messages", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      format: "pretty",
      stream: { write: (message) => lines.push(message) }
    });

    logger.info(
      {
        workflow_name: "readiness_sweep",
        run_id: 123,
        status: "completed",
        token_count: 456,
        report_path: "/tmp/reports/report.md"
      },
      "readiness_sweep.started"
    );

    const output = lines.join("");

    expect(output).toContain("INFO");
    expect(output).toContain(
      "readiness_sweep.started run=123 status=completed tokens=456 report=report.md"
    );
    expect(output).not.toContain('workflow_name: "readiness_sweep"');
    expect(output).not.toContain("run_id: 123");
    expect(output).not.toContain('status: "completed"');
    expect(output).not.toContain("token_count: 456");
    expect(output).not.toContain('report_path: "/tmp/reports/report.md"');
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
