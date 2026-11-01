/**
 * Post-sign-in redirect targets (`?callbackUrl=`) are attacker-controlled: a
 * link to `/login?callbackUrl=/%5Cexample.com` used to send the browser to
 * example.com after a real sign-in, because the page only checked for a
 * leading "/" and no "//", and browsers treat "/\" like "//" (protocol-
 * relative). Every page that FOLLOWS a callbackUrl client-side runs it through
 * `safeCallbackPath` first.
 */

/** Base for parsing a relative path. `.invalid` can never resolve (RFC 2606). */
const INTERNAL_ORIGIN = "http://internal.invalid";

// ASCII control characters (C0 + DEL) and any whitespace. Browsers silently
// strip TAB/CR/LF from URLs ("/<TAB>/evil.com" becomes "//evil.com"), so none
// of these may appear anywhere in an accepted path.
const CONTROL_OR_WHITESPACE = /[\u0000-\u001f\u007f\s]/;

/**
 * The path rules, applied to BOTH the raw input and the parsed result:
 * - starts with exactly one "/" (no "//" protocol-relative URL);
 * - no backslash — literal, or percent-encoded as `%5C`, which is harmless to
 *   the URL parser but becomes a backslash for any consumer that decodes once
 *   more (no real app path contains one);
 * - no ASCII control character or whitespace.
 */
function isSafeRelativePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("\\") || /%5c/i.test(path)) return false;
  return !CONTROL_OR_WHITESPACE.test(path);
}

/**
 * Return `raw` as a same-origin relative path (`pathname + search + hash`), or
 * `fallback` when it isn't one. Accepted only when ALL hold:
 * - `raw` passes `isSafeRelativePath`;
 * - resolving it against an internal base keeps that base's origin;
 * - the RESULT passes `isSafeRelativePath` too. Parsing collapses dot
 *   segments after the input checks, so "/..//evil.com" (or "/%2e%2e//…",
 *   "/a/..//…") parses to the protocol-relative "//evil.com" — which a
 *   router.push would send off-site.
 */
export function safeCallbackPath(raw: string | null | undefined, fallback = "/"): string {
  if (typeof raw !== "string" || !isSafeRelativePath(raw)) return fallback;

  let parsed: URL;
  try {
    parsed = new URL(raw, INTERNAL_ORIGIN);
  } catch {
    return fallback;
  }
  if (parsed.origin !== INTERNAL_ORIGIN) return fallback;

  const result = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return isSafeRelativePath(result) ? result : fallback;
}

/**
 * Link to an auth page (`/login`, `/register`) that carries the callbackUrl
 * along, so hopping between the two pages still lands the user back where they
 * started (e.g. a `/join/<token>` invite). The value is re-sanitized here;
 * the default "/" is left off the link.
 */
export function authPageHref(path: string, callbackUrl: string): string {
  const safe = safeCallbackPath(callbackUrl);
  return safe === "/" ? path : `${path}?callbackUrl=${encodeURIComponent(safe)}`;
}
