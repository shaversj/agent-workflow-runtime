import { describe, expect, it } from "vitest";

import { externalErrorMessage, projectExternalError } from "../src/harness/external-error.js";

describe("external error projection", () => {
  it("emits only allowlisted primitive context with an internal correlation id", () => {
    const failure = projectExternalError("github_request_failed", {
      correlationId: "11111111-1111-4111-8111-111111111111",
      statusCode: 502,
      redirectCount: 1
    });

    expect(failure).toEqual({
      error_category: "github_request_failed",
      correlation_id: "11111111-1111-4111-8111-111111111111",
      status_code: 502,
      redirect_count: 1
    });
    expect(Object.values(failure).every((value) => typeof value !== "object")).toBe(true);
  });

  it("renders a public message without exposing the internal category or metadata", () => {
    const failure = projectExternalError("model_provider_failed", {
      correlationId: "22222222-2222-4222-8222-222222222222",
      interactionId: "interaction-1",
      runId: 7
    });

    const message = externalErrorMessage(failure);

    expect(message).toBe(
      "The request could not be completed. Reference: 22222222-2222-4222-8222-222222222222."
    );
    expect(message).not.toContain("model_provider_failed");
    expect(message).not.toContain("interaction-1");
    expect(message).not.toContain("7");
  });
});
