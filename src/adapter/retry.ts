/**
 * Retry Utility — Exponential Backoff with Jitter
 *
 * Provides a generic retry wrapper for async operations with:
 * - Configurable max attempts, base delay, and max delay
 * - Exponential backoff with ±25% jitter to prevent thundering herd
 * - Optional predicate to decide which errors are retryable
 * - Structured logging of each retry attempt
 *
 * @module adapter/retry
 */

import { Logger } from "../observability/logger.js";

const log = Logger.child("retry");

/**
 * Options for the retry wrapper.
 */
export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Base delay in ms before first retry. Default: 1000 */
  baseDelayMs?: number;
  /** Maximum delay in ms (caps exponential growth). Default: 30000 */
  maxDelayMs?: number;
  /** Label for log messages. Default: "operation" */
  label?: string;
  /**
   * Predicate: should we retry this error?
   * Return `true` to retry, `false` to fail immediately.
   * Default: retry all errors.
   */
  isRetryable?: (err: unknown) => boolean;
}

/**
 * Result of a retry-wrapped operation.
 */
export interface RetryResult<T> {
  /** The result value (if succeeded) */
  value: T;
  /** How many attempts it took (1 = first try succeeded) */
  attempts: number;
  /** Total time spent across all attempts (ms) */
  totalMs: number;
}

/**
 * Execute an async operation with exponential backoff retry.
 *
 * @param fn - The async function to execute
 * @param opts - Retry configuration
 * @returns The result wrapped with attempt metadata
 * @throws The last error if all attempts fail
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => paperclipClient.getAgentInbox(),
 *   { maxAttempts: 3, label: "inbox-fetch" },
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<RetryResult<T>> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1_000,
    maxDelayMs = 30_000,
    label = "operation",
    isRetryable = () => true,
  } = opts;

  const startTime = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await fn();
      const totalMs = Date.now() - startTime;

      if (attempt > 1) {
        log.info("Retry succeeded", { label, attempt, totalMs });
      }

      return { value, attempts: attempt, totalMs };
    } catch (err) {
      lastError = err;

      // Check if this error is retryable
      if (!isRetryable(err)) {
        log.warn("Non-retryable error, failing immediately", {
          label,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      if (attempt < maxAttempts) {
        // Exponential backoff: baseDelay * 2^(attempt-1) with ±25% jitter
        const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
        const capped = Math.min(exponentialDelay, maxDelayMs);
        const jitter = capped * (0.75 + Math.random() * 0.5); // ±25%
        const delayMs = Math.round(jitter);

        log.warn("Retrying after error", {
          label,
          attempt,
          maxAttempts,
          delayMs,
          error: err instanceof Error ? err.message : String(err),
        });

        await sleep(delayMs);
      }
    }
  }

  const totalMs = Date.now() - startTime;
  log.error("All retry attempts exhausted", {
    label,
    maxAttempts,
    totalMs,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });

  throw lastError;
}

/**
 * Check if a Paperclip API error is retryable.
 *
 * Retryable:
 * - 500 Internal Server Error (transient DB/FK failures)
 * - 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout
 * - Network errors (fetch failures, timeouts)
 *
 * Not retryable:
 * - 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 409 Conflict
 */
export function isPaperclipRetryable(err: unknown): boolean {
  // Network errors (fetch failed, DNS, connection refused) — retryable
  if (err instanceof TypeError && err.message.includes("fetch")) {
    return true;
  }

  // PaperclipApiError — check status code
  if (err && typeof err === "object" && "statusCode" in err) {
    const status = (err as { statusCode: number }).statusCode;
    return status >= 500 || status === 408; // server errors + timeout
  }

  // AbortError (timeout) — retryable
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }

  // Unknown errors — retryable (conservative: better to retry than lose work)
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
