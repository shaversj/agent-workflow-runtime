import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvFile } from "node:process";

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
    loadEnvFile(envPath);
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
    if (!stat.isFile()) throw new Error("not_file");
    fs.accessSync(resolved, fs.constants.R_OK);
    return resolved;
  } catch {
    throw new TrustedEnvError("trusted_env_file_invalid");
  }
}
