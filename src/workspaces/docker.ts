import { spawn } from "node:child_process";
import crypto from "node:crypto";

import { Type } from "typebox";

import { parseCoding, SourceFileSchema, VerificationSchema } from "../plugins/coding/schemas.js";
import type { SourceFile } from "../plugins/coding/schemas.js";
import { logger } from "../logger.js";
import { parseProfile } from "./execution.js";
import type { CodingProfile } from "./execution.js";

const workerOwner = crypto.randomUUID();
const activeWorkers = new Set<DockerWorker>();

// Trusted worker protocol. Repository code and paths never become host command strings.
const fileProtocol = String.raw`
const fs = require('node:fs'), path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const root = '/workspace';
function checked(name) {
  const full = path.resolve(root, name);
  if (full !== root && !full.startsWith(root + '/')) throw Error('path_denied');
  let current = root;
  for (const part of path.relative(root, full).split('/').filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('link_denied');
  }
  return full;
}
const files = []; let size = 0;
function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (input.ignore.includes(name)) continue;
    const full = path.join(dir, name), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw Error('entry_denied');
    if (stat.isDirectory()) { walk(full); continue; }
    size += stat.size;
    if (size > 32 * 1024 * 1024 || files.length >= 10000) throw Error('snapshot_limit');
    const bytes = fs.readFileSync(full);
    if (bytes.includes(0) || Buffer.from(bytes.toString('utf8')).compare(bytes) !== 0) throw Error('binary_denied');
    files.push({path: path.relative(root, full), content: bytes.toString('utf8'), mode: stat.mode & 0o111 ? '100755' : '100644'});
  }
}
let result;
switch (input.op) {
 case 'import':
   for (const file of input.files) {
     const full = checked(file.path); fs.mkdirSync(path.dirname(full), {recursive:true});
     fs.writeFileSync(full, file.content, {mode:file.mode === '100755' ? 0o755 : 0o644});
   } result = true; break;
 case 'snapshot': walk(root); result = files; break;
 case 'read': {
   const bytes = fs.readFileSync(checked(input.path));
   if (bytes.length > 1024 * 1024 || bytes.includes(0)) throw Error('read_limit');
   result = bytes.toString('utf8'); break;
 }
 case 'write': { const full = checked(input.path); fs.mkdirSync(path.dirname(full), {recursive:true});
   fs.writeFileSync(full, input.content); result = true; break; }
 case 'access': fs.accessSync(checked(input.path)); result = true; break;
 case 'mkdir': fs.mkdirSync(checked(input.path), {recursive:true}); result = true; break;
 default: throw Error('operation_denied');
}
process.stdout.write(JSON.stringify(result));
`;

export class DockerWorker {
  private closed = false;
  private closing?: Promise<void>;
  private constructor(
    readonly id: string,
    readonly profile: CodingProfile,
    private readonly lifetime?: AbortSignal,
    private readonly verification = false
  ) {}
  static async start(
    this: void,
    input: CodingProfile,
    signal?: AbortSignal,
    jobId?: string,
    verification = false
  ): Promise<DockerWorker> {
    const profile = parseProfile(input);
    if (jobId && !/^[a-zA-Z0-9-]{1,128}$/.test(jobId)) throw new Error("coding_job_id_invalid");
    const worker = new DockerWorker(
      `agent-ops-coding-${crypto.randomUUID()}`,
      profile,
      signal,
      verification
    );
    try {
      const security = await worker.docker(["info", "--format", "{{json .SecurityOptions}}"]);
      const options = parseCoding(Type.Array(Type.String()), JSON.parse(security.output));
      if (
        !options.some(
          (option) => option.includes("name=seccomp") && option.includes("profile=builtin")
        )
      )
        throw new Error("coding_seccomp_unavailable");
      const created = await worker.docker([
        "create",
        "--pull=never",
        "--name",
        worker.id,
        "--label",
        "agent-ops.coding=true",
        "--label",
        `agent-ops.owner=${workerOwner}`,
        ...(jobId ? ["--label", `agent-ops.job=${jobId}`] : []),
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user=1000:1000",
        "--cpus=2",
        "--memory=2g",
        "--memory-swap=2g",
        "--pids-limit=128",
        "--tmpfs",
        verification
          ? "/workspace:rw,nosuid,nodev,size=1g,uid=0,gid=0,mode=0755"
          : "/workspace:rw,nosuid,nodev,size=1g,uid=1000,gid=1000,mode=0700",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=0700",
        "--workdir=/workspace",
        "--env=HOME=/tmp",
        "--env=NODE_ENV=test",
        "--entrypoint=node",
        profile.image,
        "-e",
        "setInterval(()=>{},1000000)"
      ]);
      if (created.exitCode !== 0) throw new Error("coding_worker_unavailable");
      const started = await worker.docker(["start", worker.id]);
      if (started.exitCode !== 0) throw new Error("coding_worker_unavailable");
      activeWorkers.add(worker);
      logger.info({ worker_id: worker.id }, "coding.worker_started");
      return worker;
    } catch {
      await worker.close();
      throw new Error("coding_worker_unavailable");
    }
  }
  private docker(
    args: string[],
    input?: string,
    signal?: AbortSignal,
    timeoutMs = 120000,
    limit = 65536
  ) {
    signal = args[0] === "rm" ? undefined : (signal ?? this.lifetime);
    if (this.closed && args[0] !== "rm") return Promise.reject(new Error("coding_worker_closed"));
    if (signal?.aborted) return Promise.reject(new Error("workflow_aborted"));
    return new Promise<{ exitCode: number; output: string; truncated: boolean }>(
      (resolve, reject) => {
        const child = spawn("docker", args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            DOCKER_HOST: process.env.DOCKER_HOST,
            DOCKER_CONTEXT: process.env.DOCKER_CONTEXT
          }
        });
        let output = Buffer.alloc(0),
          truncated = false,
          failure: Error | undefined;
        const append = (bytes: Buffer) => {
          const remaining = limit - output.length;
          if (bytes.length > remaining) truncated = true;
          if (remaining > 0) output = Buffer.concat([output, bytes.subarray(0, remaining)]);
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const cleanup = () => {
          void this.close().catch(() => {
            logger.error({ worker_id: this.id }, "coding.worker_cleanup_failed");
          });
        };
        const abort = () => {
          failure = new Error("workflow_aborted");
          child.kill("SIGKILL");
          cleanup();
        };
        const timer = setTimeout(() => {
          failure = new Error("coding_command_timeout");
          child.kill("SIGKILL");
          cleanup();
        }, timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        child.on("error", () => {
          failure = new Error("coding_docker_failed");
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (failure) reject(failure);
          else resolve({ exitCode: code ?? -1, output: output.toString("utf8"), truncated });
        });
        child.stdin.on("error", () => {
          /* Worker may reject input before consuming it. */
        });
        child.stdin.end(input);
      }
    );
  }
  async rpc(
    op: "read" | "write" | "access" | "mkdir",
    filePath: string,
    content?: string,
    signal?: AbortSignal
  ): Promise<string | boolean> {
    const result = await this.docker(
      ["exec", "-i", this.id, "node", "-e", fileProtocol],
      JSON.stringify({ op, path: filePath, content }),
      signal,
      120000,
      2 * 1024 * 1024
    );
    if (result.exitCode !== 0 || result.truncated) throw new Error("coding_file_operation_failed");
    return parseCoding(Type.Union([Type.String(), Type.Boolean()]), JSON.parse(result.output));
  }
  async importFiles(files: SourceFile[]): Promise<void> {
    parseCoding(Type.Array(SourceFileSchema), files);
    const paths = new Set<string>();
    let bytes = 0;
    for (const file of files) {
      if (
        file.path.startsWith("/") ||
        file.path.split("/").some((part) => ["", ".", ".."].includes(part)) ||
        file.path.includes("\\") ||
        paths.has(file.path)
      )
        throw new Error("coding_source_path_denied");
      paths.add(file.path);
      bytes += Buffer.byteLength(file.content);
    }
    if (bytes > 32 * 1024 * 1024 || files.length > 10000) throw new Error("coding_source_limit");
    const result = await this.docker(
      [
        "exec",
        "-i",
        ...(this.verification ? ["--user=0"] : []),
        this.id,
        "node",
        "-e",
        fileProtocol
      ],
      JSON.stringify({ op: "import", files })
    );
    if (result.exitCode !== 0) throw new Error("coding_import_failed");
  }
  async snapshot(): Promise<SourceFile[]> {
    const result = await this.docker(
      ["exec", "-i", this.id, "node", "-e", fileProtocol],
      JSON.stringify({
        op: "snapshot",
        ignore: [...new Set([".git", "node_modules", ...this.profile.ignore])]
      }),
      undefined,
      120000,
      64 * 1024 * 1024
    );
    if (result.exitCode !== 0 || result.truncated) throw new Error("coding_snapshot_failed");
    return parseCoding(Type.Array(SourceFileSchema), JSON.parse(result.output));
  }
  async freeze(): Promise<void> {
    if (!this.verification) throw new Error("coding_verification_worker_required");
    const script =
      "const fs=require('node:fs'),p=require('node:path'); function seal(path){const s=fs.lstatSync(path);if(s.isSymbolicLink()||s.uid!==0)throw Error('entry');if(s.isDirectory())for(const n of fs.readdirSync(path))seal(p.join(path,n));fs.chmodSync(path,s.isDirectory()||s.mode&0o111?0o555:0o444)}seal('/workspace');";
    const result = await this.docker(["exec", "--user=0", this.id, "node", "-e", script]);
    if (result.exitCode !== 0) throw new Error("coding_freeze_failed");
  }
  static async cleanupJob(this: void, jobId: string): Promise<void> {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(jobId)) throw new Error("coding_job_id_invalid");
    const worker = new DockerWorker("agent-ops-cleanup", {
      image: "unused",
      requiredChecks: [],
      ignore: [],
      principal: "unused"
    });
    const result = await worker.docker([
      "ps",
      "--all",
      "--filter=label=agent-ops.coding=true",
      `--filter=label=agent-ops.job=${jobId}`,
      "--format={{.ID}}"
    ]);
    if (result.exitCode !== 0) throw new Error("coding_worker_cleanup_failed");
    const ids = result.output.trim().split("\n").filter(Boolean);
    if (ids.length > 16 || ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id)))
      throw new Error("coding_worker_cleanup_failed");
    for (const id of ids) {
      const removed = await worker.docker(["rm", "--force", id]);
      if (removed.exitCode !== 0) throw new Error("coding_worker_cleanup_failed");
    }
  }
  static async closeOwnedWorkers(this: void): Promise<void> {
    const results = await Promise.allSettled([...activeWorkers].map((worker) => worker.close()));
    if (results.some((result) => result.status === "rejected"))
      throw new Error("coding_worker_cleanup_failed");
  }
  static async forceCleanupOwnedWorkers(this: void): Promise<void> {
    const worker = new DockerWorker("agent-ops-cleanup", {
      image: "unused",
      requiredChecks: [],
      ignore: [],
      principal: "unused"
    });
    const result = await worker.docker([
      "ps",
      "--all",
      "--filter=label=agent-ops.coding=true",
      `--filter=label=agent-ops.owner=${workerOwner}`,
      "--format={{.ID}}"
    ]);
    if (result.exitCode !== 0) throw new Error("coding_worker_cleanup_failed");
    const ids = result.output.trim().split("\n").filter(Boolean);
    if (ids.length > 16 || ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id)))
      throw new Error("coding_worker_cleanup_failed");
    for (const id of ids) {
      const removed = await worker.docker(["rm", "--force", id]);
      if (removed.exitCode !== 0) throw new Error("coding_worker_cleanup_failed");
    }
    activeWorkers.clear();
  }
  async command(command: string, signal?: AbortSignal, timeoutMs = 120000) {
    const result = await this.docker(
      ["exec", this.id, "/bin/sh", "-c", command],
      undefined,
      signal,
      Math.min(Math.max(1, timeoutMs), 120000)
    );
    return parseCoding(VerificationSchema, { command, ...result });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.docker(["rm", "--force", this.id], undefined, undefined, 10000)
      .then((result) => {
        if (result.exitCode !== 0 && !result.output.includes("No such container"))
          throw new Error("coding_worker_cleanup_failed");
        logger.info({ worker_id: this.id }, "coding.worker_removed");
      })
      .finally(() => activeWorkers.delete(this));
    return this.closing;
  }
}
