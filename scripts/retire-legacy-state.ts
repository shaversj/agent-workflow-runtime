import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import Database from "better-sqlite3";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const identitySchema = Type.Object(
  { dev: Type.String(), ino: Type.String() },
  { additionalProperties: false }
);
const fingerprintSchema = Type.Object(
  {
    ...identitySchema.properties,
    size: Type.String(),
    mtimeNs: Type.String(),
    ctimeNs: Type.String(),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" })
  },
  { additionalProperties: false }
);
const fileSchema = Type.Object(
  {
    path: Type.String(),
    kind: Type.Union([Type.Literal("database"), Type.Literal("sidecar"), Type.Literal("report")]),
    fingerprint: fingerprintSchema
  },
  { additionalProperties: false }
);
const manifestSchema = Type.Object(
  {
    version: Type.Literal(1),
    root: Type.String(),
    rootIdentity: identitySchema,
    directories: Type.Array(
      Type.Object(
        { path: Type.String(), identity: identitySchema },
        { additionalProperties: false }
      )
    ),
    files: Type.Array(fileSchema),
    excluded: Type.Array(
      Type.Object({ path: Type.String(), reason: Type.String() }, { additionalProperties: false })
    ),
    digest: Type.String({ pattern: "^[a-f0-9]{64}$" })
  },
  { additionalProperties: false }
);
type Manifest = Static<typeof manifestSchema>;
type Entry = Static<typeof fileSchema>;
type Fingerprint = Static<typeof fingerprintSchema>;

// Frozen contracts, not migrations: reject every schema outside these exact versions.
const legacySchemaDigests = new Set([
  // Pre-cutover ensureSchema from 93781d700a50dd893ac54641c57855e4726f4e67.
  "44a89e9790d6df96e2b7563ccbfbc0905e0fb433b9f701003998b06ee6e79327",
  // Earlier schema without run.token_count and run.failure_reason.
  "c35485e56dbdb799bcff8cf257b6ae343930206d3944a9fe9046fe26e58cde70"
]);
const sidecars = ["agent-ops.db-journal", "agent-ops.db-wal", "agent-ops.db-shm"];
const reportPattern = /^\d{8}T\d{6}Z-[1-9]\d*-readiness-sweep\.md$/;
const keyPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function identity(stat: fs.BigIntStats) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function statIfPresent(file: string) {
  try {
    return fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function rootPath(input: string): string {
  const root = path.resolve(input);
  if (root === path.parse(root).root)
    throw new Error("Managed-state root cannot be filesystem root");
  // Reject aliases supplied as a root, including aliases in its parent path.
  for (let current = root; current !== path.dirname(current); current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink())
      throw new Error("Symlinked managed-state root ancestor");
  }
  const resolved = fs.realpathSync(root);
  if (!fs.statSync(resolved).isDirectory())
    throw new Error("Managed-state root is not a directory");
  return resolved;
}

function checkedPath(root: string, relative: string): string {
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
    throw new Error(`Invalid relative path: ${relative}`);
  }
  const file = path.resolve(root, ...parts);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error(`Path escapes root: ${relative}`);
  let current = root;
  for (const [index, part] of ["", ...parts].entries()) {
    if (part) current = path.join(current, part);
    const stat = statIfPresent(current);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`Symlink refused: ${relative}`);
    if (index < parts.length && !stat.isDirectory())
      throw new Error(`Not a directory: ${relative}`);
  }
  return file;
}

function fingerprint(root: string, relative: string): Fingerprint | undefined {
  const file = checkedPath(root, relative);
  if (!statIfPresent(file)) return undefined;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n)
      throw new Error(`Not a single-link file: ${relative}`);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let count: number;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, count));
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(checkedPath(root, relative), { bigint: true });
    if (
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.size !== after.size ||
      before.ino !== current.ino ||
      before.dev !== current.dev
    ) {
      throw new Error(`File changed during read: ${relative}`);
    }
    return {
      ...identity(before),
      size: String(before.size),
      mtimeNs: String(before.mtimeNs),
      ctimeNs: String(before.ctimeNs),
      sha256: hash.digest("hex")
    };
  } finally {
    fs.closeSync(fd);
  }
}

function requireFingerprint(root: string, entry: Entry): boolean {
  const current = fingerprint(root, entry.path);
  if (!current) return false;
  if (digest(current) !== digest(entry.fingerprint)) throw new Error(`Stale file: ${entry.path}`);
  return true;
}

function assertDatabaseIdle(root: string, relative: string) {
  const names = [relative, ...sidecars.map((name) => `${path.posix.dirname(relative)}/${name}`)];
  const files = names.map((name) => checkedPath(root, name)).filter((file) => statIfPresent(file));
  if (!files.length) return;
  // SQLite readonly connections may modify SHM. Refuse any open handle without
  // opening the original database, including idle readers/writers.
  const result = spawnSync("lsof", ["-nP", "-F", "p", "--", ...files], {
    encoding: "utf8",
    timeout: 10_000
  });
  if (
    result.error ||
    result.signal ||
    result.stderr.trim() ||
    (result.status !== 0 && result.status !== 1)
  ) {
    throw new Error(
      `Cannot verify stopped writers; lsof must be available and able to inspect legacy files: ${relative}`
    );
  }
  if (result.status === 0 || result.stdout.trim())
    throw new Error(`Busy legacy database or sidecar: ${relative}`);
}

function verifyLegacySchema(db: Database.Database, relative: string) {
  const rowsSchema = Type.Array(
    Type.Object({
      type: Type.String(),
      name: Type.String(),
      tbl_name: Type.String(),
      sql: Type.String()
    })
  );
  const rows: unknown = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name"
    )
    .all();
  if (
    !Value.Check(rowsSchema, rows) ||
    !legacySchemaDigests.has(
      digest(
        rows.map((row) => ({
          ...row,
          sql: row.sql.replace(/\s+/g, " ").trim()
        }))
      )
    )
  )
    throw new Error(`Unexpected legacy schema: ${relative}`);
  if (db.pragma("quick_check", { simple: true }) !== "ok")
    throw new Error(`Corrupt database: ${relative}`);
}

function openLegacy(root: string, relative: string): Database.Database {
  assertDatabaseIdle(root, relative);
  // Query disposable copies: even readonly SQLite may recover a journal or
  // write a WAL index. Only the fresh, private scratch directory is modified.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-retirement-inspect-"));
  let disk: Database.Database | undefined;
  let snapshot: Database.Database | undefined;
  const copied = new Map<string, Fingerprint>();
  try {
    for (const name of ["agent-ops.db", ...sidecars]) {
      const source = `${path.posix.dirname(relative)}/${name}`;
      const before = fingerprint(root, source);
      if (!before) continue;
      copied.set(source, before);
      const fd = fs.openSync(
        checkedPath(root, source),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      );
      try {
        fs.writeFileSync(path.join(scratch, name), fs.readFileSync(fd), {
          flag: "wx",
          mode: 0o600
        });
      } finally {
        fs.closeSync(fd);
      }
      if (digest(before) !== digest(fingerprint(root, source)))
        throw new Error(`Changed while copying: ${source}`);
    }
    // Identity must survive removing the WAL, including a failed final DB unlink.
    // Inspect the standalone main image with in-memory rollback journal flags.
    const baseImage = fs.readFileSync(path.join(scratch, "agent-ops.db"));
    baseImage[18] = 1;
    baseImage[19] = 1;
    const base = new Database(baseImage, { readonly: true });
    try {
      verifyLegacySchema(base, relative);
    } finally {
      base.close();
    }
    disk = new Database(path.join(scratch, "agent-ops.db"), { fileMustExist: true, timeout: 0 });
    // serialize includes committed WAL content; normalize only the in-memory
    // image's journal-mode bytes so deserialization needs no filesystem WAL.
    const buffer = disk.serialize();
    buffer[18] = 1;
    buffer[19] = 1;
    snapshot = new Database(buffer, { readonly: true });
    verifyLegacySchema(snapshot, relative);
    assertDatabaseIdle(root, relative);
    for (const [source, before] of copied) {
      if (digest(before) !== digest(fingerprint(root, source)))
        throw new Error(`Changed during inspection: ${source}`);
    }
    return snapshot;
  } catch (error) {
    snapshot?.close();
    throw new Error(
      `Legacy database refused (${relative}): ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    disk?.close();
    for (const name of ["agent-ops.db", ...sidecars]) {
      const file = path.join(scratch, name);
      if (statIfPresent(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(scratch);
  }
}

function generatedReport(root: string, relative: string, db?: Database.Database): boolean {
  if (!reportPattern.test(path.basename(relative))) return false;
  const file = checkedPath(root, relative);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const buffer = Buffer.alloc(16 * 1024);
  let header: string;
  try {
    header = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  if (
    header.startsWith("# Agent Readiness Sweep\n\nRepository: `") &&
    (header.includes(
      "\nThis report was generated by Agent Ops Kit through a read-only workflow.\n"
    ) ||
      header.includes(
        "\nThis report was generated by Agent Workflow Runtime through a read-only workflow.\n"
      ))
  )
    return true;
  return Boolean(
    db
      ?.prepare(
        "SELECT 1 FROM artifact WHERE type = 'markdown_report' AND title = 'Agent Readiness Sweep' AND path_or_url = ? LIMIT 1"
      )
      .get(file)
  );
}

/** Read-only inventory. The returned JSON is the complete deletion allowlist. */
export function previewRetirement(inputRoot: string): Manifest {
  const root = rootPath(inputRoot);
  const files: Entry[] = [];
  const directories: Manifest["directories"] = [];
  const excluded: Manifest["excluded"] = [];
  function directory(relative: string): string[] {
    const file = checkedPath(root, relative);
    const stat = statIfPresent(file);
    if (!stat) return [];
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${relative}`);
    directories.push({ path: relative, identity: identity(stat) });
    return fs.readdirSync(file).sort();
  }
  function add(relative: string, kind: Entry["kind"]) {
    const found = fingerprint(root, relative);
    if (found) files.push({ path: relative, kind, fingerprint: found });
  }
  for (const key of directory("targets")) {
    const target = `targets/${key}`;
    if (!keyPattern.test(key)) {
      excluded.push({ path: target, reason: "Unknown target key" });
      continue;
    }
    const names = directory(target);
    const database = `${target}/agent-ops.db`;
    let db: Database.Database | undefined;
    try {
      if (names.includes("agent-ops.db")) {
        const before = fingerprint(root, database);
        db = openLegacy(root, database);
        if (digest(before) !== digest(fingerprint(root, database)))
          throw new Error(`Changed database: ${database}`);
      }
      for (const name of names) {
        const relative = `${target}/${name}`;
        if (name === "agent-ops.db") continue;
        if (sidecars.includes(name) && db) {
          add(relative, "sidecar");
          continue;
        }
        if (name === "reports") {
          for (const report of directory(relative)) {
            const reportPath = `${relative}/${report}`;
            if (reportPattern.test(report)) {
              fingerprint(root, reportPath);
              if (generatedReport(root, reportPath, db)) {
                add(reportPath, "report");
                continue;
              }
            }
            excluded.push({ path: reportPath, reason: "Not a recognized generated legacy report" });
          }
        } else excluded.push({ path: relative, reason: "Outside legacy allowlist" });
      }
      if (db) add(database, "database");
    } finally {
      db?.close();
    }
  }
  const body = {
    version: 1 as const,
    root,
    rootIdentity: identity(fs.lstatSync(root, { bigint: true })),
    directories,
    files,
    excluded
  };
  return { ...body, digest: digest(body) };
}

function validateManifest(inputRoot: string, input: unknown): Manifest {
  if (!Value.Check(manifestSchema, input)) throw new Error("Invalid retirement manifest schema");
  const { digest: checksum, ...body } = input;
  if (digest(body) !== checksum) throw new Error("Tampered retirement manifest digest");
  const root = rootPath(inputRoot);
  if (
    input.root !== root ||
    digest(identity(fs.lstatSync(root, { bigint: true }))) !== digest(input.rootIdentity)
  ) {
    throw new Error("Manifest is bound to a different managed-state root");
  }
  const unique = new Set<string>();
  for (const entry of input.files) {
    const [targets, key, name, report, extra] = entry.path.split("/");
    const allowed =
      targets === "targets" &&
      key &&
      keyPattern.test(key) &&
      !extra &&
      ((entry.kind === "database" && name === "agent-ops.db" && !report) ||
        (entry.kind === "sidecar" && sidecars.includes(name ?? "") && !report) ||
        (entry.kind === "report" && name === "reports" && report && reportPattern.test(report)));
    if (!allowed || unique.has(entry.path))
      throw new Error(`Invalid or duplicate manifest target: ${entry.path}`);
    unique.add(entry.path);
    checkedPath(root, entry.path);
  }
  for (const directory of input.directories) {
    if (
      !/^targets(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/reports)?)?$/.test(directory.path) ||
      unique.has(directory.path)
    )
      throw new Error("Invalid manifest directory");
    unique.add(directory.path);
  }
  return input;
}

/** Apply only reviewed entries; exceptions after validation include exact remaining paths. */
export function applyRetirement(inputRoot: string, input: unknown, writersStopped: boolean) {
  if (!writersStopped)
    throw new Error("Apply requires --writers-stopped; stop old CLI and bot writers first");
  const manifest = validateManifest(inputRoot, input);
  const removed: string[] = [];
  const absent: string[] = [];
  let failedPath: string | undefined;
  function validateDirectories() {
    if (
      rootPath(manifest.root) !== manifest.root ||
      digest(identity(fs.lstatSync(manifest.root, { bigint: true }))) !==
        digest(manifest.rootIdentity)
    )
      throw new Error("Managed-state root changed");
    for (const directory of manifest.directories) {
      const stat = statIfPresent(checkedPath(manifest.root, directory.path));
      if (stat && (!stat.isDirectory() || digest(identity(stat)) !== digest(directory.identity)))
        throw new Error(`Directory changed: ${directory.path}`);
    }
  }
  try {
    validateDirectories();
    for (const entry of manifest.files) requireFingerprint(manifest.root, entry);
    // Re-inventory recognition and detect files added after review before any unlink.
    const fresh = previewRetirement(manifest.root);
    for (const directory of fresh.directories) {
      const reviewed = manifest.directories.find((item) => item.path === directory.path);
      if (!reviewed || digest(reviewed) !== digest(directory))
        throw new Error(`Stale inventory directory: ${directory.path}`);
    }
    for (const entry of fresh.files) {
      const reviewed = manifest.files.find((item) => item.path === entry.path);
      if (!reviewed || digest(reviewed) !== digest(entry))
        throw new Error(`Stale inventory: ${entry.path}`);
    }
    for (const entry of manifest.files) {
      if (
        fingerprint(manifest.root, entry.path) &&
        !fresh.files.some((item) => item.path === entry.path)
      )
        throw new Error(`Unrecognized reviewed file: ${entry.path}`);
    }
    const targets = [...new Set(manifest.files.map((entry) => entry.path.split("/")[1]!))];
    for (const key of targets) {
      const entries = manifest.files.filter((entry) => entry.path.startsWith(`targets/${key}/`));
      const database = entries.find((entry) => entry.kind === "database");
      let db: Database.Database | undefined;
      try {
        if (database && requireFingerprint(manifest.root, database))
          db = openLegacy(manifest.root, database.path);
        const ordered = [
          ...entries.filter((entry) => entry.kind === "report"),
          ...entries.filter((entry) => entry.kind === "sidecar"),
          ...(database ? [database] : [])
        ];
        for (const entry of ordered) {
          failedPath = entry.path;
          validateDirectories();
          if (!requireFingerprint(manifest.root, entry)) {
            absent.push(entry.path);
            continue;
          }
          if (entry.kind === "sidecar" && !db)
            throw new Error("Sidecar has no verified legacy database");
          if (entry.kind === "report" && !generatedReport(manifest.root, entry.path, db))
            throw new Error(`Unrecognized report: ${entry.path}`);
          if (database) assertDatabaseIdle(manifest.root, database.path);
          validateDirectories();
          if (database && entry.kind !== "database" && !requireFingerprint(manifest.root, database))
            throw new Error("Legacy database disappeared");
          if (entry.kind === "database") {
            for (const sidecar of sidecars) {
              if (statIfPresent(checkedPath(manifest.root, `targets/${key}/${sidecar}`)))
                throw new Error(`Sidecar still present: ${sidecar}`);
            }
          }
          // Node has no unlinkat: stopped writers and immediate checks bound the race.
          if (!requireFingerprint(manifest.root, entry)) {
            absent.push(entry.path);
            continue;
          }
          fs.unlinkSync(checkedPath(manifest.root, entry.path));
          removed.push(entry.path);
        }
      } finally {
        db?.close();
      }
    }
    return { ok: true as const, removed, absent, remaining: [] as string[] };
  } catch (error) {
    const remaining = manifest.files
      .filter((entry) => {
        if (removed.includes(entry.path) || absent.includes(entry.path)) return false;
        // Never follow a replaced parent to decide whether a reviewed entry is absent.
        try {
          return Boolean(statIfPresent(checkedPath(manifest.root, entry.path)));
        } catch {
          return true;
        }
      })
      .map((entry) => entry.path);
    return {
      ok: false as const,
      removed,
      absent,
      remaining,
      failedPath,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function main(args: string[]) {
  let root = process.env.AGENT_OPS_HOME ?? path.join(os.homedir(), ".agent-ops-kit");
  let mode = "preview";
  let manifestPath: string | undefined;
  let writersStopped = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (seen.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
    seen.add(arg);
    if ((arg === "preview" || arg === "apply") && index === 0) mode = arg;
    else if (arg === "--writers-stopped") writersStopped = true;
    else if (arg === "--root" || arg === "--manifest") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      if (arg === "--root") root = value;
      else manifestPath = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (mode === "preview") {
    if (manifestPath || writersStopped)
      throw new Error("Preview accepts only --root; redirect JSON to a file for review");
    process.stdout.write(`${JSON.stringify(previewRetirement(root), null, 2)}\n`);
  } else {
    if (!manifestPath || !writersStopped)
      throw new Error("Apply requires --manifest FILE --writers-stopped");
    const input: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const result = applyRetirement(root, input, writersStopped);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`
    );
    process.exitCode = 1;
  }
}
