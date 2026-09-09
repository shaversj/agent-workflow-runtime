export async function withWorkflowTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          try {
            onTimeout();
          } catch {
            logger.warn({}, "workflow_timeout.cleanup_failed");
          }
          reject(new Error(`workflow_timeout:${timeoutMs}`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
import { logger } from "../logger.js";

export function combineAbortSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const available = [...new Set(signals.filter((signal): signal is AbortSignal => !!signal))];
  return available.length > 1 ? AbortSignal.any(available) : available[0];
}
