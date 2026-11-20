import { describe, expect, it } from "vitest";

import {
  CUT_MARK,
  FILTERED_VALUE,
  LINK_TOKEN,
  MAX_REDACTED_LENGTH,
  SENTRY_DATA_COLLECTION,
  redactBreadcrumb,
  redactForSentry,
  redactLinkTokens,
  redactOutgoingSpan,
  redactOutgoingUrl,
} from "./sentryRedaction";

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

// R43 (lead, from security's second half): the client, review, upload and invite
// links carry their token in the path, and an incoming request's URL reaches
// Sentry in its request, its span, its transaction and the browser's
// breadcrumbs. Whoever holds the token can use the link.
describe("redactLinkTokens", () => {
  const SECRET = "Tok3n-SECRET_abc";

  it.each([
    [`/c/${SECRET}`, "/c/[token]"],
    [`/u/${SECRET}`, "/u/[token]"],
    [`/v/${SECRET}`, "/v/[token]"],
    [`/join/${SECRET}`, "/join/[token]"],
    [`/api/connect-link/${SECRET}/start`, "/api/connect-link/[token]/start"],
    [`/api/connect-link/${SECRET}/pending`, "/api/connect-link/[token]/pending"],
    [`/api/review-link/${SECRET}`, "/api/review-link/[token]"],
    [`/api/review-link/${SECRET}/posts/p1`, "/api/review-link/[token]/posts/p1"],
    [`/api/upload-link/${SECRET}/upload`, "/api/upload-link/[token]/upload"],
    [`/api/invites/${SECRET}/accept`, "/api/invites/[token]/accept"],
    [`https://vibesocials.wtf/c/${SECRET}?step=2#top`, "https://vibesocials.wtf/c/[token]?step=[Filtered]"],
    [`GET /v/${SECRET}`, "GET /v/[token]"],
    [`POST https://vibesocials.wtf/api/invites/${SECRET}/accept`, "POST https://vibesocials.wtf/api/invites/[token]/accept"],
    [`/c/${SECRET}?x=1`, "/c/[token]?x=[Filtered]"],
  ])("%s becomes %s", (input, output) => {
    expect(redactLinkTokens(input)).toBe(output);
    expect(redactLinkTokens(input)).not.toContain(SECRET);
  });

  it.each([
    "/dashboard",
    "/c",
    "/c/",
    "/settings/connections/c/abc",
    "/api/invites",
    "/api/posts/abc",
    "https://vibesocials.wtf/join",
    "/c/[token]",
    "/vendor/v1",
    "https://cdn.example/u",
  ])("%s, with no link token, is unchanged", (input) => {
    expect(redactLinkTokens(input)).toBe(input);
  });

  it("the placeholder is [token]", () => {
    expect(LINK_TOKEN).toBe("[token]");
  });
});

describe("redactForSentry: incoming spans lose the token, outgoing keep their rules", () => {
  it("an incoming request span", () => {
    const span = {
      op: "http.server",
      description: "GET /c/SECRET-1",
      data: { "url.full": "https://vibesocials.wtf/c/SECRET-1?a=1", "http.target": "/c/SECRET-1?a=1", "url.path": "/c/SECRET-1", "http.status_code": 200 },
    };
    const out = redactForSentry(span);
    expect(JSON.stringify(out)).not.toContain("SECRET-1");
    expect(out.description).toBe("GET /c/[token]");
    expect(out.data["http.status_code"]).toBe(200);
    expect(span.description).toBe("GET /c/SECRET-1");
  });

  it("an outgoing span is redacted exactly as redactOutgoingSpan does", () => {
    const span = {
      op: "http.client",
      description: "PUT https://www.googleapis.com/upload/youtube/v3/videos",
      data: { "url.full": YOUTUBE_SESSION, "http.query": "?upload_id=SESSION-SECRET-1" },
    };
    expect(redactForSentry(span)).toEqual(redactOutgoingSpan(span));
  });
});

describe("redactForSentry", () => {
  it("the request URL, the transaction and the trace context lose the token", () => {
    const event = {
      transaction: "GET /join/SECRET-2",
      request: { url: "https://vibesocials.wtf/join/SECRET-2", method: "GET" },
      contexts: { trace: { op: "http.server", description: "GET /join/SECRET-2", data: { "url.full": "https://vibesocials.wtf/join/SECRET-2", n: 1 } } },
      message: "kept",
    };
    const out = redactForSentry(event);
    expect(JSON.stringify(out)).not.toContain("SECRET-2");
    expect(out.transaction).toBe("GET /join/[token]");
    expect(out.request?.url).toBe("https://vibesocials.wtf/join/[token]");
    expect(out.request?.method).toBe("GET");
    expect(out.message).toBe("kept");
    expect(event.transaction).toBe("GET /join/SECRET-2");
  });

  it("an event with none of them is returned as it is", () => {
    const event: { message: string; transaction?: string } = { message: "x" };
    expect(redactForSentry(event)).toEqual({ message: "x" });
  });
});

describe("redactForSentry", () => {
  it("a navigation breadcrumb's from and to", () => {
    const out = redactForSentry({ category: "navigation", data: { from: "/", to: "/u/SECRET-3" } });
    expect(out.data).toEqual({ from: "/", to: "/u/[token]" });
  });

  it("a fetch breadcrumb's relative URL and message", () => {
    const out = redactForSentry({
      category: "fetch",
      message: "POST /api/upload-link/SECRET-3/upload",
      data: { url: "/api/upload-link/SECRET-3/upload", method: "POST", status_code: 200 },
    });
    expect(JSON.stringify(out)).not.toContain("SECRET-3");
    expect(out.data).toEqual({ url: "/api/upload-link/[token]/upload", method: "POST", status_code: 200 });
  });
});

// R43 review: the account links (reset password, verify email, new address,
// undo) carry their token in the #fragment, and a sign-in redirect carries a
// link path encoded in its callbackUrl. Fragments are never needed in Sentry.
describe("redactLinkTokens: fragments and query values", () => {
  it.each([
    ["https://vibesocials.wtf/reset-password#RESET-SECRET", "https://vibesocials.wtf/reset-password"],
    ["https://vibesocials.wtf/verify-email/undo#UNDO-SECRET", "https://vibesocials.wtf/verify-email/undo"],
    ["/verify-email/new-address#NEW-SECRET", "/verify-email/new-address"],
    ["/verify-email?x=1#VERIFY-SECRET", "/verify-email?x=[Filtered]"],
    ["navigated to /reset-password#RESET-SECRET now", "navigated to /reset-password now"],
  ])("%s loses its fragment", (input, output) => {
    expect(redactLinkTokens(input)).toBe(output);
  });

  it.each([
    ["/login?callbackUrl=%2Fjoin%2FJOIN-SECRET", "/login?callbackUrl=[Filtered]"],
    [
      "https://vibesocials.wtf/login?callbackUrl=%2Fjoin%2FJOIN-SECRET&x=1",
      "https://vibesocials.wtf/login?callbackUrl=[Filtered]&x=[Filtered]",
    ],
    ["/login?callbackUrl=/c/CLIENT-SECRET", "/login?callbackUrl=[Filtered]"],
    [
      "/login?callbackUrl=https%3A%2F%2Fvibesocials.wtf%2Fapi%2Finvites%2FINVITE-SECRET%2Faccept",
      "/login?callbackUrl=[Filtered]",
    ],
  ])("%s keeps no token in its query", (input, output) => {
    expect(redactLinkTokens(input)).toBe(output);
    expect(redactLinkTokens(input)).not.toMatch(/SECRET/);
  });

  // R45 security L1: every query value is filtered, with or without a token in it.
  it.each([
    ["/login?callbackUrl=%2Fdashboard", "/login?callbackUrl=[Filtered]"],
    ["https://vibesocials.wtf/login?callbackUrl=%2Fsettings%23plan2&tab=1", "https://vibesocials.wtf/login?callbackUrl=[Filtered]&tab=[Filtered]"],
    ["/posts?page=2&q=surf%20lessons", "/posts?page=[Filtered]&q=[Filtered]"],
    ["/login?callbackUrl=%E0%A4%A", "/login?callbackUrl=[Filtered]"],
  ])("%s keeps only its query names", (input, output) => {
    expect(redactLinkTokens(input)).toBe(output);
  });

  it("div#main > button, with no URL in it, is unchanged", () => {
    expect(redactLinkTokens("div#main > button")).toBe("div#main > button");
  });

  it("an event's request URL and query string lose the fragment and the callbackUrl token", () => {
    const out = redactForSentry({
      request: { url: "https://vibesocials.wtf/login?callbackUrl=%2Fjoin%2FJOIN-SECRET#FRAG-SECRET", query_string: "callbackUrl=%2Fjoin%2FJOIN-SECRET" },
    });
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(out.request?.url).toBe("https://vibesocials.wtf/login?callbackUrl=[Filtered]");
    expect(out.request?.query_string).toBe("callbackUrl=[Filtered]");
  });

  it("a navigation breadcrumb to a #token page loses the fragment", () => {
    const out = redactForSentry({ category: "navigation", data: { from: "/login", to: "/reset-password#RESET-SECRET" } });
    expect(out.data).toEqual({ from: "/login", to: "/reset-password" });
  });

  it("a span's fragment attributes are dropped", () => {
    const out = redactForSentry({
      op: "pageload",
      description: "/reset-password",
      data: { "url.fragment": "RESET-SECRET", "http.fragment": "#RESET-SECRET", "url.full": "https://vibesocials.wtf/reset-password#RESET-SECRET" },
    });
    expect(out.data).toEqual({ "url.full": "https://vibesocials.wtf/reset-password" });
  });
});

// R43 review: the browser's own fetch spans carry the API path, token included.
describe("redactForSentry: the browser's fetch spans", () => {
  it("a fetch span for /api/invites/<token> keeps no token in its description, url or http.url", () => {
    const out = redactForSentry({
      op: "http.client",
      description: "POST https://vibesocials.wtf/api/invites/INVITE-SECRET/accept",
      data: {
        url: "https://vibesocials.wtf/api/invites/INVITE-SECRET/accept",
        "http.url": "https://vibesocials.wtf/api/invites/INVITE-SECRET/accept",
        "http.method": "POST",
      },
    });
    expect(JSON.stringify(out)).not.toContain("INVITE-SECRET");
    expect(out.description).toBe("POST https://vibesocials.wtf/api/invites/[token]/accept");
    expect(out.data["http.method"]).toBe("POST");
  });

  it("the server's span rule keeps the outgoing rules and redacts tokens too", () => {
    const out = redactForSentry({
      op: "http.client",
      description: "GET https://vibesocials.wtf/api/review-link/REVIEW-SECRET",
      data: { "url.full": "https://vibesocials.wtf/api/review-link/REVIEW-SECRET?x=1" },
    });
    expect(out.data["url.full"]).toBe("https://vibesocials.wtf/api/review-link/[token]");
  });

  it("a transaction event's spans are redacted too", () => {
    const out = redactForSentry({
      spans: [{ op: "http.client", description: "GET /api/upload-link/UPLOAD-SECRET/media", data: { url: "/api/upload-link/UPLOAD-SECRET/media" } }],
    });
    expect(JSON.stringify(out)).not.toContain("UPLOAD-SECRET");
  });
});

// R44 (security M1, L1): one rule for the whole event. Cookies and request
// headers are never collected (SENTRY_DATA_COLLECTION), and as a second guard
// redactForSentry drops them and walks every string in what it is given.
describe("redactForSentry: nothing private in the whole event", () => {
  const SESSION_COOKIE = "__Secure-next-auth.session-token=JWT-SECRET-1; theme=dark";
  // What Next sends on /c/<token>: the dynamic segment's value inside URL-encoded JSON.
  const ROUTER_STATE = encodeURIComponent(
    JSON.stringify(["", { children: ["c", { children: [["token", "STATE-SECRET-1", "d"], { children: ["__PAGE__", {}] }] }] }, null, null, true]),
  );

  const event = {
    transaction: "GET /c/PATH-SECRET-1",
    request: {
      url: "https://vibesocials.wtf/api/review-link/PATH-SECRET-2",
      method: "GET",
      cookies: { "__Secure-next-auth.session-token": "JWT-SECRET-1" },
      headers: {
        cookie: SESSION_COOKIE,
        "User-Agent": "Mozilla/5.0 test",
        Referer: "https://vibesocials.wtf/join/PATH-SECRET-3",
        "next-url": "/u/PATH-SECRET-4",
        "next-router-state-tree": ROUTER_STATE,
      },
    },
    contexts: {
      nextjs: { request_path: "/api/review-link/PATH-SECRET-5?x=1", router_kind: "App Router" },
      trace: { op: "http.server", data: { "http.request.header.cookie.session": "JWT-SECRET-1", "http.request.header.user_agent": "Mozilla/5.0 test" } },
    },
    tags: { path: "/v/PATH-SECRET-6", runtime: "nodejs" },
    extra: { link: "%2Fapi%2Fupload-link%2FPATH-SECRET-7%2Fupload", nested: { deeper: [{ url: "/api/invites/PATH-SECRET-8/accept" }] } },
    breadcrumbs: [{ category: "navigation", data: { from: "/", to: "/join/PATH-SECRET-9" } }],
    spans: [{ op: "http.server", description: "GET /c/PATH-SECRET-10", data: { "http.request.header.referer": "https://vibesocials.wtf/c/PATH-SECRET-10" } }],
    exception: { values: [{ type: "Error", value: "lookup failed for /api/connect-link/PATH-SECRET-11/start" }] },
    message: "callback /login?callbackUrl=%2Fjoin%2FPATH-SECRET-12",
  };

  it("keeps no token and no cookie anywhere", () => {
    const text = JSON.stringify(redactForSentry(event));
    expect(text).not.toMatch(/SECRET/);
    expect(text).not.toMatch(/session-token/);
  });

  it("drops request cookies and every request header but the user agent", () => {
    const out = redactForSentry(event);
    expect(out.request).not.toHaveProperty("cookies");
    expect(out.request.headers).toEqual({ "User-Agent": "Mozilla/5.0 test" });
    expect(out.contexts.trace.data).toEqual({ "http.request.header.user_agent": "Mozilla/5.0 test" });
    expect(out.spans[0].data).toEqual({});
  });

  it("redacts the link paths it walks into and keeps the rest", () => {
    const out = redactForSentry(event);
    expect(out.contexts.nextjs).toEqual({ request_path: "/api/review-link/[token]?x=[Filtered]", router_kind: "App Router" });
    expect(out.tags).toEqual({ path: "/v/[token]", runtime: "nodejs" });
    expect(out.extra.link).toBe("/api/upload-link/[token]/upload");
    expect(out.extra.nested.deeper[0].url).toBe("/api/invites/[token]/accept");
    expect(out.exception.values[0].value).toBe("lookup failed for /api/connect-link/[token]/start");
    expect(out.request.method).toBe("GET");
  });

  it("a router-state tree, decoded, loses the token segment's value", () => {
    expect(redactLinkTokens(decodeURIComponent(ROUTER_STATE))).not.toContain("STATE-SECRET-1");
    expect(JSON.stringify(redactForSentry({ extra: { tree: ROUTER_STATE } }))).not.toContain("STATE-SECRET-1");
  });

  it("strings without a token are unchanged, and the event given is not modified", () => {
    const plain = {
      message: "Upload failed: 50% done",
      extra: { note: "100%25 sure", list: [1, true, null, "a/b"] },
      contexts: { nextjs: { request_path: "/dashboard" } },
      request: { url: "https://vibesocials.wtf/settings" },
    };
    expect(redactForSentry(plain)).toEqual(plain);
    const before = JSON.stringify(event);
    redactForSentry(event);
    expect(JSON.stringify(event)).toBe(before);
  });

  it("leaves the SDK's processing metadata as it is", () => {
    const scope = { the: "scope" };
    const out = redactForSentry({ sdkProcessingMetadata: { capturedSpanScope: scope } });
    expect(out.sdkProcessingMetadata.capturedSpanScope).toBe(scope);
  });

  it("past its depth bound a value is dropped, never passed through", () => {
    let deep: Record<string, unknown> = { url: "/c/DEEP-SECRET" };
    for (let i = 0; i < 40; i += 1) deep = { next: deep };
    expect(JSON.stringify(redactForSentry({ extra: deep }))).not.toContain("DEEP-SECRET");
  });

  // R44 lead review: beforeBreadcrumb gets raw console arguments, which can be cyclic.
  it("a cyclic object with two back-references is walked quickly and gives [Circular]", () => {
    const node: Record<string, unknown> = { url: "/c/CYCLE-SECRET" };
    node.prev = node;
    node.next = node;
    const started = Date.now();
    const out = redactForSentry({ category: "console", data: { arguments: [node] } });
    expect(Date.now() - started).toBeLessThan(500);
    expect(out.data.arguments[0]).toEqual({ url: "/c/[token]", prev: "[Circular]", next: "[Circular]" });
  });

  it("the same object twice, side by side, is not circular", () => {
    const shared = { a: "/v/SHARED-SECRET" };
    expect(redactForSentry({ extra: { one: shared, two: shared } }).extra).toEqual({
      one: { a: "/v/[token]" },
      two: { a: "/v/[token]" },
    });
  });

  it("a browser fetch breadcrumb to a relative path keeps the path, token redacted", () => {
    const out = redactForSentry({ category: "fetch", data: { url: "/api/review-link/REL-SECRET/posts?page=2", method: "GET" } });
    expect(out.data).toEqual({ url: "/api/review-link/[token]/posts?page=[Filtered]", method: "GET" });
  });
});

describe("SENTRY_DATA_COLLECTION", () => {
  it("collects no cookies, no headers, no user, no bodies and no query values", () => {
    expect(SENTRY_DATA_COLLECTION).toMatchObject({
      cookies: false,
      httpHeaders: false,
      userInfo: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
      // R44 lead review: the source context Sentry had before (the legacy default).
      frameContextLines: 7,
    });
  });
});

// R45 security L1: Next's http.target on the root span and the browser's
// navigation breadcrumbs carry whole queries, so no query value reaches Sentry.
describe("redactForSentry: every query value is filtered, every name kept", () => {
  it.each([
    ["/admin?q=person%40example.com", "/admin?q=[Filtered]"],
    [
      "/api/instagram-photo?src=https%3A%2F%2Fblob.example%2Fp.jpg&exp=1763380000&sig=SIG-SECRET",
      "/api/instagram-photo?src=[Filtered]&exp=[Filtered]&sig=[Filtered]",
    ],
    [
      "/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=VERIFY-SECRET&hub.challenge=123",
      "/api/webhooks/meta?hub.mode=[Filtered]&hub.verify_token=[Filtered]&hub.challenge=[Filtered]",
    ],
    [
      "https://vibesocials.wtf/api/oauth/x/callback?oauth_token=TOKEN-SECRET&oauth_verifier=VERIFIER-SECRET",
      "https://vibesocials.wtf/api/oauth/x/callback?oauth_token=[Filtered]&oauth_verifier=[Filtered]",
    ],
    [
      "GET /api/oauth/google/callback?code=CODE-SECRET&state=STATE-SECRET",
      "GET /api/oauth/google/callback?code=[Filtered]&state=[Filtered]",
    ],
  ])("%s becomes %s", (input, output) => {
    expect(redactLinkTokens(input)).toBe(output);
    const out = redactForSentry({
      contexts: { trace: { op: "http.server", data: { "http.target": input } } },
      breadcrumbs: [{ category: "navigation", data: { from: "/dashboard", to: input } }],
    });
    expect(out.contexts.trace.data["http.target"]).toBe(output);
    expect(out.breadcrumbs[0].data.to).toBe(output);
    expect(JSON.stringify(out)).not.toMatch(/SECRET|person|1763380000/);
  });

  it("a bare query string keeps its names only", () => {
    expect(redactForSentry({ request: { query_string: "q=person%40example.com&page=2" } }).request.query_string).toBe(
      "q=[Filtered]&page=[Filtered]",
    );
  });

  it.each(["/dashboard", "https://vibesocials.wtf/settings", "/posts?draft", "/login?callbackUrl="])(
    "%s, with no query value, is unchanged",
    (input) => {
      expect(redactLinkTokens(input)).toBe(input);
      expect(redactForSentry({ message: input }).message).toBe(input);
    },
  );
});

// R45 review L2: a value is filtered whole, whatever it decodes to.
describe("redactForSentry: an encoded space never ends a filtered value", () => {
  it.each([
    ["/admin?q=jane%20doe%40gmail.com", "/admin?q=[Filtered]"],
    ["/admin?q=jane+doe%40gmail.com", "/admin?q=[Filtered]"],
    ["https://vibesocials.wtf/admin?q=jane%20doe%40gmail.com&page=2", "https://vibesocials.wtf/admin?q=[Filtered]&page=[Filtered]"],
    ["%2Flogin%3Fq%3Djane%20doe%40gmail.com", "/login?q=[Filtered]"],
    ["%2Flogin%3Fq%3Djane+doe%40gmail.com%26x%3D1", "/login?q=[Filtered]&x=[Filtered]"],
  ])("%s becomes %s", (input, output) => {
    const out = redactForSentry({ message: input, breadcrumbs: [{ category: "navigation", data: { to: input } }] });
    expect(out.message).toBe(output);
    expect(out.breadcrumbs[0].data.to).toBe(output);
    expect(JSON.stringify(out)).not.toMatch(/jane|doe|gmail/);
  });

  it("a token hidden by encoding is still redacted", () => {
    expect(redactForSentry({ message: "%2Fc%2FHIDDEN-SECRET" }).message).toBe("/c/[token]");
  });
});

// R46 security L1: each pattern ran from every "/" or "?" to the end of the
// text, so the time grew with the square of its length, on text anyone can send.
describe("redaction time on long crafted text", () => {
  function timed(item: unknown): number {
    const started = performance.now();
    redactForSentry(item);
    return performance.now() - started;
  }

  it("40,000 slashes redact in under 50 ms", () => {
    expect(timed({ message: "/".repeat(40_000) })).toBeLessThan(50);
  });

  it("40,000 question marks redact in under 50 ms", () => {
    expect(timed({ message: "?".repeat(40_000) })).toBeLessThan(50);
  });

  it("a 15 KB /api/media?//// URL event redacts in under 50 ms", () => {
    const url = `/api/media?${"/".repeat(15_000)}`;
    const event = {
      transaction: `GET ${url}`,
      request: { url: `https://vibesocials.wtf${url}` },
      exception: { values: [{ value: `Bad request ${url}` }] },
      contexts: { trace: { data: { "http.target": url } } },
    };
    expect(timed(event)).toBeLessThan(50);
  });

  it("a long string is cut, says so, and keeps nothing a token could hide in", () => {
    const text = `${"a".repeat(5_000)} /c/LONG-SECRET?code=LONG-CODE`;
    const out = redactForSentry({ message: text }).message;
    expect(out.length).toBeLessThan(text.length);
    expect(out.endsWith(CUT_MARK)).toBe(true);
    expect(out).not.toContain("LONG-SECRET");
    expect(out).not.toContain("LONG-CODE");
  });

  it("a cut inside a link token or a query value still hides what is left of it", () => {
    // The cut falls a few characters into each secret.
    for (const tail of ["/c/SECRETTOKENVALUE", "?code=SECRETCODEVALUE", "/r#SECRETFRAGMENT"]) {
      const text = `${"a".repeat(MAX_REDACTED_LENGTH - 10)} ${tail}`;
      const out = redactForSentry({ message: text }).message;
      expect(out, tail).not.toMatch(/SEC/);
    }
  });

  it("keeps a fragment's path and a query name, as before", () => {
    expect(redactLinkTokens("see /a/b/c#frag and https://x.test/p#q")).toBe("see /a/b/c and https://x.test/p");
    expect(redactLinkTokens("/p??a=1&b/c=2")).toBe(`/p??a=${FILTERED_VALUE}&b/c=${FILTERED_VALUE}`);
    expect(redactLinkTokens("/p?a?b=1")).toBe(`/p?a?b=${FILTERED_VALUE}`);
  });
});

// R46 review: a cut inside a %XX escape, or a stray "%", made decodeURIComponent
// throw, and the string went out without the decoded redaction.
describe("the decoded pass survives a broken escape", () => {
  const ENCODED_LINK = "see %2Fc%2FSECRETTOKENVALUE now";

  it("a token padded to 4,081-4,094 characters is redacted wherever the cut lands", () => {
    for (let length = 4081; length <= 4094; length += 1) {
      const text = `${ENCODED_LINK} ${"a".repeat(length - ENCODED_LINK.length - 1)}${"%2F".repeat(10)}`;
      expect(text.length).toBeGreaterThan(MAX_REDACTED_LENGTH);
      const out = redactForSentry({ message: text }).message;
      expect(out, String(length)).not.toContain("SECRETTOKENVALUE");
      expect(out, String(length)).toContain(`/c/${LINK_TOKEN}`);
      expect(out.endsWith(CUT_MARK), String(length)).toBe(true);
      // No half escape is left before the mark.
      expect(out.slice(0, -CUT_MARK.length), String(length)).not.toMatch(/%[0-9A-Fa-f]?$/);
    }
  });

  it("a string with 100% and an encoded /c/ link is redacted", () => {
    const out = redactForSentry({ message: `Upload 100% done, ${ENCODED_LINK}` }).message;
    expect(out).not.toContain("SECRETTOKENVALUE");
    expect(out).toContain("100%");
  });

  // R46 last look: only the escapes of URL structure decode; a non-ASCII or
  // invalid escape stays as it is in the text.
  it("a non-ASCII, partial or invalid escape is left as it is beside a decoded token", () => {
    const out = redactForSentry({ message: "bad %E5%AF %E2%82 %zz then %2Fc%2FSECRETTOKENVALUE and caf%C3%A9" }).message;
    expect(out).not.toContain("SECRETTOKENVALUE");
    expect(out).toContain(`/c/${LINK_TOKEN}`);
    expect(out).toContain("%E5%AF %E2%82 %zz");
    expect(out).toContain("caf%C3%A9");
  });

  it("encoded /c/, /u/, /join/ and /v/ tokens are redacted at every padding from 4,060 to 4,099", () => {
    for (const prefix of ["c", "u", "join", "v"]) {
      const link = `see %2F${prefix}%2FSECRETTOKENVALUE now`;
      for (let length = 4060; length <= 4099; length += 1) {
        for (const tail of ["%2F".repeat(20), "%E2%82".repeat(10), "100%".repeat(10), "%zz".repeat(10)]) {
          const text = `${link} ${"a".repeat(Math.max(0, length - link.length - 1))}${tail}`;
          const out = redactForSentry({ message: text }).message;
          const at = `${prefix} ${length} ${tail.slice(0, 6)}`;
          expect(out, at).not.toContain("SECRETTOKENVALUE");
          expect(out, at).toContain(`/${prefix}/${LINK_TOKEN}`);
          if (out.endsWith(CUT_MARK)) expect(out.slice(0, -CUT_MARK.length), at).not.toMatch(/%[0-9A-Fa-f]?$/);
        }
      }
    }
  });

  it("a whole event of ?%FF… or ?%E2%82… (URL and 20 breadcrumbs) redacts in under 50 ms", () => {
    for (const run of ["%FF", "%E2%82"]) {
      const url = `https://vibesocials.wtf/api/media?${run.repeat(Math.ceil(4096 / run.length))}`;
      const event = {
        request: { url },
        transaction: `GET ${url}`,
        breadcrumbs: Array.from({ length: 20 }, () => ({ category: "navigation", data: { from: url, to: url } })),
      };
      const started = performance.now();
      redactForSentry(event);
      expect(performance.now() - started, run).toBeLessThan(50);
    }
  });

  it("40,000 % characters and 40,000 %2 pairs stay fast", () => {
    for (const text of ["%".repeat(40_000), "%2".repeat(40_000)]) {
      const started = performance.now();
      redactForSentry({ message: text });
      expect(performance.now() - started).toBeLessThan(50);
    }
  });

  it("stays fast on a long run of broken escapes", () => {
    const started = performance.now();
    redactForSentry({ message: `${"%E5".repeat(1_300)} %2Fc%2FSECRET` });
    expect(performance.now() - started).toBeLessThan(50);
  });
});
