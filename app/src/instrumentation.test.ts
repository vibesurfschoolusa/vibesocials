import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { initMock, captureRequestErrorMock } = vi.hoisted(() => ({
  initMock: vi.fn(),
  captureRequestErrorMock: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => ({ init: initMock, captureRequestError: captureRequestErrorMock }));

import { register } from "./instrumentation";

// 2026-11-02 scale audit (jobs B3): the server/edge init redacts the URL of every
// outgoing request (lib/sentryRedaction.ts) because upload sessions are capability
// URLs. The DSN handling and the sample rate are unchanged.
describe("instrumentation register()", () => {
  const SESSION =
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION-SECRET-1";

  beforeEach(() => {
    initMock.mockReset();
    vi.stubEnv("SENTRY_DSN", "https://key@sentry.example/1");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["nodejs", "edge"])("inits Sentry on the %s runtime with the redaction hooks and the same options as before", async (runtime) => {
    vi.stubEnv("NEXT_RUNTIME", runtime);

    await register();

    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock.mock.calls[0][0]).toMatchObject({
      dsn: "https://key@sentry.example/1",
      tracesSampleRate: 0.1,
      enabled: true,
      sendDefaultPii: false,
      beforeBreadcrumb: expect.any(Function),
      beforeSendSpan: expect.any(Function),
    });
  });

  it("the breadcrumb hook strips the session URI of an outgoing request", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await register();
    const { beforeBreadcrumb } = initMock.mock.calls[0][0] as {
      beforeBreadcrumb: (breadcrumb: unknown) => { data?: Record<string, unknown> } | null;
    };

    const out = beforeBreadcrumb({
      type: "http",
      category: "http",
      data: { url: SESSION, "http.query": "?upload_id=SESSION-SECRET-1", "http.method": "PUT" },
    });

    expect(JSON.stringify(out)).not.toContain("SESSION-SECRET");
    expect(out?.data).toEqual({ url: "https://www.googleapis.com/[redacted]", "http.method": "PUT" });
  });

  it("the span hook strips the session URI of an outgoing request", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await register();
    const { beforeSendSpan } = initMock.mock.calls[0][0] as {
      beforeSendSpan: (span: unknown) => unknown;
    };

    const out = beforeSendSpan({
      span_id: "s",
      trace_id: "t",
      op: "http.client",
      description: "PUT https://www.googleapis.com/upload/youtube/v3/videos",
      data: { "url.full": SESSION, "http.url": SESSION, "http.query": "?upload_id=SESSION-SECRET-1" },
    });

    expect(JSON.stringify(out)).not.toContain("SESSION-SECRET");
    expect(JSON.stringify(out)).not.toContain("upload_id");
  });

  it("does nothing without a DSN", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");

    await register();

    expect(initMock).not.toHaveBeenCalled();
  });

  it("falls back to NEXT_PUBLIC_SENTRY_DSN, as before", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://public@sentry.example/2");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");

    await register();

    expect(initMock.mock.calls[0][0]).toMatchObject({ dsn: "https://public@sentry.example/2" });
  });
});
