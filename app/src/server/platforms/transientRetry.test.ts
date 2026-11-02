import { describe, expect, it, vi } from "vitest";

import { FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";

import { publishUnconfirmedError } from "./commitCall";
import { rateLimitedError } from "./rateLimited";
import {
  isNeverConnectedFetchError,
  isTransientPublishError,
  MIN_RETRY_WINDOW_MS,
  withTransientRetries,
} from "./transientRetry";

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

  // 2026-11-01 scale audit (platform limits): a classified limit is waited out
  // by a durable sleep (retryAt), never by the 2s/8s in-step retry.
  it("never retries a RateLimitedError, even one that carries a 429 status", () => {
    expect(isTransientPublishError(rateLimitedError("x", "rate_limited", Date.now() + 60_000))).toBe(
      false,
    );
    const with429 = Object.assign(rateLimitedError("x", "rate_limited", null), { status: 429 });
    expect(isTransientPublishError(with429)).toBe(false);
    const with503 = Object.assign(rateLimitedError("youtube", "youtube_quota", null), { status: 503 });
    expect(isTransientPublishError(with503)).toBe(false);
  });
});

// 2026-11-01 scale audit (jobs H6, Task 6): commitRequest exports the
// "provably never connected" test it shares with the retry rule.
describe("isNeverConnectedFetchError", () => {
  it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"])(
    "is true for a fetch failure caused by %s",
    (code) => {
      expect(isNeverConnectedFetchError(fetchFailed(code))).toBe(true);
    },
  );

  it("is true when the code sits on a plain-object cause or an AggregateError cause", () => {
    expect(isNeverConnectedFetchError(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }))).toBe(true);
    const aggregate = Object.assign(new AggregateError([], ""), { code: "ENOTFOUND" });
    expect(isNeverConnectedFetchError(new TypeError("fetch failed", { cause: aggregate }))).toBe(true);
  });

  it("is false for a mid-request drop, a missing cause or a cause without a string code", () => {
    expect(isNeverConnectedFetchError(fetchFailed("ECONNRESET"))).toBe(false);
    expect(isNeverConnectedFetchError(new TypeError("fetch failed"))).toBe(false);
    expect(isNeverConnectedFetchError(new TypeError("fetch failed", { cause: "ECONNREFUSED" }))).toBe(false);
    expect(isNeverConnectedFetchError(new TypeError("fetch failed", { cause: { code: 111 } }))).toBe(false);
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

  it("calls fn once for a RateLimitedError and rethrows it unchanged", async () => {
    const limited = Object.assign(rateLimitedError("tiktok", "rate_limited", 123), { status: 429 });
    const fn = vi.fn().mockRejectedValue(limited);
    const sleep = vi.fn(async () => {});
    await expect(withTransientRetries(fn, { sleep })).rejects.toBe(limited);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  // 2026-11-01 scale audit (jobs H6, Task 6): an ambiguous commit call must never
  // be re-run, so PUBLISH_UNCONFIRMED is not transient — whatever else it carries.
  it("calls fn once for PUBLISH_UNCONFIRMED and rethrows it unchanged", async () => {
    const unconfirmed = publishUnconfirmedError("youtube", statusError(502));
    const fn = vi.fn().mockRejectedValue(unconfirmed);
    const sleep = vi.fn(async () => {});

    await expect(withTransientRetries(fn, { sleep })).rejects.toBe(unconfirmed);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("calls fn once for PUBLISH_UNCONFIRMED even when it also carries a retryable status", async () => {
    const unconfirmed = Object.assign(publishUnconfirmedError("x"), { status: 503 });
    const fn = vi.fn().mockRejectedValue(unconfirmed);

    await expect(withTransientRetries(fn, { sleep: async () => {} })).rejects.toBe(unconfirmed);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isTransientPublishError(unconfirmed)).toBe(false);
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

// 2026-11-01 audit (Task 4 items 7 + 10): a retry re-runs the WHOLE platform
// publish (download, upload, processing poll), so it may only start when the
// step's remaining budget can still hold a meaningful attempt.
describe("withTransientRetries — step budget", () => {
  const noSleep = async () => {};

  it("does not retry when the backoff plus a minimum attempt window would cross the deadline", async () => {
    const err = statusError(503);
    const fn = vi.fn().mockRejectedValue(err);
    // 2s backoff + 60s window needed; only 61s left.
    const deadline = 1_000_000 + 2_000 + MIN_RETRY_WINDOW_MS - 1;

    await expect(
      withTransientRetries(fn, { sleep: noSleep, deadline, now: () => 1_000_000 }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries while enough budget remains, then stops when it runs short", async () => {
    let clock = 0;
    const fn = vi.fn(async () => {
      clock += 50_000; // each attempt burns 50s
      throw statusError(502);
    });
    // Attempt 1 ends at 50s: 2s + 60s fits before 130s -> retry. Attempt 2 ends
    // at ~102s: 8s + 60s does not fit -> rethrow instead of a third attempt.
    await expect(
      withTransientRetries(fn, {
        sleep: async (ms) => { clock += ms; },
        deadline: 130_000,
        now: () => clock,
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("is unchanged without a deadline (3 attempts)", async () => {
    const fn = vi.fn().mockRejectedValue(statusError(500));
    await withTransientRetries(fn, { sleep: noSleep }).catch(() => {});
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("keeps the minimum attempt window at 60s", () => {
    expect(MIN_RETRY_WINDOW_MS).toBe(60_000);
  });
});

