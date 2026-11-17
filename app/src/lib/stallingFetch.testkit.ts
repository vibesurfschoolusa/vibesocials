import { vi } from "vitest";

/**
 * Test-only providers that stall, as a real fetch does: the promise (or the
 * body) settles only when the request's signal aborts.
 */

function abortError(signal: AbortSignal | null | undefined): unknown {
  return signal?.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/** Answers no headers at all. */
export function headersNeverCome(_input: string | URL, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(abortError(init.signal)));
  });
}

/** Answers 200 headers at once, then a body that never ends. */
export function bodyNeverEnds(_input: string | URL, init?: RequestInit): Promise<Response> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      init?.signal?.addEventListener("abort", () => controller.error(abortError(init.signal)));
    },
  });
  return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
}

/** Node's AbortSignal.timeout runs on a timer fake timers don't replace; this one runs on the fake clock. */
export function abortSignalTimeoutOnFakeClock(): void {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
    return controller.signal;
  });
}
