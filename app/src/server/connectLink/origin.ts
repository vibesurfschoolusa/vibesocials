/**
 * The app's own origin for the connect-link redirects: NEXTAUTH_URL's, as the
 * callbacks use, else the request's.
 */
export function appOrigin(request: Pick<Request, "url">): string {
  try {
    if (process.env.NEXTAUTH_URL) return new URL(process.env.NEXTAUTH_URL).origin;
  } catch {
    // Fall back to the request's own origin.
  }
  return new URL(request.url).origin;
}

/**
 * A request our own page sent: `Sec-Fetch-Site: same-origin`, or, from a
 * browser that sends no fetch metadata, an Origin equal to the app's. Anything
 * else (another site's form, a script, no headers at all) is refused, so a
 * flow only ever starts from a press on the link's page.
 */
export function isSameOriginRequest(request: Pick<Request, "url" | "headers">): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = request.headers.get("origin");
  return origin !== null && origin === appOrigin(request);
}
