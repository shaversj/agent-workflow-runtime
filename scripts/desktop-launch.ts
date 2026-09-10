import { spawn } from "node:child_process";
import path from "node:path";

import electron from "electron";

if (Number(process.versions.node.split(".")[0]) < 24)
  throw new Error("Desktop inspection requires Node 24 or newer.");
const env: NodeJS.ProcessEnv = { AGENT_OPS_DESKTOP_NODE: process.execPath };
for (const key of [
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "DISPLAY",
  "XAUTHORITY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "DBUS_SESSION_BUS_ADDRESS",
  "AGENT_OPS_HOME"
]) {
  if (process.env[key]) env[key] = process.env[key];
}
const child = spawn(
  electron as unknown as string,
  [path.resolve(import.meta.dirname, "../dist-desktop/main.mjs")],
  { stdio: "inherit", env }
);
child.on("error", () => {
  console.error("Unable to launch desktop. Run pnpm install and pnpm build:desktop.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
process.on("SIGINT", () => {
  child.kill("SIGINT");
});
process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});
