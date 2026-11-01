import { describe, expect, it, vi } from "vitest";

import { FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";

import { isTransientPublishError, withTransientRetries } from "./transientRetry";

/** Node fetch's network failure: `TypeError("fetch failed")` with a coded cause. */
function fetchFailed(code: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

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

  // 2026-11-01 audit (Task 4 item 4): Node's fetch rejects with the SAME
  // `TypeError("fetch failed")` whether the connection was never made or it
  // died after the platform already received (and maybe committed) the
  // request. Only a `cause.code` proving the connection was never
  // established is safe to retry; anything else could double-post.
  it.each([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
  ])("treats a fetch failure caused by %s (never connected) as transient", (code) => {
    expect(isTransientPublishError(fetchFailed(code))).toBe(true);
  });

  it("treats a multi-address connect failure (AggregateError carrying the code) as transient", () => {
    const cause = Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });
    expect(isTransientPublishError(new TypeError("fetch failed", { cause }))).toBe(true);
  });

  it.each([
    ["ECONNRESET (connection dropped mid-request)", "ECONNRESET"],
    ["UND_ERR_SOCKET (other side closed)", "UND_ERR_SOCKET"],
    ["EPIPE", "EPIPE"],
    ["ETIMEDOUT", "ETIMEDOUT"],
    ["UND_ERR_HEADERS_TIMEOUT (request sent, no answer)", "UND_ERR_HEADERS_TIMEOUT"],
  ])("never retries a fetch failure that may have reached the platform: %s", (_label, code) => {
    expect(isTransientPublishError(fetchFailed(code))).toBe(false);
  });

  it("never retries a fetch TypeError without a cause code (cannot prove it never connected)", () => {
    expect(isTransientPublishError(new TypeError("fetch failed"))).toBe(false);
    expect(isTransientPublishError(new TypeError("fetch failed", { cause: new Error("?") }))).toBe(false);
  });

  it("never retries a programming TypeError", () => {
    expect(
      isTransientPublishError(new TypeError("Cannot read properties of undefined (reading 'id')")),
    ).toBe(false);
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

  it("retries a never-connected network failure", async () => {
    const fn = vi.fn().mockRejectedValueOnce(fetchFailed("ECONNREFUSED")).mockResolvedValueOnce("ok");
    await expect(withTransientRetries(fn, { sleep: async () => {} })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT re-run a publish whose connection dropped mid-request (could double-post)", async () => {
    const dropped = fetchFailed("ECONNRESET");
    const fn = vi.fn().mockRejectedValue(dropped);
    await expect(withTransientRetries(fn, { sleep: async () => {} })).rejects.toBe(dropped);
    expect(fn).toHaveBeenCalledTimes(1);
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
