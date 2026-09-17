import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openHistoryReader } from "../src/db/index.js";
import { beginInteraction } from "../src/harness/interaction.js";
import { logger } from "../src/logger.js";
import { sendDiscordCodingReply } from "../src/surfaces/chat/discord/coding.js";

describe("Discord coding result delivery", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-delivery-"));
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function deliver(
    error: unknown,
    display: string | undefined = "# Saved proposal",
    fallbackError?: unknown
  ) {
    const recording = beginInteraction(
      { source: "cli", kind: "coding_delivery_test", userMessage: "Inspect saved result" },
      { home }
    );
    const content = "Job fixture: proposal-ready. No remote writes.";
    const id = recording.appendMessage({ role: "assistant", content });
    recording.finishRun({ status: "completed" });
    recording.finishInteraction({ status: "completed" });
    const reply = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ id: "fallback" });
    if (fallbackError) reply.mockRejectedValueOnce(fallbackError);
    try {
      await sendDiscordCodingReply({ id: "source", reply }, content, display, recording, id);
      const reader = openHistoryReader({ home })!;
      try {
        return {
          content,
          reply,
          attempts: reader.listDeliveryAttempts(id),
          interaction: reader.listInteractions()[0]!
        };
      } finally {
        reader.close();
      }
    } finally {
      recording.close();
    }
  }

  it("returns text after a definite attachment rejection without rerunning completed coding", async () => {
    const result = await deliver({ status: 413, code: 40005 });
    expect(result.reply).toHaveBeenCalledTimes(2);
    expect(result.reply.mock.calls[1]![0]).toHaveProperty(
      "content",
      expect.stringContaining("Attachment could not be sent")
    );
    expect(result.reply.mock.calls[1]![0]).toMatchObject({
      allowedMentions: { parse: [] }
    });
    expect(result.reply.mock.calls[1]![0]).not.toHaveProperty("files");
    expect(result.attempts).toMatchObject([
      { status: "failed" },
      { attempt: 2, status: "acknowledged", surfaceMessageId: "fallback" }
    ]);
    expect(result.attempts[0]?.error?.text).toContain("attachment_omitted");
    expect(result.interaction.status).toBe("completed");
  });

  it("logs safe HTTP diagnostics but never raw exception messages, headers or proposal content", async () => {
    const result = await deliver({
      status: 503,
      code: 0,
      message: "Bearer private-token",
      requestBody: { files: "private-proposal" },
      headers: { authorization: "private-token" }
    });
    expect(result.reply).toHaveBeenCalledTimes(1);
    expect(result.attempts).toMatchObject([{ status: "uncertain" }]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        interaction_id: result.interaction.id,
        message_id: "source",
        error_type: "discord_api",
        http_status: 503,
        discord_code: 0,
        delivery_status: "uncertain"
      }),
      "discord_bot.coding_delivery_failed"
    );
    const logs = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logs).not.toContain("private-token");
    expect(logs).not.toContain("private-proposal");
    expect(logs).not.toContain("Saved proposal");
  });

  it("records a permission rejection as failed and does not try an attachment fallback", async () => {
    const result = await deliver({ status: 403, code: 50013 });
    expect(result.reply).toHaveBeenCalledTimes(1);
    expect(result.attempts).toMatchObject([{ status: "failed" }]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("never blindly retries an uncertain network failure", async () => {
    const result = await deliver(
      Object.assign(new Error("private diagnostics"), { code: "ECONNRESET" })
    );
    expect(result.reply).toHaveBeenCalledTimes(1);
    expect(result.attempts).toMatchObject([{ status: "uncertain" }]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error_type: "discord_transport", transport_code: "ECONNRESET" }),
      "discord_bot.coding_delivery_failed"
    );
  });

  it("does not treat a text-only failure as an attachment rejection", async () => {
    const result = await deliver({ status: 413 }, "");
    expect(result.reply).toHaveBeenCalledTimes(1);
    expect(result.attempts).toMatchObject([{ status: "failed" }]);
  });

  it("records a failed fallback without a third send or changing execution status", async () => {
    const result = await deliver({ status: 413 }, "# Saved proposal", { status: 503 });
    expect(result.reply).toHaveBeenCalledTimes(2);
    expect(result.attempts).toMatchObject([{ status: "failed" }, { status: "uncertain" }]);
    expect(result.interaction.status).toBe("completed");
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    "retries invalid form data only when the rejected field is an attachment (%s)",
    async (attachment) => {
      const result = await deliver({
        status: 400,
        code: 50035,
        rawError: { errors: attachment ? { attachments: {} } : { content: {} } }
      });
      expect(result.reply).toHaveBeenCalledTimes(attachment ? 2 : 1);
      expect(result.attempts[0]?.status).toBe("failed");
    }
  );

  it("does not evaluate error getters or log unrecognized string codes", async () => {
    const getter = vi.fn(() => {
      throw new Error("private getter data");
    });
    const error = Object.defineProperty({ code: "private-token" }, "status", { get: getter });
    const result = await deliver(error);
    expect(getter).not.toHaveBeenCalled();
    expect(result.reply).toHaveBeenCalledTimes(1);
    expect(result.attempts[0]?.status).toBe("uncertain");
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("private-token");
  });

  it("identifies a missing cached channel as a local failure without sending again", async () => {
    const result = await deliver({ code: "ChannelNotCached" });
    expect(result.reply).toHaveBeenCalledTimes(1);
    expect(result.attempts[0]?.status).toBe("failed");
    expect(result.attempts[0]?.error?.text).toContain("ChannelNotCached");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error_type: "discord_local" }),
      "discord_bot.coding_delivery_failed"
    );
  });
});
