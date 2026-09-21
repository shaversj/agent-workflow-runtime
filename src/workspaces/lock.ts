import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { mirrorBootstrapSql, mirrorLocks, mirrorStates } from "../db/mirror-schema.js";
import { agentOpsHome, workspaceCachePath } from "./storage.js";

const closedObject = { additionalProperties: false } as const;
const LockRowSchema = Type.Object(
  {
    fence: Type.Integer({ minimum: 1 }),
    ownerToken: Type.String({ minLength: 1, maxLength: 128 }),
    ownerPid: Type.Integer({ minimum: 1 }),
    ownerHost: Type.String({ minLength: 1, maxLength: 255 }),
    stagingPath: Type.String({ minLength: 1, maxLength: 255 })
  },
  closedObject
);
const StateRowSchema = Type.Object(
  {
    fenceCounter: Type.Integer({ minimum: 0 }),
    currentPath: Type.Union([Type.String({ minLength: 1, maxLength: 255 }), Type.Null()])
  },
  closedObject
);

type LockRow = Static<typeof LockRowSchema>;

interface MirrorLockOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
}

interface MirrorLockLease {
  identity: string;
  fence: number;
  stagingPath: string;
  currentPath?: string;
  assertOwned: () => void;
  publish: () => string | undefined;
  release: () => void;
}

const LOCK_SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 50;

export async function acquireMirrorLock(
  identity: string,
  options: MirrorLockOptions = {}
): Promise<MirrorLockLease> {
  const validatedIdentity = mirrorIdentity(identity);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 120_000);
  const pollMs = positiveInteger(options.pollMs, DEFAULT_POLL_MS, 1_000);
  const deadline = Date.now() + timeoutMs;
  const owner = {
    token: crypto.randomUUID(),
    pid: process.pid,
    host: os.hostname()
  };
  const sqlite = openLockDatabase();

  try {
    while (true) {
      if (options.signal?.aborted) throw new Error("mirror_lock_aborted");
      const acquired = tryAcquire(sqlite, validatedIdentity, owner);
      if (acquired) {
        try {
          const stagingPath = mirrorPath(acquired.stagingPath, validatedIdentity, acquired.fence);
          const stalePath = acquired.stalePath
            ? mirrorPath(acquired.stalePath, validatedIdentity, acquired.staleFence)
            : undefined;
          if (stalePath && acquired.stalePath !== acquired.currentPath)
            fs.rmSync(stalePath, { recursive: true, force: true });
          const currentPath = resolveCurrentPath(
            sqlite,
            validatedIdentity,
            acquired.currentPath,
            acquired.fence,
            owner.token
          );
          cleanupOrphanMirrors(validatedIdentity, new Set([stagingPath, currentPath]));
          let released = false;
          return {
            identity: validatedIdentity,
            fence: acquired.fence,
            stagingPath,
            ...(currentPath ? { currentPath } : {}),
            assertOwned: () => assertOwned(sqlite, validatedIdentity, acquired.fence, owner.token),
            publish: () => {
              assertMirrorDirectory(stagingPath);
              const previous = publishMirror(
                sqlite,
                validatedIdentity,
                acquired.fence,
                owner.token,
                path.basename(stagingPath)
              );
              return previous
                ? mirrorPath(previous, validatedIdentity, undefined, path.basename(stagingPath))
                : undefined;
            },
            release: () => {
              if (released) return;
              try {
                releaseMirror(sqlite, validatedIdentity, acquired.fence, owner.token);
                released = true;
              } finally {
                if (sqlite.open) sqlite.close();
              }
            }
          };
        } catch (error) {
          try {
            releaseMirror(sqlite, validatedIdentity, acquired.fence, owner.token);
          } finally {
            if (sqlite.open) sqlite.close();
          }
          throw error;
        }
      }
      if (Date.now() >= deadline) throw new Error("mirror_lock_timeout");
      await abortableDelay(Math.min(pollMs, Math.max(1, deadline - Date.now())), options.signal);
    }
  } catch (error) {
    if (sqlite.open) sqlite.close();
    throw error;
  }
}

function tryAcquire(
  sqlite: Database.Database,
  identity: string,
  owner: { token: string; pid: number; host: string }
):
  | {
      fence: number;
      stagingPath: string;
      currentPath: string | null;
      stalePath?: string;
      staleFence?: number;
    }
  | undefined {
  try {
    return sqlite
      .transaction(() => {
        const db = drizzle(sqlite);
        db.insert(mirrorStates).values({ identity, fenceCounter: 0 }).onConflictDoNothing().run();
        const existing = parseRow(
          LockRowSchema,
          db
            .select({
              fence: mirrorLocks.fence,
              ownerToken: mirrorLocks.ownerToken,
              ownerPid: mirrorLocks.ownerPid,
              ownerHost: mirrorLocks.ownerHost,
              stagingPath: mirrorLocks.stagingPath
            })
            .from(mirrorLocks)
            .where(eq(mirrorLocks.identity, identity))
            .get()
        );
        if (existing && !ownerIsProvablyAbsent(existing)) return undefined;
        if (existing) db.delete(mirrorLocks).where(eq(mirrorLocks.identity, identity)).run();

        db.update(mirrorStates)
          .set({ fenceCounter: sql`${mirrorStates.fenceCounter} + 1` })
          .where(eq(mirrorStates.identity, identity))
          .run();
        const state = requiredRow(
          StateRowSchema,
          db
            .select({
              fenceCounter: mirrorStates.fenceCounter,
              currentPath: mirrorStates.currentPath
            })
            .from(mirrorStates)
            .where(eq(mirrorStates.identity, identity))
            .get()
        );
        const stagingPath = `${identity}-mirror-${state.fenceCounter}-${owner.token.slice(0, 12)}.git`;
        db.insert(mirrorLocks)
          .values({
            identity,
            fence: state.fenceCounter,
            ownerToken: owner.token,
            ownerPid: owner.pid,
            ownerHost: owner.host,
            stagingPath,
            acquiredAt: Date.now()
          })
          .run();
        return {
          fence: state.fenceCounter,
          stagingPath,
          currentPath: state.currentPath,
          ...(existing ? { stalePath: existing.stagingPath, staleFence: existing.fence } : {})
        };
      })
      .immediate();
  } catch (error) {
    if ((error as { code?: unknown }).code === "SQLITE_BUSY") return undefined;
    throw error;
  }
}

function resolveCurrentPath(
  sqlite: Database.Database,
  identity: string,
  currentName: string | null,
  fence: number,
  ownerToken: string
): string | undefined {
  if (!currentName) return undefined;
  const currentPath = mirrorPath(currentName, identity);
  if (isDirectory(currentPath)) return currentPath;
  sqlite
    .transaction(() => {
      assertOwned(sqlite, identity, fence, ownerToken);
      drizzle(sqlite)
        .update(mirrorStates)
        .set({ currentPath: null, currentFence: null })
        .where(eq(mirrorStates.identity, identity))
        .run();
    })
    .immediate();
  return undefined;
}

function publishMirror(
  sqlite: Database.Database,
  identity: string,
  fence: number,
  ownerToken: string,
  stagingName: string
): string | undefined {
  return sqlite
    .transaction(() => {
      assertOwned(sqlite, identity, fence, ownerToken);
      const db = drizzle(sqlite);
      const state = requiredRow(
        StateRowSchema,
        db
          .select({
            fenceCounter: mirrorStates.fenceCounter,
            currentPath: mirrorStates.currentPath
          })
          .from(mirrorStates)
          .where(eq(mirrorStates.identity, identity))
          .get()
      );
      db.update(mirrorStates)
        .set({ currentPath: stagingName, currentFence: fence })
        .where(eq(mirrorStates.identity, identity))
        .run();
      return state.currentPath ?? undefined;
    })
    .immediate();
}

function releaseMirror(
  sqlite: Database.Database,
  identity: string,
  fence: number,
  ownerToken: string
): void {
  const result = drizzle(sqlite)
    .delete(mirrorLocks)
    .where(
      and(
        eq(mirrorLocks.identity, identity),
        eq(mirrorLocks.fence, fence),
        eq(mirrorLocks.ownerToken, ownerToken)
      )
    )
    .run();
  if (result.changes !== 1) throw new Error("mirror_lock_ownership_lost");
}

function assertOwned(
  sqlite: Database.Database,
  identity: string,
  fence: number,
  ownerToken: string
): void {
  const row = parseRow(
    LockRowSchema,
    drizzle(sqlite)
      .select({
        fence: mirrorLocks.fence,
        ownerToken: mirrorLocks.ownerToken,
        ownerPid: mirrorLocks.ownerPid,
        ownerHost: mirrorLocks.ownerHost,
        stagingPath: mirrorLocks.stagingPath
      })
      .from(mirrorLocks)
      .where(
        and(
          eq(mirrorLocks.identity, identity),
          eq(mirrorLocks.fence, fence),
          eq(mirrorLocks.ownerToken, ownerToken)
        )
      )
      .get()
  );
  if (!row) throw new Error("mirror_lock_ownership_lost");
}

function ownerIsProvablyAbsent(row: LockRow): boolean {
  if (row.ownerHost !== os.hostname() || row.ownerPid === process.pid) return false;
  try {
    process.kill(row.ownerPid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function openLockDatabase(): Database.Database {
  const configuredHome = agentOpsHome();
  const configuredDirectory = workspaceCachePath();
  ensureDirectory(configuredHome, true);
  ensureDirectory(path.join(configuredHome, "cache"));
  ensureDirectory(configuredDirectory);
  const home = fs.realpathSync(configuredHome);
  const directory = fs.realpathSync(configuredDirectory);
  const relative = path.relative(home, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("mirror_cache_symlink_denied");
  let candidate = configuredHome;
  const configuredRelative = path.relative(configuredHome, configuredDirectory);
  for (const segment of configuredRelative.split(path.sep).filter(Boolean)) {
    candidate = path.join(candidate, segment);
    if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error("mirror_cache_symlink_denied");
  }
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, ".mirror-locks.db");
  const fd = fs.openSync(
    file,
    fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
    0o600
  );
  fs.closeSync(fd);
  fs.chmodSync(file, 0o600);
  const sqlite = new Database(file, { fileMustExist: true, timeout: 100 });
  try {
    sqlite.pragma("journal_mode = DELETE");
    sqlite.pragma("synchronous = FULL");
    sqlite.pragma("foreign_keys = ON");
    sqlite
      .transaction(() => {
        const version = Number(sqlite.pragma("user_version", { simple: true }));
        if (version !== 0 && version !== LOCK_SCHEMA_VERSION)
          throw new Error("mirror_lock_schema_unsupported");
        sqlite.exec(mirrorBootstrapSql);
        const db = drizzle(sqlite);
        db.select().from(mirrorStates).limit(0).all();
        db.select().from(mirrorLocks).limit(0).all();
        if (version === 0) sqlite.pragma(`user_version = ${LOCK_SCHEMA_VERSION}`);
      })
      .immediate();
    return sqlite;
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

function ensureDirectory(directory: string, recursive = false): void {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("mirror_cache_symlink_denied");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.mkdirSync(directory, { mode: 0o700, recursive });
  }
  fs.chmodSync(directory, 0o700);
}

function mirrorPath(name: string, identity: string, fence?: number, exceptName?: string): string {
  const pattern = mirrorNamePattern(identity, fence);
  if (!pattern.test(name) || name === exceptName) throw new Error("mirror_path_invalid");
  const resolved = path.join(workspaceCachePath(), name);
  if (path.dirname(resolved) !== path.resolve(workspaceCachePath()))
    throw new Error("mirror_path_invalid");
  return resolved;
}

function cleanupOrphanMirrors(identity: string, keep: Set<string | undefined>): void {
  const pattern = mirrorNamePattern(identity);
  for (const name of fs.readdirSync(workspaceCachePath())) {
    if (!pattern.test(name)) continue;
    const candidate = mirrorPath(name, identity);
    if (!keep.has(candidate)) fs.rmSync(candidate, { recursive: true, force: true });
  }
}

function mirrorNamePattern(identity: string, fence?: number): RegExp {
  const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return fence
    ? new RegExp(`^${escaped}-mirror-${fence}-[0-9a-f-]{12}\\.git$`)
    : new RegExp(`^${escaped}-mirror-[1-9][0-9]*-[0-9a-f-]{12}\\.git$`);
}

function assertMirrorDirectory(value: string): void {
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("mirror_publish_invalid");
}

function mirrorIdentity(value: string): string {
  if (!/^(?:git-url|local-git)-[0-9a-f]{16}$/.test(value))
    throw new Error("mirror_identity_invalid");
  return value;
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum)
    throw new Error("mirror_lock_option_invalid");
  return resolved;
}

function parseRow<T extends TSchema>(schema: T, value: unknown): Static<T> | undefined {
  if (value === undefined) return undefined;
  if (!Value.Check(schema, value)) throw new Error("mirror_lock_state_invalid");
  return value;
}

function requiredRow<T extends TSchema>(schema: T, value: unknown): Static<T> {
  const row = parseRow(schema, value);
  if (!row) throw new Error("mirror_lock_state_invalid");
  return row;
}

function isDirectory(value: string): boolean {
  try {
    const stat = fs.lstatSync(value);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("mirror_lock_aborted");
  await new Promise<void>((resolve, reject) => {
    const complete = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(complete, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("mirror_lock_aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
