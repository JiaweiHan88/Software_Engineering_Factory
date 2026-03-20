/**
 * Retry Utility — Unit Tests
 */

import { describe, it, expect, vi } from "vitest";
import { withRetry, isPaperclipRetryable } from "../src/adapter/retry.js";

describe("withRetry", () => {
  it("succeeds on first attempt without retrying", async () => {
    const fn = vi.fn().mockResolvedValueOnce("ok");

    const result = await withRetry(fn, { label: "test" });

    expect(result.value).toBe("ok");
    expect(result.attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds on second attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 10, // Fast for tests
      label: "test",
    });

    expect(result.value).toBe("ok");
    expect(result.attempts).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("exhausts all attempts and throws the last error", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"))
      .mockRejectedValueOnce(new Error("fail-3"));

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, label: "test" }),
    ).rejects.toThrow("fail-3");

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry when isRetryable returns false", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("fatal"));

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        label: "test",
        isRetryable: () => false,
      }),
    ).rejects.toThrow("fatal");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("tracks total elapsed time", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 50,
      label: "test",
    });

    expect(result.totalMs).toBeGreaterThanOrEqual(30); // At least some delay
    expect(result.attempts).toBe(2);
  });

  it("defaults to maxAttempts=3 when not specified", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("1"))
      .mockRejectedValueOnce(new Error("2"))
      .mockRejectedValueOnce(new Error("3"));

    await expect(
      withRetry(fn, { baseDelayMs: 10, label: "test" }),
    ).rejects.toThrow("3");

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("caps delay at maxDelayMs", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("1"))
      .mockRejectedValueOnce(new Error("2"))
      .mockRejectedValueOnce(new Error("3"))
      .mockResolvedValueOnce("ok");

    const start = Date.now();
    const result = await withRetry(fn, {
      maxAttempts: 4,
      baseDelayMs: 10,
      maxDelayMs: 25,
      label: "test",
    });
    const elapsed = Date.now() - start;

    expect(result.value).toBe("ok");
    expect(result.attempts).toBe(4);
    // 3 delays, each capped at ~25ms → total < 150ms (generous for CI)
    expect(elapsed).toBeLessThan(300);
  });
});

describe("isPaperclipRetryable", () => {
  it("returns true for 500 server errors", () => {
    const err = { statusCode: 500, message: "Internal" };
    expect(isPaperclipRetryable(err)).toBe(true);
  });

  it("returns true for 502 bad gateway", () => {
    const err = { statusCode: 502, message: "Bad Gateway" };
    expect(isPaperclipRetryable(err)).toBe(true);
  });

  it("returns true for 503 service unavailable", () => {
    const err = { statusCode: 503, message: "Unavailable" };
    expect(isPaperclipRetryable(err)).toBe(true);
  });

  it("returns true for 408 timeout", () => {
    const err = { statusCode: 408, message: "Timeout" };
    expect(isPaperclipRetryable(err)).toBe(true);
  });

  it("returns false for 400 bad request", () => {
    const err = { statusCode: 400, message: "Bad Request" };
    expect(isPaperclipRetryable(err)).toBe(false);
  });

  it("returns false for 401 unauthorized", () => {
    const err = { statusCode: 401, message: "Unauthorized" };
    expect(isPaperclipRetryable(err)).toBe(false);
  });

  it("returns false for 404 not found", () => {
    const err = { statusCode: 404, message: "Not Found" };
    expect(isPaperclipRetryable(err)).toBe(false);
  });

  it("returns true for fetch TypeErrors (network failures)", () => {
    const err = new TypeError("fetch failed");
    expect(isPaperclipRetryable(err)).toBe(true);
  });

  it("returns true for AbortError (timeouts)", () => {
    const err = new Error("Aborted");
    err.name = "AbortError";
    expect(isPaperclipRetryable(err)).toBe(true);
  });

  it("returns true for unknown errors (conservative)", () => {
    expect(isPaperclipRetryable(new Error("something unknown"))).toBe(true);
  });
});
