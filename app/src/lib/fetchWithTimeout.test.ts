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
          reject(new DOMException("The operation was aborted.", "AbortError"));
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
    expect((error as Error)?.name).toBe("AbortError");
    // Not our timeout: a real DOMException carries a legacy numeric `.code`
    // (20 for AbortError per the WHATWG spec), never our string-tagged
    // FETCH_TIMEOUT_CODE — assert against that string tag specifically.
    expect(error?.code).not.toBe(FETCH_TIMEOUT_CODE);
  });

  it("lets a caller signal that fires AFTER headers arrive abort the in-flight body read", async () => {
    // Pins the AbortSignal.any composition: a caller-supplied `init.signal`
    // must keep covering the request past headers, all the way through body
    // streaming — not just the connection/headers phase our own timeout
    // covers.
    const controller = new AbortController();
    let sawSignal: AbortSignal | undefined;

    const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
      sawSignal = init?.signal ?? undefined;
      // A body stream that never enqueues/closes on its own (simulating a
      // slow/never-ending response), but — like undici's real fetch —
      // wired to reject the in-flight read as soon as the passed signal
      // fires, whenever that happens.
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          const signal = init?.signal;
          if (!signal) return;
          if (signal.aborted) {
            streamController.error(signal.reason);
            return;
          }
          signal.addEventListener(
            "abort",
            () => streamController.error(signal.reason),
            { once: true },
          );
        },
        pull() {
          return new Promise<void>(() => {}); // never resolves
        },
        cancel() {
          // No-op: mirrors the body stream's cancel contract.
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithTimeout(
      "https://example.test/stream",
      { signal: controller.signal },
      10_000,
    );

    // Headers arrived: our own timeout has already been cleared, but the
    // composite signal handed to fetch is still alive and not aborted.
    expect(sawSignal).toBeInstanceOf(AbortSignal);
    expect(sawSignal?.aborted).toBe(false);

    const readPromise = response.text();
    controller.abort();

    await expect(readPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(sawSignal?.aborted).toBe(true);
  });
});
