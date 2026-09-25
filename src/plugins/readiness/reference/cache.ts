import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { type TSchema } from "typebox";
import { Value } from "typebox/value";

import { ossRulesCachePath } from "../../../workspaces/storage.js";
import { BenchmarkCacheEnvelopeSchema, type BenchmarkCacheEnvelope } from "./schemas.js";

const MAX_CACHE_FILE_BYTES = 2 * 1024 * 1024;

interface BenchmarkCacheEntry<T> extends Omit<BenchmarkCacheEnvelope, "payload"> {
  payload: T;
}

export function readOssRulesCache<T>(
  endpoint: string,
  payloadSchema: TSchema,
  cacheRoot: string = ossRulesCachePath()
): BenchmarkCacheEntry<T> | undefined {
  try {
    const root = secureCacheRoot(cacheRoot, false);
    if (!root) return undefined;
    const file = cacheFile(root, endpoint);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CACHE_FILE_BYTES)
      return undefined;
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Value.Check(BenchmarkCacheEnvelopeSchema, value)) return undefined;
    if (value.endpoint !== endpoint || !Value.Check(payloadSchema, value.payload)) return undefined;
    return value as BenchmarkCacheEntry<T>;
  } catch {
    return undefined;
  }
}

export function writeOssRulesCache<T>(
  entry: BenchmarkCacheEntry<T>,
  payloadSchema: TSchema,
  cacheRoot: string = ossRulesCachePath()
): void {
  if (
    !Value.Check(BenchmarkCacheEnvelopeSchema, entry) ||
    !Value.Check(payloadSchema, entry.payload)
  ) {
    throw new Error("ossrules_cache_validation_failed");
  }
  const root = secureCacheRoot(cacheRoot, true);
  if (!root) throw new Error("ossrules_cache_path_unsafe");
  const destination = cacheFile(root, entry.endpoint);
  assertSafeDestination(destination);
  const temporary = path.join(
    root,
    `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  try {
    const handle = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify(entry), "utf8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function secureCacheRoot(cacheRoot: string, create: boolean): string | undefined {
  const root = path.resolve(cacheRoot);
  if (create) {
    if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) {
      throw new Error("ossrules_cache_path_unsafe");
    }
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  } else if (!fs.existsSync(root)) {
    return undefined;
  }
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
  if (create) fs.chmodSync(root, 0o700);
  return fs.realpathSync(root);
}

function assertSafeDestination(destination: string): void {
  if (!fs.existsSync(destination)) return;
  const stat = fs.lstatSync(destination);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("ossrules_cache_path_unsafe");
}

function cacheFile(root: string, endpoint: string): string {
  const key = crypto.createHash("sha256").update(endpoint).digest("hex");
  return path.join(root, `${key}.json`);
}
