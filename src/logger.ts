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
    ignore: "pid,hostname",
    levelFirst: true,
    singleLine: false,
    sync: true,
    translateTime: "SYS:standard",
    ...(destination ? { destination: destinationToWritable(destination) } : {})
  });
}

function destinationToWritable(destination: DestinationStream): NodeJS.WritableStream {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      destination.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      callback();
    }
  });
}
