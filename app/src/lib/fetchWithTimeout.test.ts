import { afterEach, describe, expect, it, vi } from "vitest";

import { FETCH_TIMEOUT_CODE, fetchWithTimeout } from "./fetchWithTimeout";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchWithTimeout", () => {
  it("returns the response on success and passes the caller's init through", async () => {
    const response = new Response("ok", { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchWithTimeout("https://example.test/data", {
      method: "POST",
      headers: { "X-Test": "1" },
    });

    expect(result).toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/data");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Test"]).toBe("1");
    // A composite abort signal is always attached.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("times out, aborts the in-flight request, and throws a coded timeout error", async () => {
    vi.useFakeTimers();
    let abortedByUs = false;
    const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          abortedByUs = true;
          const abortError = new Error("aborted");
          abortError.name = "AbortError";
          reject(abortError);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithTimeout("https://example.test/slow", {}, 1_000);
    // Attach handlers before advancing timers to avoid an unhandled rejection.
    const settled = promise
      .then(() => null)
      .catch((error: unknown) => error as Error & { code?: string });

    await vi.advanceTimersByTimeAsync(1_000);
    const error = await settled;

    expect(abortedByUs).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(error?.code).toBe(FETCH_TIMEOUT_CODE);
    expect(error?.message).toContain("1000ms");
  });

  it("propagates a caller-supplied signal abort without tagging it as a timeout", async () => {
    const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          const abortError = new Error("aborted by caller");
          abortError.name = "AbortError";
          reject(abortError);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const promise = fetchWithTimeout(
      "https://example.test/slow",
      { signal: controller.signal },
      10_000,
    );
    const settled = promise
      .then(() => null)
      .catch((error: unknown) => error as Error & { code?: string });
    controller.abort();

    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    // Not our timeout — no FETCH_TIMEOUT code.
    expect(error?.code).toBeUndefined();
  });
});
