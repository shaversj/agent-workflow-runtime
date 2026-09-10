import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";

import { openHistoryStore } from "../src/db/index.js";
import { historyArtifactsPath, historyDatabasePath } from "../src/workspaces/storage.js";

let home: string;
let application: ElectronApplication;
test.beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "desktop-ui-")));
  const env: Record<string, string> = {
    AGENT_OPS_HOME: home,
    AGENT_OPS_DESKTOP_NODE: process.execPath
  };
  for (const key of [
    "HOME",
    "PATH",
    "TMPDIR",
    "DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS"
  ])
    if (process.env[key]) env[key] = process.env[key];
  application = await electron.launch({
    args: [path.resolve("dist-desktop/main.mjs")],
    chromiumSandbox: true,
    env
  });
});
test.afterEach(async () => {
  await application?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function readerPid() {
  const parent = application.process().pid;
  const row = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .find((line) => {
      const fields = line.trim().split(/\s+/);
      return Number(fields[1]) === parent && line.includes("worker.mjs");
    });
  if (!row) throw new Error("Reader process not found");
  return Number(row.trim().split(/\s+/)[0]);
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("recovers from reader exit and timeout, and terminates its reader on close", async () => {
  const page = await application.firstWindow();
  await expect(page.getByText("No history store yet")).toBeVisible();
  const first = readerPid();
  process.kill(first, "SIGSTOP");
  const pending = page.evaluate(() => window.historyDesktop.read({ method: "list", options: {} }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  process.kill(first, "SIGKILL");
  expect((await pending).ok).toBe(false);
  expect(
    (await page.evaluate(() => window.historyDesktop.read({ method: "list", options: {} }))).ok
  ).toBe(true);
  const second = readerPid();
  expect(second).not.toBe(first);
  process.kill(second, "SIGSTOP");
  const timed = await page.evaluate(() =>
    window.historyDesktop.read({ method: "list", options: {} })
  );
  expect(timed.ok).toBe(false);
  await expect.poll(() => processExists(second)).toBe(false);
  await expect(page.getByRole("alert")).toHaveCount(0, { timeout: 10000 });
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.historyDesktop.read({ method: "list", options: {} }))).ok
    )
    .toBe(true);
  const last = readerPid();
  process.kill(last, "SIGSTOP");
  await application.close();
  await expect.poll(() => processExists(last)).toBe(false);
});

test("coalesces navigation while a reader response is deferred", async () => {
  const page = await application.firstWindow();
  await expect(page.getByText("No history store yet")).toBeVisible();
  const pid = readerPid();
  process.kill(pid, "SIGSTOP");
  try {
    await page.getByRole("combobox", { name: "Source", exact: true }).selectOption("cli");
    await page.waitForTimeout(200);
    await page.getByRole("combobox", { name: "Source", exact: true }).selectOption("discord");
    await page.waitForTimeout(200);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    process.kill(pid, "SIGCONT");
  }
  await expect(page.getByRole("combobox", { name: "Source", exact: true })).toHaveValue("discord");
  await expect(page.getByText("No history store yet")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("empty, unavailable and no-match states remain read-only behind a sandboxed bridge", async () => {
  const page = await application.firstWindow();
  await expect(page.getByText("No history store yet")).toBeVisible();
  expect(fs.readdirSync(home)).toEqual([]);
  expect(
    await page.evaluate(() => ({
      node: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process
    }))
  ).toEqual({ node: "undefined", process: "undefined" });
  const security = await application.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .filter((metric) => metric.type === "Tab")
      .map((metric) => metric.sandboxed)
  );
  expect(security).toContain(true);
  expect(await application.evaluate(({ app }) => app.commandLine.hasSwitch("no-sandbox"))).toBe(
    false
  );
  const displayAuthority = await application.evaluate(() => process.env.XAUTHORITY);
  expect(displayAuthority).toBe(process.env.XAUTHORITY || undefined);
  const invalid = await page.evaluate(async () =>
    window.historyDesktop.read({ method: "list", options: { home: "/tmp" } } as never)
  );
  expect(invalid.ok).toBe(false);
  const foreign = await application.evaluate(async ({ BrowserWindow }, preload) => {
    const owner = BrowserWindow.getAllWindows()[0]!;
    const other = new BrowserWindow({
      show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    try {
      await other.loadURL(owner.webContents.getURL());
      const result: unknown = await other.webContents.executeJavaScript(
        'window.historyDesktop.read({method:"list",options:{}})'
      );
      return result;
    } finally {
      other.destroy();
    }
  }, path.resolve("dist-desktop/preload.cjs"));
  expect(foreign).toMatchObject({ ok: false });
  const store = openHistoryStore({ home });
  store.close();
  await expect(page.getByText("No interactions recorded")).toBeVisible({ timeout: 8000 });
  await page.getByLabel("Target", { exact: true }).fill("absent-target");
  await page.getByRole("button", { name: "Filter target" }).click();
  await expect(page.getByText("No matching interactions")).toBeVisible();
  const original = fs.readFileSync(historyDatabasePath(home));
  fs.writeFileSync(historyDatabasePath(home), "corrupt fixture");
  await expect(page.getByRole("alert")).toContainText("could not be refreshed", { timeout: 8000 });
  fs.writeFileSync(historyDatabasePath(home), original);
  await expect(page.getByRole("alert")).toHaveCount(0, { timeout: 8000 });
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
    const page = await application.firstWindow();
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
    await page.screenshot({ path: "test-results/desktop-wide.png" });
    await page.setViewportSize({ width: 430, height: 800 });
    await page.screenshot({ path: "test-results/desktop-narrow.png" });
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
    store.finishRun({ id: nested, status: "completed" });
    store.finishRun({ id: request.runId, status: "completed" });
    store.finishInteraction({ id: request.interactionId, status: "completed" });
    const page = await application.firstWindow();
    const remote: string[] = [];
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) remote.push(request.url());
    });
    await page.getByRole("button", { name: /Review repository context/ }).click({ timeout: 8000 });
    await expect(page.getByText("Saved response despite delivery failure")).toBeVisible();
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
    await page.screenshot({ path: "test-results/desktop-report.png" });
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
    const page = await application.firstWindow();
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
