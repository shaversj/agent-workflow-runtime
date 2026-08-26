import pino, { type DestinationStream, type LoggerOptions } from "pino";

const redactPaths = [
  "api_key",
  "apiKey",
  "token",
  "secret",
  "password",
  "authorization",
  "headers.authorization",
  "env.MINIMAX_API_KEY",
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

interface CreateLoggerOptions {
  level?: string;
  format?: LogFormat;
  stream?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions = {}) {
  const loggerOptions: LoggerOptions = {
    level: options.level ?? defaultLogLevel(),
    redact: {
      paths: redactPaths,
      censor: "[REDACTED]"
    },
    timestamp: pino.stdTimeFunctions.isoTime
  };
  const format = options.format ?? logFormatFromEnv();
  const stream = format === "pretty" ? prettyLogStream(options.stream) : options.stream;
  return stream ? pino(loggerOptions, stream) : pino(loggerOptions);
}

export const logger = createLogger();

function logFormatFromEnv(): LogFormat {
  return process.env.LOG_FORMAT === "pretty" ? "pretty" : "json";
}

function defaultLogLevel(): string {
  return process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "warn");
}

function prettyLogStream(destination: DestinationStream = process.stdout): DestinationStream {
  return {
    write(message: string) {
      destination.write(formatPrettyLogLine(message));
    }
  };
}

function formatPrettyLogLine(message: string): string {
  try {
    const record = JSON.parse(message) as Record<string, unknown>;
    const level = levelName(record.level);
    const time = typeof record.time === "string" ? record.time : new Date().toISOString();
    const msg = typeof record.msg === "string" ? record.msg : "";
    const fields = Object.entries(record)
      .filter(([key]) => !["level", "time", "msg", "pid", "hostname"].includes(key))
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    return fields ? `${time} ${level} ${msg} ${fields}\n` : `${time} ${level} ${msg}\n`;
  } catch {
    return message.endsWith("\n") ? message : `${message}\n`;
  }
}

function levelName(level: unknown): string {
  if (level === 10) return "trace";
  if (level === 20) return "debug";
  if (level === 30) return "info";
  if (level === 40) return "warn";
  if (level === 50) return "error";
  if (level === 60) return "fatal";
  return "log";
}
