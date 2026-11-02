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
