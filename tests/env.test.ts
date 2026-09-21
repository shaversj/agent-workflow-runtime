import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadTrustedEnv, trustedEnvPath } from "../src/env.js";

const keys = [
  "AGENT_OPS_ENV_FILE",
  "AGENT_OPS_HOME",
  "AGENT_OPS_KIT_TEST_ENV_FILE_LOADED",
  "GIT_CONFIG_GLOBAL"
] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) restoreEnv(key, original[key]);
});

describe("trusted env loading", () => {
  it("ignores a .env file in the process working directory", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-target-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-home-"));
    const previousCwd = process.cwd();
    fs.writeFileSync(
      path.join(cwd, ".env"),
      "AGENT_OPS_KIT_TEST_ENV_FILE_LOADED=target\nGIT_CONFIG_GLOBAL=/tmp/hostile\n"
    );
    delete process.env.AGENT_OPS_KIT_TEST_ENV_FILE_LOADED;
    delete process.env.GIT_CONFIG_GLOBAL;
    delete process.env.AGENT_OPS_ENV_FILE;
    process.env.AGENT_OPS_HOME = home;

    try {
      process.chdir(cwd);
      expect(loadTrustedEnv()).toBeUndefined();
      expect(process.env.AGENT_OPS_KIT_TEST_ENV_FILE_LOADED).toBeUndefined();
      expect(process.env.GIT_CONFIG_GLOBAL).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("loads the application-home default without overriding operator values", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-home-"));
    const envPath = path.join(home, ".env");
    fs.writeFileSync(envPath, "AGENT_OPS_KIT_TEST_ENV_FILE_LOADED=file\n");
    process.env.AGENT_OPS_HOME = home;
    process.env.AGENT_OPS_KIT_TEST_ENV_FILE_LOADED = "operator";
    delete process.env.AGENT_OPS_ENV_FILE;

    expect(loadTrustedEnv()).toBe(fs.realpathSync(envPath));
    expect(process.env.AGENT_OPS_KIT_TEST_ENV_FILE_LOADED).toBe("operator");
  });

  it("loads an explicit absolute env file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-config-"));
    const envPath = path.join(directory, "runtime.env");
    fs.writeFileSync(envPath, "AGENT_OPS_KIT_TEST_ENV_FILE_LOADED=yes\n");
    process.env.AGENT_OPS_ENV_FILE = envPath;
    delete process.env.AGENT_OPS_KIT_TEST_ENV_FILE_LOADED;

    expect(loadTrustedEnv()).toBe(fs.realpathSync(envPath));
    expect(process.env.AGENT_OPS_KIT_TEST_ENV_FILE_LOADED).toBe("yes");
  });

  it.each([
    ["relative path", "runtime.env"],
    ["missing file", path.join(os.tmpdir(), "agent-ops-missing-runtime.env")]
  ])("rejects an explicit %s without disclosing the configured path", (_label, configured) => {
    process.env.AGENT_OPS_ENV_FILE = configured;

    expect(() => trustedEnvPath()).toThrowError("trusted_env_file_invalid");
    try {
      trustedEnvPath();
    } catch (error) {
      expect(String(error)).not.toContain(configured);
    }
  });

  it("rejects explicit configuration stored inside a Git checkout", () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-target-"));
    fs.mkdirSync(path.join(checkout, ".git"));
    const envPath = path.join(checkout, "runtime.env");
    fs.writeFileSync(envPath, "AGENT_OPS_KIT_TEST_ENV_FILE_LOADED=target\n");
    process.env.AGENT_OPS_ENV_FILE = envPath;

    expect(() => trustedEnvPath()).toThrowError("trusted_env_file_invalid");
  });

  it("rejects configuration writable by another local principal", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-config-"));
    const envPath = path.join(directory, "runtime.env");
    fs.writeFileSync(envPath, "AGENT_OPS_KIT_TEST_ENV_FILE_LOADED=unsafe\n", { mode: 0o666 });
    fs.chmodSync(envPath, 0o666);
    process.env.AGENT_OPS_ENV_FILE = envPath;

    expect(() => trustedEnvPath()).toThrowError("trusted_env_file_invalid");
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
