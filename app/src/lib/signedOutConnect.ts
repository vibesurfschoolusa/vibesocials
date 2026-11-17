import { NextResponse } from "next/server";

/**
 * R44 pages-a L6: where an OAuth start sends a person whose session ended. A
 * Connect is only pressed on Settings, so sign-in brings them back there
 * (the login page reads `callbackUrl` through safeCallbackPath). One rule for
 * every platform's start route.
 * `base`: the origin the route already redirected against.
 */
export function signedOutConnectRedirect(base: string | URL | undefined): NextResponse {
  const url = new URL("/login", base);
  url.searchParams.set("callbackUrl", "/settings");
  return NextResponse.redirect(url);
}
