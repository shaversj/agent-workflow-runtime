import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

export function loadLocalEnv(cwd = process.cwd()) {
  const envPath = path.join(cwd, ".env");
  if (!fs.existsSync(envPath)) return;
  loadEnvFile(envPath);
}
