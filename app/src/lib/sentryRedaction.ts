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

/**
 * A link page's dynamic segment in Next's router state (the Next-Router-State-Tree
 * header, URL-encoded JSON): `["token","<value>","d"]`. Every link page names its
 * segment `[token]`, and the tree carries the value without the path around it.
 */
const TOKEN_SEGMENT = /(\["token",")[^"]*"/g;

function redactLinkPaths(text: string): string {
  return text
    .replace(LINK_TOKEN_PATH, (_match, before: string, prefix: string) => `${before}${prefix}${LINK_TOKEN}`)
    .replace(TOKEN_SEGMENT, `$1${LINK_TOKEN}"`);
}

/** What every query value is replaced with; the names are kept. */
export const FILTERED_VALUE = "[Filtered]";

/**
 * Every query value replaced by {@link FILTERED_VALUE}, the names kept. R45
 * security L1: filtering only a value that held a link path let the rest
 * through, and Next's http.target and the browser's navigation breadcrumbs
 * carry whole queries (a search for an email address, a signed photo address,
 * a webhook's verify token, an OAuth code or verifier).
 */
function redactQueryValues(text: string): string {
  return text.replace(QUERY_VALUE, (match, name: string, value: string) => (value === "" ? match : `${name}${FILTERED_VALUE}`));
}

/**
 * `text` with no link token and no query value in it: every URL's or path's
 * #fragment dropped (never needed in Sentry), every query value replaced by
 * {@link FILTERED_VALUE}, and the token segment of every link path replaced by
 * {@link LINK_TOKEN}.
 */
export function redactLinkTokens(text: string): string {
  return redactLinkPaths(redactQueryValues(text.replace(URL_FRAGMENT, "$1")));
}

// R44 (security M1, L1): one rule for the whole event. Redacting named fields
// one at a time missed a field each review (the Cookie header, the parsed
// cookies, contexts.nextjs.request_path, Referer, Next-Url, the router-state
// tree), so the SDK is told not to collect cookies or headers at all
// (SENTRY_DATA_COLLECTION), and redactForSentry drops them again and walks
// every string of whatever it is given.

/**
 * What the SDK may collect, for both Sentry.init calls. Setting `dataCollection`
 * replaces the deprecated `sendDefaultPii`, and every field left out takes the
 * SDK's DEFAULTS, which collect the user, bodies, AI inputs and query data
 * (@sentry/core resolveDataCollectionOptions.js), so every field is set here.
 * Query values are off too: the SDK's own filter is a denylist of key names.
 */
export const SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  stackFrameVariables: false,
  // The source lines around each frame: code, not data. 7 is what the legacy
  // sendDefaultPii bridge gave (DEFAULTS would give 5), so Sentry keeps the context it had.
  frameContextLines: 7,
} as const satisfies NonNullable<import("@sentry/nextjs").BrowserOptions["dataCollection"]>;

/** Objects deeper than this are dropped, never passed on unredacted. */
const MAX_DEPTH = 24;
export const TOO_DEEP = "[too deep]";
/**
 * An object already on the path being walked. beforeBreadcrumb gets raw console
 * arguments, and `a.prev = a.next = a` would otherwise be copied about 2^24
 * times before the depth bound stops it.
 */
export const CIRCULAR = "[Circular]";

/** Span and breadcrumb attributes that hold only a fragment. */
const FRAGMENT_KEYS = new Set(["http.fragment", "url.fragment"]);

/** A header as a span attribute (`http.request.header.referer`); only the user agent is kept. */
const HEADER_ATTRIBUTE = /^http\.(request|response)\.header\./;
const USER_AGENT_ATTRIBUTE = "http.request.header.user_agent";

/** The SDK's own bookkeeping (scopes it reads after beforeSendTransaction); never sent. */
const SDK_METADATA = "sdkProcessingMetadata";

/** `name=value&name=value`, with no space, "/" before the first "=", "?" or "#". */
const BARE_QUERY = /^[^\s/?#=&]+=[^\s#]*$/;

/** `text` through redactLinkTokens, and decoded first when only the decoded form shows a token. */
function redactString(text: string): string {
  // A bare query string (an event's request.query_string) has no "?" for QUERY_VALUE to start at.
  if (BARE_QUERY.test(text)) return redactQueryValues(`?${text}`).slice(1);
  const redacted = redactLinkTokens(text);
  if (!text.includes("%")) return redacted;
  let decoded: string;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    return redacted;
  }
  if (decoded === text) return redacted;
  const decodedRedacted = redactLinkTokens(decoded);
  return decodedRedacted === decoded ? redacted : decodedRedacted;
}

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const ABSOLUTE_URL = /^https?:\/\//i;

/**
 * The outgoing-request rules, for an http / fetch breadcrumb or an http.client
 * span whose URL is absolute. A relative URL (the browser's fetch to our own
 * routes) is ours, never an upload service, and keeps its path.
 */
function applyOutgoingRules(value: { [key: string]: unknown }): { [key: string]: unknown } {
  const data = isPlainObject(value.data) ? value.data : undefined;
  const url = data?.url;
  if (typeof url === "string" && !ABSOLUTE_URL.test(url)) return value;
  if (typeof value.op === "string" && data) return redactOutgoingSpan(value as unknown as SpanLike) as unknown as typeof value;
  return redactBreadcrumb(value as BreadcrumbLike) as typeof value;
}

/** An event's request: no cookies, and of its headers only the user agent. */
function redactRequest(request: { [key: string]: unknown }): { [key: string]: unknown } {
  const out: { [key: string]: unknown } = { ...request };
  delete out.cookies;
  if (isPlainObject(request.headers)) {
    out.headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.toLowerCase() === "user-agent"));
  } else {
    delete out.headers;
  }
  return out;
}

/** `path`: the arrays and objects from the root down to this value, so a cycle is cut, not copied. */
function walk(value: unknown, depth: number, path: Set<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    if (path.has(value)) return CIRCULAR;
    if (depth >= MAX_DEPTH) return TOO_DEEP;
    path.add(value);
    const items = value.map((item) => walk(item, depth + 1, path));
    path.delete(value);
    return items;
  }
  if (!isPlainObject(value)) return value;
  if (path.has(value)) return CIRCULAR;
  if (depth >= MAX_DEPTH) return TOO_DEEP;
  path.add(value);

  const outgoing = applyOutgoingRules(value);
  const out: { [key: string]: unknown } = {};
  for (const [key, item] of Object.entries(outgoing)) {
    if (FRAGMENT_KEYS.has(key)) continue;
    if (HEADER_ATTRIBUTE.test(key) && key !== USER_AGENT_ATTRIBUTE) continue;
    if (depth === 0 && key === SDK_METADATA) {
      out[key] = item;
      continue;
    }
    const next = depth === 0 && key === "request" && isPlainObject(item) ? redactRequest(item) : item;
    out[key] = walk(next, depth + 1, path);
  }
  path.delete(value);
  return out;
}

/**
 * The one Sentry hook, for beforeSend, beforeSendTransaction, beforeSendSpan and
 * beforeBreadcrumb, on the server and in the browser. A copy of `item` in which:
 * an event's request has no cookies and no header but the user agent; no span
 * attribute holds a header but the user agent, or a fragment; outgoing http
 * breadcrumbs and spans keep the outgoing-URL rules; and every string, at any
 * depth up to {@link MAX_DEPTH}, goes through redactLinkTokens (decoded first when
 * only its decoded form shows a token). The item it was given is not modified.
 */
export function redactForSentry<T>(item: T): T {
  return walk(item, 0, new Set()) as T;
}
