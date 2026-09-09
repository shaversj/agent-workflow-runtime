import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, ipcMain, session } from "electron";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { DesktopRequestSchema, validateDesktopResponse } from "./contracts.js";
import type { DesktopResponse } from "./contracts.js";

const Config = Type.Object(
  {
    node: Type.String({ minLength: 1, maxLength: 4096 }),
    home: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 }))
  },
  { additionalProperties: false }
);
const config = {
  node: process.env.AGENT_OPS_DESKTOP_NODE,
  ...(process.env.AGENT_OPS_HOME ? { home: process.env.AGENT_OPS_HOME } : {})
};
if (!Value.Check(Config, config) || !path.isAbsolute(config.node))
  throw new Error("Launch the inspector with pnpm desktop using Node 24.");
const nodeExecutable = config.node;
const root = import.meta.dirname;
const entry = pathToFileURL(path.join(root, "renderer/index.html")).href;
let worker: ChildProcess | undefined;
let busy = false;
const unavailable: DesktopResponse = {
  ok: false,
  error: "History reader is unavailable. Retry in a moment."
};

function read(request: unknown): Promise<DesktopResponse> {
  if (busy || !Value.Check(DesktopRequestSchema, request)) return Promise.resolve(unavailable);
  busy = true;
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = worker ??= fork(path.join(root, "worker.mjs"), [], {
        execPath: nodeExecutable,
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          ...(config.home ? { AGENT_OPS_HOME: config.home } : {})
        }
      });
    } catch {
      busy = false;
      resolve(unavailable);
      return;
    }
    const finish = (response: DesktopResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", receive);
      child.off("exit", failed);
      child.off("error", failed);
      busy = false;
      resolve(response);
    };
    const failed = () => {
      if (settled) return;
      child.kill("SIGKILL");
      if (worker === child) worker = undefined;
      finish(unavailable);
    };
    const receive = (value: unknown) => {
      try {
        finish(validateDesktopResponse(value));
      } catch {
        failed();
      }
    };
    const timer = setTimeout(failed, 5000);
    child.once("message", receive);
    child.once("exit", failed);
    child.once("error", failed);
    child.send(request, (error) => {
      if (error) failed();
    });
  });
}

void app
  .whenReady()
  .then(async () => {
    app.setName("Agent Ops Kit");
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);
    const localAssets = new Set([
      entry,
      ...["app.js", "app.css"].map((file) => pathToFileURL(path.join(root, "renderer", file)).href)
    ]);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !localAssets.has(details.url) });
    });
    ipcMain.handle("history:read", (event, request: unknown) => {
      // File origins are opaque, so bind authority to this exact top frame and document.
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== entry
      )
        return unavailable;
      return read(request);
    });
    const window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 420,
      minHeight: 500,
      title: "Agent Ops Kit",
      backgroundColor: "#f7f8fa",
      webPreferences: {
        preload: path.join(root, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false
      }
    });
    window.webContents.on("will-navigate", (event) => {
      event.preventDefault();
    });
    window.webContents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await window.loadURL(entry);
    app.on("window-all-closed", () => {
      app.quit();
    });
    app.on("before-quit", () => {
      worker?.kill("SIGKILL");
      worker = undefined;
    });
  })
  .catch(() => {
    console.error("Unable to open the history inspector.");
    app.quit();
  });
