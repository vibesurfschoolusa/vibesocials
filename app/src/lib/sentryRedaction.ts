// 2026-11-02 scale audit (jobs B3): URL redaction for Sentry's automatic
// instrumentation of outgoing requests.
//
// With Sentry on, every outgoing fetch / http request leaves a breadcrumb (category
// "http" or "fetch") and, for the 10% of requests that are traced, an `http.client`
// span. Both carry the request URL, query and fragment included: the `url` /
// `url.full` / `http.url` attributes, `http.query`, `http.fragment`, `http.target`.
// Sentry's own scrubbing of that query is a denylist of key names (token, secret, key,
// sid, ...) that does not know our capability URLs: whoever holds a YouTube resumable
// session URI (`...&upload_id=...`), a TikTok `upload_url` or a LinkedIn
// `dms-uploads` part URL can write to (or finish) that upload.
//
// So nothing about an outgoing URL beyond scheme, host and path reaches Sentry, and an
// upload URL loses its path as well. These helpers are pure and edge-safe (only `URL`),
// and are wired into `Sentry.init` in `instrumentation.ts`.

/** What `redactOutgoingUrl` returns for something that is not an absolute URL. */
export const UNPARSEABLE_URL = "[unparseable-url]";

/** The path of an upload URL, whose path can itself be the secret. */
export const REDACTED_PATH = "/[redacted]";

/**
 * Hosts that are upload services (`open-upload.tiktokapis.com`, `upload.example.com`)
 * and every TikTok API host (its `upload_url` host is one of them).
 */
const UPLOAD_HOST = /upload|tiktokapis\.com$/i;

/** Paths of upload URLs: `/upload/youtube/v3/videos` (YouTube), `/dms-uploads/...` (LinkedIn). */
function isUploadPath(path: string): boolean {
  return path.includes("/dms-uploads/") || path.includes("/upload/");
}

function isUploadUrl(url: URL): boolean {
  return UPLOAD_HOST.test(url.hostname) || isUploadPath(url.pathname);
}

/**
 * `url` without credentials, query or fragment: `scheme://host[:port]/path`. The path
 * of an upload URL (see {@link isUploadUrl}) is replaced by {@link REDACTED_PATH}. A
 * string that is not an absolute URL gives {@link UNPARSEABLE_URL}.
 */
export function redactOutgoingUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return UNPARSEABLE_URL;
  }
  if (!parsed.host) return UNPARSEABLE_URL;
  return `${parsed.protocol}//${parsed.host}${isUploadUrl(parsed) ? REDACTED_PATH : parsed.pathname}`;
}

/** Every http(s) URL in a piece of text (a span name is `PUT https://host/path`). */
const URL_IN_TEXT = /https?:\/\/\S+/gi;

function redactUrlsIn(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => redactOutgoingUrl(match));
}

/** `http.target` / `url.path`: a path with a query. The query goes; an upload path is redacted. */
function redactTarget(target: string, hostIsUpload: boolean): string {
  const end = target.search(/[?#]/);
  const path = end === -1 ? target : target.slice(0, end);
  return hostIsUpload || isUploadPath(path) ? REDACTED_PATH : path;
}

/** The parts of a Sentry breadcrumb these helpers read; the real `Breadcrumb` is assignable to it. */
interface BreadcrumbLike {
  type?: string;
  category?: string;
  message?: string;
  data?: { [key: string]: unknown };
}

const HTTP_BREADCRUMBS = new Set(["http", "fetch"]);

/**
 * `beforeBreadcrumb`: for an http / fetch breadcrumb, `data.url` is redacted
 * ({@link redactOutgoingUrl}), `data["http.query"]` and `data["http.fragment"]` are
 * deleted and a URL in `message` is redacted. Any other breadcrumb is returned as it
 * is. The breadcrumb it was given is not modified.
 */
export function redactBreadcrumb<T extends BreadcrumbLike>(breadcrumb: T): T {
  const isHttp =
    (breadcrumb.category !== undefined && HTTP_BREADCRUMBS.has(breadcrumb.category)) ||
    (breadcrumb.type !== undefined && HTTP_BREADCRUMBS.has(breadcrumb.type));
  if (!isHttp) return breadcrumb;

  const out: T = { ...breadcrumb };
  if (typeof breadcrumb.message === "string") out.message = redactUrlsIn(breadcrumb.message);
  if (breadcrumb.data) {
    const data = { ...breadcrumb.data };
    if (typeof data.url === "string") data.url = redactOutgoingUrl(data.url);
    delete data["http.query"];
    delete data["http.fragment"];
    out.data = data;
  }
  return out;
}

/** The parts of a Sentry span (`SpanJSON`) these helpers read; the real one is assignable to it. */
interface SpanLike {
  op?: string;
  description?: string;
  data: { [key: string]: unknown };
}

/** Span attributes that hold an absolute URL. `url` is what the fetch instrumentation calls it. */
const SPAN_URL_KEYS = ["url", "url.full", "http.url"] as const;
/** Span attributes that hold a path with a query. */
const SPAN_TARGET_KEYS = ["http.target", "url.path"] as const;
/** Span attributes that hold only the query or the fragment. */
const SPAN_QUERY_KEYS = ["http.query", "url.query", "http.fragment", "url.fragment"] as const;

/**
 * `beforeSendSpan`: for an outgoing http request span (`op` "http.client"), the URL
 * attributes (`url`, `url.full`, `http.url`) and the URLs in the description are
 * redacted, `http.target` / `url.path` lose their query (and an upload path), and
 * `http.query`, `url.query` and the fragment attributes are deleted. Any other span
 * (incoming requests, database queries) is returned as it is. The span it was given is
 * not modified.
 */
export function redactOutgoingSpan<T extends SpanLike>(span: T): T {
  if (!span.op?.startsWith("http.client")) return span;

  const data = { ...span.data };
  const absolute = SPAN_URL_KEYS.map((key) => data[key]).find((value): value is string => typeof value === "string");
  let hostIsUpload = false;
  if (absolute !== undefined) {
    try {
      const parsed = new URL(absolute);
      hostIsUpload = UPLOAD_HOST.test(parsed.hostname);
    } catch {
      // Unreadable: redactOutgoingUrl marks it below.
    }
  }

  for (const key of SPAN_URL_KEYS) {
    if (typeof data[key] === "string") data[key] = redactOutgoingUrl(data[key]);
  }
  for (const key of SPAN_TARGET_KEYS) {
    if (typeof data[key] === "string") data[key] = redactTarget(data[key], hostIsUpload);
  }
  for (const key of SPAN_QUERY_KEYS) delete data[key];

  const out: T = { ...span, data };
  if (typeof span.description === "string") out.description = redactUrlsIn(span.description);
  return out;
}

// R43 (lead, from security's second half, and its review): incoming URLs. The
// client connect, upload and review links and the invite link carry their token
// in the path (/c/, /u/, /v/, /join/ and the API routes behind them); the account
// links (reset password, verify email, new address, undo) carry theirs in the
// #fragment; and a sign-in redirect carries a link path in its callbackUrl.
// Whoever holds the token can use the link. These URLs reach Sentry in the
// event's request, the spans (the server's and the browser's), the transaction
// name and the browser's navigation and fetch breadcrumbs, so every one of them
// goes through redactLinkTokens.

/** What a link token is replaced with. */
export const LINK_TOKEN = "[token]";

/**
 * A link path at the start of a path: after the start of the text, a space, or
 * an absolute URL's host. The token is the segment after the prefix.
 */
const LINK_TOKEN_PATH =
  /(^|\s|\/\/[^/\s?#]+)(\/(?:c|u|v|join|api\/(?:connect-link|review-link|upload-link|invites))\/)[^/?#\s]+/g;

/** A URL's or a path's #fragment: everything from "#" to the next space. */
const URL_FRAGMENT = /((?:https?:\/\/|\/)[^\s#]*)#\S*/gi;

/** One query value: `?name=` or `&name=`, then the value up to "&", "#" or a space. */
const QUERY_VALUE = /([?&][^=&#\s]+=)([^&#\s]*)/g;

function redactLinkPaths(text: string): string {
  return text.replace(LINK_TOKEN_PATH, (_match, before: string, prefix: string) => `${before}${prefix}${LINK_TOKEN}`);
}

/** A query value that holds a link path (`callbackUrl=%2Fjoin%2F<token>`), decoded, redacted and encoded again. */
function redactQueryValues(text: string): string {
  return text.replace(QUERY_VALUE, (match, name: string, value: string) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      return match;
    }
    const redacted = redactLinkPaths(decoded);
    return redacted === decoded ? match : `${name}${encodeURIComponent(redacted)}`;
  });
}

/**
 * `text` with no link token in it: every URL's or path's #fragment dropped (never
 * needed in Sentry), every query value holding a link path redacted, and the token
 * segment of every link path replaced by {@link LINK_TOKEN}.
 */
export function redactLinkTokens(text: string): string {
  return redactLinkPaths(redactQueryValues(text.replace(URL_FRAGMENT, "$1")));
}

/** Span and breadcrumb attributes that hold only a fragment. */
const FRAGMENT_KEYS = new Set(["http.fragment", "url.fragment"]);

/** A copy of `data` without fragment attributes, every string value through redactLinkTokens. */
function redactLinkTokensInData(data: { [key: string]: unknown }): { [key: string]: unknown } {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([key]) => !FRAGMENT_KEYS.has(key))
      .map(([key, value]) => [key, typeof value === "string" ? redactLinkTokens(value) : value]),
  );
}

/** A breadcrumb's message and string data without link tokens (navigation from/to, fetch url). */
export function redactLinkTokensInBreadcrumb<T extends BreadcrumbLike>(breadcrumb: T): T {
  const out: T = { ...breadcrumb };
  if (typeof breadcrumb.message === "string") out.message = redactLinkTokens(breadcrumb.message);
  if (breadcrumb.data) out.data = redactLinkTokensInData(breadcrumb.data);
  return out;
}

/** The server's `beforeBreadcrumb`: the outgoing rules, then link tokens. */
export function redactServerBreadcrumb<T extends BreadcrumbLike>(breadcrumb: T): T {
  return redactLinkTokensInBreadcrumb(redactBreadcrumb(breadcrumb));
}

/**
 * Any span's description and string attributes without link tokens: the
 * browser's `beforeSendSpan` (its page loads, navigations and fetch spans), and
 * the second half of the server's.
 */
export function redactLinkTokensInSpan<T extends SpanLike>(span: T): T {
  const out: T = { ...span, data: redactLinkTokensInData(span.data) };
  if (typeof span.description === "string") out.description = redactLinkTokens(span.description);
  return out;
}

/**
 * The server's `beforeSendSpan`: an outgoing span keeps its rules
 * ({@link redactOutgoingSpan}), then every span (an incoming request's above
 * all) loses its link tokens.
 */
export function redactServerSpan<T extends SpanLike>(span: T): T {
  return redactLinkTokensInSpan(redactOutgoingSpan(span));
}

/** The parts of a Sentry event these helpers read; the real `Event` is assignable to it. */
interface EventLike {
  transaction?: string;
  request?: { url?: string; query_string?: unknown };
  contexts?: { trace?: { description?: string; data?: { [key: string]: unknown } } };
  spans?: SpanLike[];
}

/**
 * `beforeSend` / `beforeSendTransaction`: the request URL and query string, the
 * transaction name, the trace context (a transaction's root span) and the
 * transaction's spans without link tokens. The event it was given is not modified.
 */
export function redactEventLinkTokens<T extends EventLike>(event: T): T {
  const out: T = { ...event };
  if (typeof event.transaction === "string") out.transaction = redactLinkTokens(event.transaction);
  if (event.request) {
    const request = { ...event.request };
    if (typeof request.url === "string") request.url = redactLinkTokens(request.url);
    if (typeof request.query_string === "string") request.query_string = redactQueryValues(`?${request.query_string}`).slice(1);
    out.request = request;
  }
  const trace = event.contexts?.trace;
  if (trace) {
    const redacted = { ...trace };
    if (typeof trace.description === "string") redacted.description = redactLinkTokens(trace.description);
    if (trace.data) redacted.data = redactLinkTokensInData(trace.data);
    out.contexts = { ...event.contexts, trace: redacted };
  }
  if (Array.isArray(event.spans)) out.spans = event.spans.map((span) => redactLinkTokensInSpan(span));
  return out;
}
