import { describe, expect, it } from "vitest";

import { redactBreadcrumb, redactOutgoingSpan, redactOutgoingUrl } from "./sentryRedaction";

// 2026-11-02 scale audit (jobs B3): Sentry's automatic fetch / http instrumentation
// records the URL of every outgoing request, query included, in breadcrumbs and span
// attributes. Upload sessions are capability URLs (the YouTube session URI, TikTok's
// upload_url, LinkedIn's part URLs), so no outgoing URL keeps a query, and an upload
// URL loses its path as well.

const YOUTUBE_SESSION =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION-SECRET-1";
const TIKTOK_UPLOAD =
  "https://open-upload.tiktokapis.com/video/?upload_id=67890&upload_token=UPLOAD-TOKEN-1";
const LINKEDIN_PART =
  "https://www.linkedin.com/dms-uploads/sp/C5605AQ-SECRET/abc?ca=vector_ads&cn=uploads&m=AQJ&app=1&sync=0&v=beta&ut=PART-TOKEN-1";

describe("redactOutgoingUrl", () => {
  it("drops the session id and the path of a YouTube resumable session URI", () => {
    const redacted = redactOutgoingUrl(YOUTUBE_SESSION);

    expect(redacted).toBe("https://www.googleapis.com/[redacted]");
    expect(redacted).not.toContain("upload_id");
    expect(redacted).not.toContain("SESSION-SECRET");
  });

  it("redacts the path of the YouTube upload endpoint too (every /upload/ path)", () => {
    expect(
      redactOutgoingUrl("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status"),
    ).toBe("https://www.googleapis.com/[redacted]");
  });

  it("drops the query and redacts the path of a TikTok upload URL", () => {
    const redacted = redactOutgoingUrl(TIKTOK_UPLOAD);

    expect(redacted).toBe("https://open-upload.tiktokapis.com/[redacted]");
    expect(redacted).not.toContain("upload_token");
    expect(redacted).not.toContain("UPLOAD-TOKEN");
  });

  it("redacts the path of any tiktokapis.com host, not only the upload host", () => {
    expect(redactOutgoingUrl("https://open.tiktokapis.com/v2/post/publish/video/init/")).toBe(
      "https://open.tiktokapis.com/[redacted]",
    );
  });

  it("redacts the path of a LinkedIn dms-uploads URL", () => {
    const redacted = redactOutgoingUrl(LINKEDIN_PART);

    expect(redacted).toBe("https://www.linkedin.com/[redacted]");
    expect(redacted).not.toContain("SECRET");
    expect(redacted).not.toContain("PART-TOKEN");
  });

  it("redacts the path of a host that names an upload service", () => {
    expect(redactOutgoingUrl("https://upload.example.com/v1/abc123?x=1")).toBe("https://upload.example.com/[redacted]");
  });

  it("strips the query and the fragment of a normal API URL and keeps the path", () => {
    expect(
      redactOutgoingUrl("https://graph.facebook.com/v19.0/1789/media?access_token=EAAB-SECRET&fields=status_code#top"),
    ).toBe("https://graph.facebook.com/v19.0/1789/media");
    expect(redactOutgoingUrl("https://api.x.com/2/tweets")).toBe("https://api.x.com/2/tweets");
  });

  it("keeps the port and drops credentials in the URL", () => {
    expect(redactOutgoingUrl("https://user:pw@api.example.com:8443/v1/items?x=1")).toBe(
      "https://api.example.com:8443/v1/items",
    );
  });

  it.each(["not a url", "", "/relative/path?x=1", "http://", "https://"])(
    "returns [unparseable-url] for a malformed URL (%j)",
    (value) => {
      expect(redactOutgoingUrl(value)).toBe("[unparseable-url]");
    },
  );
});

describe("redactBreadcrumb", () => {
  const httpBreadcrumb = (url: string, extra: Record<string, unknown> = {}) => ({
    type: "http",
    category: "http",
    level: "info" as const,
    data: {
      url,
      "http.method": "PUT",
      status_code: 308,
      "http.query": "?uploadType=resumable&upload_id=SESSION-SECRET-1",
      "http.fragment": "#frag",
      ...extra,
    },
  });

  it("strips the query and fragment from an http breadcrumb and keeps the rest of its data", () => {
    const out = redactBreadcrumb(
      httpBreadcrumb("https://graph.facebook.com/v19.0/1789/media?access_token=EAAB-SECRET"),
    );

    expect(out.data).toEqual({
      url: "https://graph.facebook.com/v19.0/1789/media",
      "http.method": "PUT",
      status_code: 308,
    });
    expect(out).toMatchObject({ type: "http", category: "http", level: "info" });
  });

  it("redacts the session URI of a YouTube chunk request, and its http.query", () => {
    const out = redactBreadcrumb(httpBreadcrumb(YOUTUBE_SESSION));

    expect(out.data?.url).toBe("https://www.googleapis.com/[redacted]");
    expect(out.data).not.toHaveProperty("http.query");
    expect(JSON.stringify(out)).not.toContain("SESSION-SECRET");
    expect(JSON.stringify(out)).not.toContain("upload_id");
  });

  it.each([
    ["TikTok upload URL", TIKTOK_UPLOAD, "UPLOAD-TOKEN"],
    ["LinkedIn part URL", LINKEDIN_PART, "PART-TOKEN"],
  ])("redacts the %s", (_name, url, secret) => {
    const out = redactBreadcrumb(httpBreadcrumb(url));

    expect(JSON.stringify(out)).not.toContain(secret);
    expect((out.data?.url as string).endsWith("/[redacted]")).toBe(true);
  });

  it("handles a fetch breadcrumb (category fetch, no type)", () => {
    const out = redactBreadcrumb({
      category: "fetch",
      data: { url: "https://api.example.com/v1/items?token=abc", method: "GET", status_code: 200 },
    });

    expect(out.data).toEqual({ url: "https://api.example.com/v1/items", method: "GET", status_code: 200 });
  });

  it("redacts a URL in the message of an http breadcrumb", () => {
    const out = redactBreadcrumb({ category: "http", message: `PUT ${YOUTUBE_SESSION} -> 308` });

    expect(out.message).not.toContain("SESSION-SECRET");
    expect(out.message).toContain("PUT ");
  });

  it("marks a URL it cannot read", () => {
    expect(redactBreadcrumb(httpBreadcrumb("/relative?x=1")).data?.url).toBe("[unparseable-url]");
  });

  it("does not modify the breadcrumb it was given", () => {
    const original = httpBreadcrumb(YOUTUBE_SESSION);
    const snapshot = JSON.stringify(original);

    redactBreadcrumb(original);

    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("leaves other breadcrumbs exactly as they are", () => {
    const console = { category: "console", level: "log" as const, message: `see ${YOUTUBE_SESSION}`, data: { arguments: [1] } };
    const navigation = { category: "navigation", data: { from: "/a?x=1", to: "/b?y=2" } };

    expect(redactBreadcrumb(console)).toBe(console);
    expect(redactBreadcrumb(navigation)).toBe(navigation);
  });

  it("leaves an http breadcrumb with no data alone", () => {
    const bare = { category: "http", message: "no url here" };

    expect(redactBreadcrumb(bare)).toEqual(bare);
  });
});

describe("redactOutgoingSpan", () => {
  const span = (overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
    span_id: "s1",
    trace_id: "t1",
    op: "http.client",
    description: `PUT ${YOUTUBE_SESSION.split("?")[0]}`,
    data: {
      url: YOUTUBE_SESSION,
      "url.full": YOUTUBE_SESSION,
      "http.url": YOUTUBE_SESSION,
      "http.target": "/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION-SECRET-1",
      "http.query": "?uploadType=resumable&upload_id=SESSION-SECRET-1",
      "url.query": "uploadType=resumable&upload_id=SESSION-SECRET-1",
      "http.fragment": "#frag",
      "url.fragment": "frag",
      "http.method": "PUT",
      "http.response.status_code": 308,
      "server.address": "www.googleapis.com",
      ...data,
    },
    ...overrides,
  });

  it("redacts every URL attribute of a YouTube chunk span and deletes the query attributes", () => {
    const out = redactOutgoingSpan(span());

    expect(JSON.stringify(out)).not.toContain("SESSION-SECRET");
    expect(JSON.stringify(out)).not.toContain("upload_id");
    expect(out.data).toEqual({
      url: "https://www.googleapis.com/[redacted]",
      "url.full": "https://www.googleapis.com/[redacted]",
      "http.url": "https://www.googleapis.com/[redacted]",
      "http.target": "/[redacted]",
      "http.method": "PUT",
      "http.response.status_code": 308,
      "server.address": "www.googleapis.com",
    });
    expect(out.description).toBe("PUT https://www.googleapis.com/[redacted]");
    expect(out).toMatchObject({ span_id: "s1", trace_id: "t1", op: "http.client" });
  });

  it("strips the query of a normal API span and keeps its path", () => {
    const url = "https://graph.facebook.com/v19.0/1789/media?access_token=EAAB-SECRET&fields=status_code";
    const out = redactOutgoingSpan(
      span(
        { description: "GET https://graph.facebook.com/v19.0/1789/media" },
        {
          url,
          "url.full": url,
          "http.url": url,
          "http.target": "/v19.0/1789/media?access_token=EAAB-SECRET&fields=status_code",
          "server.address": "graph.facebook.com",
        },
      ),
    );

    expect(JSON.stringify(out)).not.toContain("EAAB-SECRET");
    expect(out.data).toMatchObject({
      url: "https://graph.facebook.com/v19.0/1789/media",
      "url.full": "https://graph.facebook.com/v19.0/1789/media",
      "http.url": "https://graph.facebook.com/v19.0/1789/media",
      "http.target": "/v19.0/1789/media",
    });
    expect(out.description).toBe("GET https://graph.facebook.com/v19.0/1789/media");
  });

  it.each([
    ["TikTok upload URL", TIKTOK_UPLOAD, "UPLOAD-TOKEN"],
    ["LinkedIn part URL", LINKEDIN_PART, "PART-TOKEN"],
  ])("redacts the %s in a span, including a description that carries it", (_name, url, secret) => {
    const out = redactOutgoingSpan(
      span({ description: `PUT ${url}` }, { url, "url.full": url, "http.url": url, "http.target": url.replace(/^https:\/\/[^/]+/, "") }),
    );

    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.data["url.full"]).toMatch(/\/\[redacted\]$/);
    expect(out.data["http.target"]).toBe("/[redacted]");
  });

  it("does not modify the span it was given", () => {
    const original = span();
    const snapshot = JSON.stringify(original);

    redactOutgoingSpan(original);

    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("leaves spans that are not outgoing http requests exactly as they are", () => {
    const incoming = span({ op: "http.server", description: "GET /api/oauth/callback" }, { "url.full": "https://app.example/cb?code=abc" });
    const db = span({ op: "db.query", description: "SELECT 1" }, {});

    expect(redactOutgoingSpan(incoming)).toBe(incoming);
    expect(redactOutgoingSpan(db)).toBe(db);
  });

  it("copes with a span that has no description and only some attributes", () => {
    const out = redactOutgoingSpan({
      span_id: "s2",
      trace_id: "t2",
      op: "http.client",
      data: { "url.full": "https://api.example.com/v1/x?token=1", "http.query": "?token=1" },
    });

    expect(out.data).toEqual({ "url.full": "https://api.example.com/v1/x" });
    expect(out).not.toHaveProperty("description");
  });
});
