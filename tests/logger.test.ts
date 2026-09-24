import { describe, expect, it } from "vitest";

import { projectExternalError } from "../src/harness/external-error.js";
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
        interaction_id: "interaction-123",
        status: "completed",
        benchmark_status: "stale",
        duration_ms: 42,
        cache_age_ms: 86_400_000,
        token_count: 456,
        report_path: "/tmp/reports/report.md"
      },
      "readiness_sweep.started"
    );

    const output = lines.join("");

    expect(output).toContain("INFO");
    expect(output).toContain(
      "readiness_sweep.started run=123 interaction=interaction-123 status=completed benchmark=stale tokens=456 duration=42ms cache_age=86400000ms report=report.md"
    );
    expect(output).not.toContain('workflow_name: "readiness_sweep"');
    expect(output).not.toContain("run_id: 123");
    expect(output).not.toContain('interaction_id: "interaction-123"');
    expect(output).not.toContain('status: "completed"');
    expect(output).not.toContain('benchmark_status: "stale"');
    expect(output).not.toContain("duration_ms: 42");
    expect(output).not.toContain("token_count: 456");
    expect(output).not.toContain('report_path: "/tmp/reports/report.md"');
  });

  it("logs projected external failures without inspecting hostile throwables", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "error",
      stream: { write: (message) => lines.push(message) }
    });
    const hostile = new Proxy(Object.create(null) as object, {
      get() {
        throw new Error("hostile getter was inspected");
      },
      getOwnPropertyDescriptor() {
        throw new Error("hostile descriptor was inspected");
      },
      ownKeys() {
        throw new Error("hostile keys were inspected");
      }
    });
    const failure = projectExternalError("model_provider_failed", {
      correlationId: "33333333-3333-4333-8333-333333333333",
      interactionId: "interaction-123"
    });

    logger.error(
      {
        ...failure,
        err: hostile,
        workflow_name: "readiness_sweep"
      },
      "readiness_sweep.failed"
    );

    const record = JSON.parse(lines.join("")) as Record<string, unknown>;

    expect(record.error_category).toBe("model_provider_failed");
    expect(record.correlation_id).toBe("33333333-3333-4333-8333-333333333333");
    expect(record.workflow_name).toBe("readiness_sweep");
    expect(record.err).toBe("[UNPROJECTED_ERROR_OMITTED]");
    expect(lines.join("")).not.toContain("hostile");
  });
});
