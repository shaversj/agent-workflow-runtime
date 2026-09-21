import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

import { Type } from "typebox";
import { Value } from "typebox/value";

const TrustedEnvConfigSchema = Type.Object(
  {
    envFile: Type.Optional(Type.String({ minLength: 1 })),
    home: Type.Optional(Type.String({ minLength: 1 }))
  },
  { additionalProperties: false }
);

export class TrustedEnvError extends Error {
  override readonly name = "TrustedEnvError";
}

export function trustedEnvPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const config = {
    ...(env.AGENT_OPS_ENV_FILE === undefined ? {} : { envFile: env.AGENT_OPS_ENV_FILE }),
    ...(env.AGENT_OPS_HOME === undefined ? {} : { home: env.AGENT_OPS_HOME })
  };
  if (!Value.Check(TrustedEnvConfigSchema, config))
    throw new TrustedEnvError("trusted_env_config_invalid");

  if (config.envFile !== undefined) {
    if (!path.isAbsolute(config.envFile)) throw new TrustedEnvError("trusted_env_file_invalid");
    return verifiedEnvFile(config.envFile);
  }

  const home = config.home ?? path.join(os.homedir(), ".agent-ops-kit");
  if (!path.isAbsolute(home)) throw new TrustedEnvError("trusted_env_home_invalid");
  const envPath = path.join(path.resolve(home), ".env");
  if (!fs.existsSync(envPath)) return undefined;
  return verifiedEnvFile(envPath);
}

export function loadTrustedEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const envPath = trustedEnvPath(env);
  if (!envPath) return undefined;
  try {
    const descriptor = fs.openSync(envPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      assertTrustedFile(fs.fstatSync(descriptor));
      const bytes = fs.readFileSync(descriptor);
      if (bytes.length > 1024 * 1024) throw new Error("too_large");
      const values = parseEnv(bytes.toString("utf8"));
      for (const [key, value] of Object.entries(values)) {
        if (env[key] === undefined) env[key] = value;
      }
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    throw new TrustedEnvError("trusted_env_file_invalid");
  }
  return envPath;
}

function verifiedEnvFile(file: string): string {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("symlink");
    const resolved = fs.realpathSync(file);
    const stat = fs.lstatSync(resolved);
    assertTrustedFile(stat);
    assertTrustedDirectory(path.dirname(resolved));
    if (insideGitCheckout(path.dirname(resolved))) throw new Error("repository_config_denied");
    fs.accessSync(resolved, fs.constants.R_OK);
    return resolved;
  } catch {
    throw new TrustedEnvError("trusted_env_file_invalid");
  }
}

function assertTrustedFile(stat: fs.Stats): void {
  if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o022) !== 0)
    throw new Error("unsafe_file");
  if (process.getuid && stat.uid !== process.getuid()) throw new Error("wrong_owner");
}

function assertTrustedDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0)
    throw new Error("unsafe_directory");
  if (process.getuid && stat.uid !== process.getuid()) throw new Error("wrong_owner");
}

function insideGitCheckout(directory: string): boolean {
  let current = directory;
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
