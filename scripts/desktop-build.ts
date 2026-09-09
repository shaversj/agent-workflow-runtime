import fs from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "dist-desktop");
await fs.mkdir(path.join(output, "renderer"), { recursive: true });
await build({
  entryPoints: [
    path.join(root, "src/surfaces/desktop/main.ts"),
    path.join(root, "src/surfaces/desktop/worker.ts")
  ],
  outdir: output,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  packages: "external",
  format: "esm",
  target: "node24"
});
await build({
  entryPoints: [path.join(root, "src/surfaces/desktop/preload.ts")],
  outfile: path.join(output, "preload.cjs"),
  bundle: true,
  platform: "node",
  external: ["electron"],
  format: "cjs",
  target: "node24"
});
await build({
  entryPoints: [path.join(root, "src/surfaces/desktop/renderer/app.tsx")],
  outfile: path.join(output, "renderer/app.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  target: "chrome140",
  define: { "process.env.NODE_ENV": '"production"' }
});
await fs.copyFile(
  path.join(root, "src/surfaces/desktop/renderer/index.html"),
  path.join(output, "renderer/index.html")
);
