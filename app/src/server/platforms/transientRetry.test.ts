import { describe, expect, it, vi } from "vitest";

import { FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";

import { isTransientPublishError, withTransientRetries } from "./transientRetry";

function statusError(status: number): Error & { status: number } {
  const e = new Error(`failed (status ${status})`) as Error & { status: number };
  e.status = status;
  return e;
}

describe("isTransientPublishError", () => {
  it("treats 429 and 5xx platform responses as transient", () => {
    expect(isTransientPublishError(statusError(429))).toBe(true);
    expect(isTransientPublishError(statusError(500))).toBe(true);
    expect(isTransientPublishError(statusError(503))).toBe(true);
  });

  it("treats pre-response network failures (fetch TypeError) as transient", () => {
    expect(isTransientPublishError(new TypeError("fetch failed"))).toBe(true);
  });

  it("never retries timeouts — the request may have committed", () => {
    const e = new Error("Request timed out after 30000ms") as Error & { code: string };
    e.code = FETCH_TIMEOUT_CODE;
    expect(isTransientPublishError(e)).toBe(false);
  });

  it("never retries non-429 4xx (auth/validation) or token errors", () => {
    expect(isTransientPublishError(statusError(400))).toBe(false);
    expect(isTransientPublishError(statusError(401))).toBe(false);
    expect(isTransientPublishError(statusError(403))).toBe(false);
    const tokenErr = new Error("refresh failed") as Error & { code: string };
    tokenErr.code = "GOOGLE_TOKEN_REFRESH_FAILED";
    expect(isTransientPublishError(tokenErr)).toBe(false);
  });

  it("does not retry unknown plain errors", () => {
    expect(isTransientPublishError(new Error("something else"))).toBe(false);
    expect(isTransientPublishError(undefined)).toBe(false);
  });
});

describe("withTransientRetries", () => {
  it("returns the first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withTransientRetries(fn, { sleep: async () => {} })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(statusError(503))
      .mockResolvedValueOnce("ok");
    await expect(withTransientRetries(fn, { sleep: async () => {} })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 total attempts and rethrows the LAST error", async () => {
    const fn = vi.fn().mockRejectedValue(statusError(502));
    await expect(withTransientRetries(fn, { sleep: async () => {} })).rejects.toMatchObject({
      status: 502,
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rethrows a non-transient failure immediately", async () => {
    const fn = vi.fn().mockRejectedValue(statusError(401));
    await expect(withTransientRetries(fn, { sleep: async () => {} })).rejects.toMatchObject({
      status: 401,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("backs off between attempts (2s then 8s)", async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(statusError(500));
    await withTransientRetries(fn, { sleep: async (ms) => { delays.push(ms); } }).catch(() => {});
    expect(delays).toEqual([2000, 8000]);
  });
});
