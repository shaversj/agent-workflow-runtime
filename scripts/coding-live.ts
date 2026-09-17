import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

import { Type } from "typebox";
import type { Static } from "typebox";

import { openHistoryReader } from "../src/db/index.js";
import { beginInteraction } from "../src/harness/interaction.js";
import { redactApplicationText } from "../src/harness/redaction.js";
import {
  CodingPolicySchema,
  codingProfile,
  loadCodingPolicy
} from "../src/plugins/coding/config.js";
import {
  CodingJobSchema,
  CodingProposalSchema,
  CodingTaskSchema,
  parseCoding
} from "../src/plugins/coding/schemas.js";
import type { CodingJob } from "../src/plugins/coding/schemas.js";
import { prepareCoding } from "../src/workflows/code.js";
import { inspectCoding } from "../src/workflows/coding-approval.js";
import { DockerWorker } from "../src/workspaces/docker.js";

const objectOptions = { additionalProperties: false };
const timestamp = CodingJobSchema.properties.createdAt;
const identity = CodingJobSchema.properties.id;
const boundary = Type.Union([
  Type.Literal("live"),
  Type.Literal("simulated"),
  Type.Literal("not-run")
]);
const LiveArgsSchema = Type.Object(
  {
    config: Type.String({ minLength: 1 }),
    envFile: Type.Optional(Type.String({ minLength: 1 }))
  },
  objectOptions
);
const LiveInputSchema = Type.Object(
  {
    scenario: Type.Literal("prepare"),
    authorization: Type.Object(
      {
        repository: CodingTaskSchema.properties.repository,
        baseBranch: CodingTaskSchema.properties.baseBranch,
        principal: Type.String({ pattern: "^cli:[0-9]+$" }),
        permittedWrites: Type.Array(Type.String(), { maxItems: 0 })
      },
      objectOptions
    ),
    task: CodingTaskSchema.properties.task,
    limits: Type.Object(
      {
        timeoutMs: CodingPolicySchema.properties.timeoutMs,
        maxModelCalls: CodingPolicySchema.properties.maxModelCalls,
        maxTokens: CodingPolicySchema.properties.maxTokens
      },
      objectOptions
    )
  },
  objectOptions
);

export const LiveReceiptSchema = Type.Object(
  {
    version: Type.Literal(1),
    scenario: Type.Literal("prepare"),
    repository: CodingTaskSchema.properties.repository,
    baseBranch: CodingTaskSchema.properties.baseBranch,
    principal: Type.String({ pattern: "^cli:[0-9]+$" }),
    model: CodingPolicySchema.properties.model,
    limits: LiveInputSchema.properties.limits,
    image: Type.String({ maxLength: 512 }),
    startedAt: timestamp,
    finishedAt: Type.Optional(timestamp),
    status: Type.Union([
      Type.Literal("running"),
      Type.Literal("proposal-ready"),
      Type.Literal("blocked"),
      Type.Literal("failed"),
      Type.Literal("interrupted")
    ]),
    boundaries: Type.Object(
      { source: boundary, model: boundary, worker: boundary, publication: Type.Literal("not-run") },
      objectOptions
    ),
    interactionId: Type.Optional(identity),
    runId: Type.Optional(Type.Integer({ minimum: 1 })),
    jobId: Type.Optional(identity),
    preparationRunId: Type.Optional(Type.Integer({ minimum: 1 })),
    baseCommit: Type.Optional(CodingJobSchema.properties.baseCommit),
    digest: Type.Optional(CodingProposalSchema.properties.digest),
    checks: Type.Array(
      Type.Object(
        {
          command: Type.String({ maxLength: 2048 }),
          exitCode: Type.Integer(),
          truncated: Type.Boolean()
        },
        objectOptions
      ),
      { maxItems: 10 }
    ),
    modelCalls: Type.Integer({ minimum: 0, maximum: 30 }),
    totalTokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    publicationWrites: Type.Literal(0),
    remoteResources: Type.Array(Type.String(), { maxItems: 0 }),
    cleanup: Type.Union([
      Type.Literal("not-started"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("simulated")
    ]),
    reason: Type.Optional(Type.String({ pattern: "^coding_[a-z_]+$", maxLength: 128 }))
  },
  objectOptions
);
type LiveReceipt = Static<typeof LiveReceiptSchema>;

class LiveStorageFailure extends Error {
  constructor(
    readonly home: string,
    readonly receiptPath: string
  ) {
    super("coding_live_storage_failed");
  }
}

function recordedUsage(home: string, interactionId: string) {
  const reader = openHistoryReader({ home });
  if (!reader) throw new Error("coding_live_history_missing");
  try {
    const calls = reader
      .listRuns(interactionId, 50)
      .flatMap((run) => reader.listModelCalls(run.id, 50));
    return {
      modelCalls: calls.length,
      totalTokens: calls.every((call) => call.usageState === "known")
        ? calls.reduce((sum, call) => sum + (call.totalTokens ?? 0), 0)
        : null
    };
  } finally {
    reader.close();
  }
}

export function preflightCodingLive(value: unknown, env: NodeJS.ProcessEnv) {
  const input = parseCoding(LiveInputSchema, value);
  if (input.authorization.principal !== `cli:${process.getuid?.() ?? "unsupported"}`)
    throw new Error("coding_live_principal_denied");
  // Preparation never loads a write credential or inherits publication authority.
  const readEnv: NodeJS.ProcessEnv = {};
  for (const key of [
    "CODING_ENABLED",
    "CODING_ALLOWED_PRINCIPALS",
    "CODING_PROFILES",
    "CODING_MODEL",
    "CODING_TIMEOUT_MS",
    "CODING_MAX_MODEL_CALLS",
    "CODING_MAX_TOKENS",
    "CODING_PROPOSAL_RETENTION_MS",
    "CODING_GITHUB_READ_TOKEN"
  ])
    readEnv[key] = env[key];
  const policy = loadCodingPolicy(readEnv);
  const profile = codingProfile(
    policy,
    input.authorization.principal,
    input.authorization.repository
  );
  if (!policy.readToken || !env.MINIMAX_API_KEY) throw new Error("coding_live_credentials_missing");
  policy.timeoutMs = Math.min(policy.timeoutMs, input.limits.timeoutMs);
  policy.maxModelCalls = Math.min(policy.maxModelCalls, input.limits.maxModelCalls);
  policy.maxTokens = Math.min(policy.maxTokens, input.limits.maxTokens);
  return { input, policy, profile };
}

type LiveDependencies = Parameters<typeof prepareCoding>[4] & {
  root?: string;
  signal?: AbortSignal;
};
export async function runCodingLive(
  value: unknown,
  env: NodeJS.ProcessEnv,
  dependencies: LiveDependencies = {}
) {
  const { input, policy, profile } = preflightCodingLive(value, env);
  let home: string, descriptor: number;
  try {
    home = fs.mkdtempSync(path.join(dependencies.root ?? os.tmpdir(), "agent-ops-coding-live-"));
    fs.chmodSync(home, 0o700);
    descriptor = fs.openSync(path.join(home, "receipt.json"), "wx", 0o600);
  } catch {
    throw new Error("coding_live_storage_failed");
  }
  const receiptPath = path.join(home, "receipt.json");
  const receipt: LiveReceipt = {
    version: 1,
    scenario: "prepare",
    repository: input.authorization.repository,
    baseBranch: input.authorization.baseBranch,
    principal: input.authorization.principal,
    model: policy.model,
    limits: {
      timeoutMs: policy.timeoutMs,
      maxModelCalls: policy.maxModelCalls,
      maxTokens: policy.maxTokens
    },
    image: profile.image,
    startedAt: new Date().toISOString(),
    status: "running",
    boundaries: {
      source: "not-run",
      model: "not-run",
      worker: "not-run",
      publication: "not-run"
    },
    checks: [],
    modelCalls: 0,
    totalTokens: 0,
    publicationWrites: 0,
    remoteResources: [],
    cleanup: "not-started"
  };
  const save = () => {
    try {
      const safe = parseCoding(
        LiveReceiptSchema,
        JSON.parse(
          JSON.stringify(parseCoding(LiveReceiptSchema, receipt), (_key, value: unknown) =>
            typeof value === "string"
              ? redactApplicationText(value, [policy.readToken!, env.MINIMAX_API_KEY!])
              : value
          )
        )
      );
      const bytes = Buffer.from(JSON.stringify(safe, null, 2) + "\n");
      if (bytes.length > 32768) throw new Error("receipt_limit");
      if (fs.writeSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length)
        throw new Error("receipt_short_write");
      fs.ftruncateSync(descriptor, bytes.length);
      fs.fsyncSync(descriptor);
      return safe;
    } catch {
      throw new LiveStorageFailure(home, receiptPath);
    }
  };
  const controller = new AbortController();
  let recording: ReturnType<typeof beginInteraction> | undefined, job: CodingJob | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    save();
    timer = setTimeout(() => controller.abort(new Error("coding_live_timeout")), policy.timeoutMs);
    const signal = dependencies.signal
      ? AbortSignal.any([controller.signal, dependencies.signal])
      : controller.signal;
    recording = beginInteraction(
      {
        source: "cli",
        kind: "coding_live_prepare",
        userMessage: "Explicit live coding validation",
        target: input.authorization.repository,
        metadata: { principal: input.authorization.principal }
      },
      { home, signal }
    );
    receipt.interactionId = recording.interactionId;
    receipt.runId = recording.runId;
    receipt.boundaries.source = dependencies.source ? "simulated" : "live";
    save();
    job = await prepareCoding(
      {
        repository: input.authorization.repository,
        baseBranch: input.authorization.baseBranch,
        task: input.task
      },
      input.authorization.principal,
      policy,
      recording,
      {
        ...dependencies,
        worker: async (...args) => {
          receipt.boundaries.worker = dependencies.worker ? "simulated" : "live";
          save();
          return (dependencies.worker ?? DockerWorker.start)(...args);
        },
        runtime: async (...args) => {
          receipt.boundaries.model = dependencies.runtime ? "simulated" : "live";
          save();
          const runtime =
            dependencies.runtime ??
            (await import("../src/harness/coding-runtime.js")).runIsolatedCoding;
          return runtime(...args);
        },
        onJob: async (next) => {
          job = next;
          receipt.jobId = next.id;
          receipt.preparationRunId = next.runId;
          receipt.baseCommit = next.baseCommit;
          save();
          await dependencies.onJob?.(next);
        }
      }
    );
    const proposal = inspectCoding(
      job.id,
      input.authorization.principal,
      policy,
      recording
    ).proposal;
    if (proposal) {
      receipt.digest = proposal.digest;
      receipt.checks = proposal.checks.map(({ command, exitCode, truncated }) => ({
        command,
        exitCode,
        truncated
      }));
    }
    receipt.status = job.status === "proposal-ready" ? "proposal-ready" : "blocked";
  } catch {
    receipt.status =
      controller.signal.aborted || dependencies.signal?.aborted ? "interrupted" : "failed";
    receipt.reason = "coding_live_scenario_failed";
  } finally {
    if (timer) clearTimeout(timer);
    try {
      if (job && receipt.boundaries.worker !== "not-run") {
        if (dependencies.worker) receipt.cleanup = "simulated";
        else {
          await DockerWorker.cleanupJob(job.id);
          receipt.cleanup = "completed";
        }
      }
    } catch {
      receipt.cleanup = "failed";
      receipt.status = "failed";
      receipt.reason = "coding_live_cleanup_failed";
    }
    try {
      if (receipt.interactionId) {
        Object.assign(receipt, recordedUsage(home, receipt.interactionId));
        if (
          receipt.status === "proposal-ready" &&
          (receipt.totalTokens === null || receipt.modelCalls === 0)
        ) {
          receipt.status = "failed";
          receipt.reason = "coding_live_evidence_incomplete";
        }
      }
    } catch {
      receipt.status = "failed";
      receipt.reason = "coding_live_evidence_incomplete";
      receipt.totalTokens = null;
    }
    try {
      if (recording) {
        const status =
          receipt.status === "proposal-ready"
            ? "completed"
            : receipt.status === "interrupted"
              ? "cancelled"
              : "failed";
        const finish = {
          status,
          ...(receipt.reason ? { error: receipt.reason } : {})
        } as const;
        recording.finishRun(finish);
        recording.finishInteraction(finish);
      }
    } catch {
      receipt.status = "failed";
      receipt.reason = "coding_live_recording_failed";
    } finally {
      recording?.close();
    }
    receipt.finishedAt = new Date().toISOString();
    try {
      Object.assign(receipt, save());
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return { home, receiptPath, receipt };
}

export function parseLiveArgs(args: string[]) {
  const clean = args[0] === "--" ? args.slice(1) : args;
  const values: Record<string, string> = {};
  for (let index = 0; index < clean.length; index += 2) {
    const flag = clean[index],
      value = clean[index + 1];
    if (
      !flag ||
      !["--config", "--env-file"].includes(flag) ||
      !value ||
      value.startsWith("--") ||
      values[flag]
    )
      throw new Error("coding_live_arguments_invalid");
    values[flag] = value;
  }
  if (!values["--config"]) throw new Error("coding_live_config_required");
  return parseCoding(LiveArgsSchema, {
    config: values["--config"],
    ...(values["--env-file"] ? { envFile: values["--env-file"] } : {})
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("coding_live_interrupted"));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const args = parseLiveArgs(process.argv.slice(2));
    const stat = fs.statSync(args.config);
    if (stat.size > 32768 || !stat.isFile()) throw new Error("coding_live_config_invalid");
    const input = parseCoding(LiveInputSchema, JSON.parse(fs.readFileSync(args.config, "utf8")));
    if (input.authorization.principal !== `cli:${process.getuid?.() ?? "unsupported"}`)
      throw new Error("coding_live_principal_denied");
    const fileEnv = args.envFile ? parseEnv(fs.readFileSync(args.envFile, "utf8")) : {};
    const env = { ...fileEnv, ...process.env };
    preflightCodingLive(input, env);
    // Only selected read/model credentials become available to SDK configuration/redaction.
    process.env.MINIMAX_API_KEY = env.MINIMAX_API_KEY;
    process.env.CODING_GITHUB_READ_TOKEN = env.CODING_GITHUB_READ_TOKEN;
    const result = await runCodingLive(input, env, { signal: controller.signal });
    console.log(
      `Coding live validation: ${result.receipt.status}\nPrivate history: ${result.home}\nReceipt: ${result.receiptPath}`
    );
    if (result.receipt.status !== "proposal-ready") process.exitCode = 1;
  } catch (error) {
    const reason =
      error instanceof Error && /^(?:coding_[a-z_]+|invalid_coding_contract)$/.test(error.message)
        ? error.message
        : "coding_live_refused_or_failed";
    console.error(
      `${reason}: inspect explicit config, scoped credentials, profile and retained receipts`
    );
    if (error instanceof LiveStorageFailure)
      console.error(`Retained history: ${error.home}\nReceipt: ${error.receiptPath}`);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
