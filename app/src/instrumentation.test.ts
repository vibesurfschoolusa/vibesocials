import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { initMock, captureRequestErrorMock } = vi.hoisted(() => ({
  initMock: vi.fn(),
  captureRequestErrorMock: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => ({
  init: initMock,
  captureRequestError: captureRequestErrorMock,
  captureRouterTransitionStart: vi.fn(),
}));

import { register } from "./instrumentation";
import { SENTRY_DATA_COLLECTION, redactForSentry } from "./lib/sentryRedaction";

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
      dataCollection: SENTRY_DATA_COLLECTION,
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

// R43 (lead): an incoming path's link token (/c/, /u/, /v/, /join/ and their
// API routes) never reaches Sentry, from the server or the browser.
describe("link tokens in incoming paths", () => {
  const TOKEN_URL = "https://vibesocials.wtf/c/LINK-SECRET-9";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  type Hooks = {
    beforeSend: (event: unknown) => unknown;
    beforeSendTransaction: (event: unknown) => unknown;
    beforeSendSpan?: (span: unknown) => unknown;
    beforeBreadcrumb: (breadcrumb: unknown) => unknown;
  };
  const EVENT = { transaction: "GET /c/LINK-SECRET-9", request: { url: TOKEN_URL } };

  it("the server init redacts incoming spans, the event's request URL and transaction, and breadcrumbs", async () => {
    initMock.mockReset();
    vi.stubEnv("SENTRY_DSN", "https://key@sentry.example/1");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await register();
    const hooks = initMock.mock.calls[0][0] as Hooks;

    expect(JSON.stringify(hooks.beforeSend(EVENT))).not.toContain("LINK-SECRET");
    expect(JSON.stringify(hooks.beforeSendTransaction(EVENT))).not.toContain("LINK-SECRET");
    const span = hooks.beforeSendSpan!({ op: "http.server", description: "GET /c/LINK-SECRET-9", data: { "url.full": TOKEN_URL } });
    expect(JSON.stringify(span)).not.toContain("LINK-SECRET");
    const crumb = hooks.beforeBreadcrumb({ category: "console", message: `served ${TOKEN_URL}` });
    expect(JSON.stringify(crumb)).not.toContain("LINK-SECRET");
  });

  it("the client init redacts beforeSend and navigation and fetch breadcrumbs", async () => {
    initMock.mockReset();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://public@sentry.example/2");
    vi.resetModules();
    await import("./instrumentation-client");
    expect(initMock).toHaveBeenCalledTimes(1);
    const hooks = initMock.mock.calls[0][0] as Hooks;

    expect(JSON.stringify(hooks.beforeSend(EVENT))).not.toContain("LINK-SECRET");
    expect(JSON.stringify(hooks.beforeSendTransaction(EVENT))).not.toContain("LINK-SECRET");
    const navigation = hooks.beforeBreadcrumb({ category: "navigation", data: { from: "/", to: "/v/LINK-SECRET-9" } });
    expect(navigation).toEqual({ category: "navigation", data: { from: "/", to: "/v/[token]" } });
    const fetchCrumb = hooks.beforeBreadcrumb({ category: "fetch", data: { url: "/api/review-link/LINK-SECRET-9/posts", method: "GET" } });
    expect(JSON.stringify(fetchCrumb)).not.toContain("LINK-SECRET");
    // R43 review: the browser's fetch spans, and account links' #fragment.
    const span = hooks.beforeSendSpan!({
      op: "http.client",
      description: "POST https://vibesocials.wtf/api/invites/LINK-SECRET-9/accept",
      data: { url: "https://vibesocials.wtf/api/invites/LINK-SECRET-9/accept", "http.url": "https://vibesocials.wtf/api/invites/LINK-SECRET-9/accept" },
    });
    expect(JSON.stringify(span)).not.toContain("LINK-SECRET");
    const reset = hooks.beforeSend({ request: { url: "https://vibesocials.wtf/reset-password#LINK-SECRET-9" } });
    expect(JSON.stringify(reset)).not.toContain("LINK-SECRET");
  });
});

// R44 (security M1, L1): one rule for the whole event, on the server and in the
// browser. Cookies and request headers are never collected, and every hook runs
// the same redaction.
describe("one Sentry rule on both inits", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function expectOneRule(options: Record<string, unknown>): void {
    expect(options.dataCollection).toBe(SENTRY_DATA_COLLECTION);
    expect(options).not.toHaveProperty("sendDefaultPii");
    for (const hook of ["beforeSend", "beforeSendTransaction", "beforeSendSpan", "beforeBreadcrumb"]) {
      expect(options[hook]).toBe(redactForSentry);
    }
  }

  it("the server init", async () => {
    initMock.mockReset();
    vi.stubEnv("SENTRY_DSN", "https://key@sentry.example/1");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await register();
    expectOneRule(initMock.mock.calls[0][0] as Record<string, unknown>);
  });

  it("the client init", async () => {
    initMock.mockReset();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://public@sentry.example/2");
    vi.resetModules();
    const { redactForSentry: fresh, SENTRY_DATA_COLLECTION: freshCollection } = await import("./lib/sentryRedaction");
    await import("./instrumentation-client");
    const options = initMock.mock.calls[0][0] as Record<string, unknown>;
    expect(options.dataCollection).toBe(freshCollection);
    for (const hook of ["beforeSend", "beforeSendTransaction", "beforeSendSpan", "beforeBreadcrumb"]) {
      expect(options[hook]).toBe(fresh);
    }
    expect(options).not.toHaveProperty("sendDefaultPii");
  });
});
