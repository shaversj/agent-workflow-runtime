import path from "node:path";
import { Writable } from "node:stream";

import pino, { type DestinationStream, type LoggerOptions } from "pino";
import pinoPretty from "pino-pretty";

const redactPaths = [
  "api_key",
  "apiKey",
  "token",
  "secret",
  "password",
  "authorization",
  "headers.authorization",
  "env.MINIMAX_API_KEY",
  "env.DISCORD_BOT_TOKEN",
  "args.api_key",
  "args.apiKey",
  "args.token",
  "args.secret",
  "args.password",
  "result.api_key",
  "result.apiKey",
  "result.token",
  "result.secret",
  "result.password"
];

type LogFormat = "json" | "pretty";
type PrettyLogRecord = Record<string, unknown>;

interface CreateLoggerOptions {
  level?: string;
  format?: LogFormat;
  stream?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions = {}) {
  const loggerOptions: LoggerOptions = {
    level: options.level ?? defaultLogLevel(),
    serializers: {
      // External failures must arrive as a safe projection, never as a throwable.
      err: () => "[UNPROJECTED_ERROR_OMITTED]"
    },
    redact: {
      paths: redactPaths,
      censor: "[REDACTED]"
    },
    timestamp: pino.stdTimeFunctions.isoTime
  };
  const format = options.format ?? logFormatFromEnv();
  const stream = format === "pretty" ? pinoPrettyStream(options.stream) : options.stream;
  return stream ? pino(loggerOptions, stream) : pino(loggerOptions);
}

export const logger = createLogger();

function logFormatFromEnv(): LogFormat {
  return process.env.LOG_FORMAT === "pretty" ? "pretty" : "json";
}

function defaultLogLevel(): string {
  return process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "warn");
}

function pinoPrettyStream(destination?: DestinationStream): DestinationStream {
  return pinoPretty({
    colorize: process.stdout.isTTY && process.env.NO_COLOR !== "1",
    errorProps: "stack,message,code",
    ignore:
      "pid,hostname,workflow_name,interaction_id,run_id,harness_provider,model_runtime,model_provider,model,status,repo_name,target_path,target_url,workspace_source,workspace_path,workspace_ref,workspace_commit_sha,report_path,timeout_ms,duration_ms,file_count,token_count,tool_call_count,benchmark_status,cache_age_ms,failure_type",
    levelFirst: true,
    messageFormat: prettyMessageFormat,
    singleLine: false,
    sync: true,
    translateTime: "SYS:standard",
    ...(destination ? { destination: destinationToWritable(destination) } : {})
  });
}

function prettyMessageFormat(log: PrettyLogRecord, messageKey: string): string {
  const message = primitiveLogValue(log[messageKey]) ?? "";
  const context = [
    formatContextValue("run", log.run_id),
    formatContextValue("interaction", log.interaction_id),
    formatContextValue("repo", log.repo_name),
    formatPathBasenameValue("target", log.target_path ?? log.target_url),
    formatContextValue("source", log.workspace_source),
    formatContextValue("model", log.model),
    formatContextValue("status", log.status),
    formatContextValue("benchmark", log.benchmark_status),
    formatContextValue("failure", log.failure_type),
    formatContextValue("sha", shortSha(log.workspace_commit_sha)),
    formatContextValue("files", log.file_count),
    formatContextValue("tokens", log.token_count),
    formatContextValue("tools", log.tool_call_count),
    formatDurationValue("timeout", log.timeout_ms),
    formatDurationValue("duration", log.duration_ms),
    formatDurationValue("cache_age", log.cache_age_ms),
    formatPathBasenameValue("report", log.report_path)
  ].filter(Boolean);
  return context.length ? `${message} ${context.join(" ")}` : message;
}

function formatContextValue(label: string, value: unknown): string | undefined {
  const rendered = primitiveLogValue(value);
  return rendered ? `${label}=${rendered}` : undefined;
}

function primitiveLogValue(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  return undefined;
}

function shortSha(value: unknown): string | undefined {
  const rendered = primitiveLogValue(value);
  return rendered ? rendered.slice(0, 12) : undefined;
}

function formatDurationValue(label: string, value: unknown): string | undefined {
  const rendered = primitiveLogValue(value);
  return rendered ? `${label}=${rendered}ms` : undefined;
}

function formatPathBasenameValue(label: string, value: unknown): string | undefined {
  const rendered = primitiveLogValue(value);
  return rendered ? `${label}=${path.basename(rendered)}` : undefined;
}

function destinationToWritable(destination: DestinationStream): NodeJS.WritableStream {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      destination.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      callback();
    }
  });
}
