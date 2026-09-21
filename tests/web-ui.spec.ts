import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { openHistoryStore } from "../src/db/index.js";
import { historyArtifactsPath, historyDatabasePath } from "../src/workspaces/storage.js";

let home: string;
let server: ChildProcess;
let currentPage: Page;
const origin = "http://127.0.0.1:4317";
test.beforeEach(async ({ page }, testInfo) => {
  currentPage = page;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "web-ui-")));
  const args =
    testInfo.project.name === "development"
      ? ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "4317", "--strictPort"]
      : ["--import", "tsx", "scripts/web-launch.ts"];
  server = spawn(process.execPath, args, {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, AGENT_OPS_HOME: home, PORT: "4317" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Web server did not start")), 10000);
    server.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Web server exited"));
    });
    server.once("error", reject);
    let output = "";
    server.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(origin)) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr?.resume();
  });
  await page.goto(origin);
});
test.afterEach(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => server.kill("SIGKILL"), 2000);
      server.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      server.kill("SIGTERM");
    });
  }
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

test("guards local history and recovers from unavailable storage", async ({ page, request }) => {
  await expect(page).toHaveTitle("Agent Workflow Runtime | History");
  await expect(page.getByText("Agent Workflow Runtime", { exact: true })).toBeVisible();
  const document = await request.get(origin);
  expect(document.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(document.headers()["cache-control"]).toBe("no-store");
  expect(document.headers()["x-content-type-options"]).toBe("nosniff");
  await expect(page.getByText("No history store yet")).toBeVisible();
  expect(fs.readdirSync(home)).toEqual([]);
  const response = await request.post(origin + "/api/history", {
    data: { method: "list", options: {} }
  });
  expect(response.status()).toBe(403);
  const crossOrigin = await request.post(origin + "/api/history", {
    headers: { Origin: "https://example.com" },
    data: { method: "list", options: {} }
  });
  expect(crossOrigin.status()).toBe(403);
  const rebound = await request.get(origin, { headers: { Host: "attacker.example" } });
  expect(rebound.status()).toBe(403);
  const invalid = await page.evaluate(async () => {
    const response = await fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "list", options: { home: "/tmp" } })
    });
    return response.json() as Promise<{ ok: boolean }>;
  });
  expect(invalid.ok).toBe(false);
  expect(
    await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)
  ).toBe("undefined");
  const store = openHistoryStore({ home });
  store.close();
  await expect(page.getByText("No interactions recorded")).toBeVisible({ timeout: 8000 });
  await page.getByLabel("Target", { exact: true }).fill("absent");
  await page.getByRole("button", { name: "Filter target" }).click();
  await expect(page.getByText("No matching interactions")).toBeVisible();
  const original = fs.readFileSync(historyDatabasePath(home));
  fs.writeFileSync(historyDatabasePath(home), "corrupt fixture");
  await expect(page.getByRole("alert")).toContainText("could not be refreshed", { timeout: 8000 });
  fs.writeFileSync(historyDatabasePath(home), original);
  await expect(page.getByRole("alert")).toHaveCount(0, { timeout: 8000 });
});

test("coalesces navigation across a delayed response", async ({ page }) => {
  await expect(page.getByText("No history store yet")).toBeVisible();
  let release!: () => void;
  const deferred = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route("**/api/history", async (route) => {
    requests += 1;
    if (requests === 1) await deferred;
    await route.continue();
  });
  await page.getByRole("combobox", { name: "Source", exact: true }).selectOption("cli");
  await expect.poll(() => requests).toBe(1);
  await page.getByRole("combobox", { name: "Source", exact: true }).selectOption("discord");
  expect(requests).toBe(1);
  release();
  await expect.poll(() => requests).toBe(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("follows saved activity without changing selection, expansion or scroll", async () => {
  const store = openHistoryStore({ home });
  try {
    const request = store.acceptInteraction({
      source: "cli",
      kind: "chat",
      userMessage: "Inspect release readiness"
    });
    const tool = store.startToolCall({
      runId: request.runId,
      ordinal: 1,
      name: "collect_evidence",
      kind: "workflow",
      input: { repo: "example" }
    });
    const page = currentPage;
    await page.getByRole("button", { name: /Inspect release readiness/ }).click({ timeout: 8000 });
    await page.locator("summary").filter({ hasText: "collect_evidence" }).click();
    const expanded = page.locator("details").filter({ hasText: "collect_evidence" });
    await expect(expanded).toHaveAttribute("open", "");
    await page.locator(".detail").evaluate((el) => {
      el.scrollTop = 120;
    });
    const scroll = await page.locator(".detail").evaluate((el) => el.scrollTop);
    store.finishToolCall({ id: tool, status: "completed", result: "Fresh saved result" });
    store.acceptInteraction({
      source: "cli",
      kind: "chat",
      userMessage: "Another request arrived"
    });
    await expect(expanded).toContainText("Fresh saved result", { timeout: 8000 });
    await expect(expanded).toHaveAttribute("open", "");
    await expect(page.getByRole("button", { name: /Inspect release readiness/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(await page.locator(".detail").evaluate((el) => el.scrollTop)).toBe(scroll);
    await expect(page.getByText("Unknown / not observed")).toBeVisible();
    await page.screenshot({ path: "test-results/web-wide.png" });
    await page.setViewportSize({ width: 430, height: 800 });
    await page.screenshot({ path: "test-results/web-narrow.png" });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    await page.getByRole("button", { name: "Interactions", exact: true }).click();
    await expect(page.getByRole("button", { name: /Another request arrived/ })).toBeVisible();
    expect(store.getInteraction(request.interactionId)?.status).toBe("running");
  } finally {
    store.close();
  }
});

test("separates delivery failures and renders registered reports without active content", async () => {
  const store = openHistoryStore({ home });
  try {
    const request = store.acceptInteraction({
      source: "discord",
      applicationId: "app",
      sourceMessageId: "message",
      kind: "chat",
      userMessage: "Review repository context"
    });
    const nested = store.createRun({
      interactionId: request.interactionId,
      parentRunId: request.runId,
      kind: "readiness_sweep",
      target: "https://github.com/example/repository",
      ref: "main",
      commitSha: "a".repeat(40)
    });
    const reply = store.appendMessage({
      interactionId: request.interactionId,
      runId: request.runId,
      role: "assistant",
      content: "Saved response despite delivery failure"
    });
    const delivery = store.startDeliveryAttempt({ messageId: reply, part: 1, attempt: 1 });
    store.finishDeliveryAttempt({ id: delivery, status: "failed", error: "Remote send failed" });
    const file = path.join(historyArtifactsPath(home), "readiness.md");
    fs.writeFileSync(
      file,
      "# Repository readiness\n\nSafe report content.\n\n![remote](https://example.invalid/tracker.png)\n\n[external](https://example.invalid/)\n\n<script>window.compromised = true</script>"
    );
    store.registerArtifact({
      interactionId: request.interactionId,
      runId: nested,
      path: file,
      type: "markdown",
      title: "Readiness report"
    });
    const proposalFile = path.join(historyArtifactsPath(home), "coding-proposal.md");
    fs.writeFileSync(
      proposalFile,
      "# Coding Proposal\n\nStatus: proposal-ready\n\nHuman review required."
    );
    store.registerArtifact({
      interactionId: request.interactionId,
      runId: nested,
      path: proposalFile,
      type: "coding-proposal",
      title: "Coding proposal"
    });
    store.finishRun({ id: nested, status: "completed" });
    store.finishRun({ id: request.runId, status: "completed" });
    store.finishInteraction({ id: request.interactionId, status: "completed" });
    const page = currentPage;
    const remote: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== origin) remote.push(request.url());
    });
    await page.getByRole("button", { name: /Review repository context/ }).click({ timeout: 8000 });
    await expect(page.getByText("Saved response despite delivery failure")).toBeVisible();
    await page.getByRole("button", { name: "Read report", exact: true }).last().click();
    await expect(page.getByRole("heading", { name: "Coding Proposal" })).toBeVisible();
    await expect(page.getByRole("button", { name: /approve|publish|execute/i })).toHaveCount(0);
    await page.getByRole("button", { name: "Back to interaction" }).click();
    await expect(page.getByText("0 acknowledged / 1 failed")).toBeVisible();
    await page.locator("summary").filter({ hasText: "readiness_sweep" }).click();
    await expect(page.getByText("a".repeat(40), { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Read report", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Repository readiness" })).toBeVisible();
    await expect(page.locator(".markdown img, .markdown a, .markdown script")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { compromised?: boolean }).compromised)
    ).toBeUndefined();
    expect(remote).toEqual([]);
    await page.screenshot({ path: "test-results/web-report.png" });
    fs.unlinkSync(file);
    await expect(page.getByRole("heading", { name: "Report unavailable" })).toBeVisible({
      timeout: 8000
    });
    await page.getByRole("button", { name: "Back to interaction" }).click();
    await expect(page.getByText("Saved response despite delivery failure")).toBeVisible();
  } finally {
    store.close();
  }
});

test("keeps browsing bounded and does not mix selected interactions across pages", async () => {
  const store = openHistoryStore({ home });
  try {
    for (let index = 0; index < 24; index++)
      store.acceptInteraction({
        source: "cli",
        kind: "chat",
        userMessage: `Request number ${index}`
      });
    const request = store.acceptInteraction({
      source: "cli",
      kind: "chat",
      userMessage: "Long activity interaction"
    });
    for (let ordinal = 1; ordinal <= 55; ordinal++) {
      const id = store.startToolCall({
        runId: request.runId,
        ordinal,
        name: `evidence_${ordinal}`,
        kind: "workflow",
        input: {}
      });
      store.finishToolCall({ id, status: "completed", result: "Evidence captured" });
    }
    const page = currentPage;
    await page.getByRole("button", { name: /Long activity interaction/ }).click({ timeout: 8000 });
    await expect(page.locator(".interaction")).toHaveCount(20);
    await expect(page.locator(".activity-row")).toHaveCount(49);
    await page
      .getByRole("main", { name: "Interaction detail" })
      .getByRole("button", { name: "Next page" })
      .click();
    await expect(page.getByText("Activity page 2", { exact: true })).toBeVisible();
    await expect(page.locator(".activity-row")).toHaveCount(7);
    await page.getByRole("complementary").getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".interaction")).toHaveCount(5);
    await expect(page.locator(".identifier")).toHaveText(request.interactionId);
    await expect(page.getByRole("heading", { name: "Long activity interaction" })).toBeVisible();
    await page.getByRole("combobox", { name: "Source", exact: true }).selectOption("discord");
    await expect(page.getByText("No matching interactions")).toBeVisible();
    await expect(page.locator(".identifier")).toHaveText(request.interactionId);
  } finally {
    store.close();
  }
});
