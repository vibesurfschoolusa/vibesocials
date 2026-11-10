import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

/**
 * Central auth gate for app pages — Next 16's `proxy` file convention (the
 * renamed `middleware`; the default export and `config.matcher` work the same).
 *
 * API routes handle their own 401s (session + workspace checks). This proxy
 * only protects document navigations so a new page cannot ship without an auth
 * redirect. Public routes and the signed-out marketing home (`/`) stay open.
 *
 * Join links (`/join/*`) require a signed-in user; unauthenticated visitors are
 * sent to login with callbackUrl preserved (same as the page-level gate).
 */
export default withAuth(
  function proxy() {
    return NextResponse.next();
  },
  {
    pages: {
      signIn: "/login",
    },
    callbacks: {
      authorized: ({ token, req }) => {
        const { pathname } = req.nextUrl;

        // Always allow NextAuth and public assets (matcher already excludes
        // most static files; keep defensive).
        if (
          pathname.startsWith("/api/") ||
          pathname.startsWith("/_next/") ||
          pathname === "/favicon.ico"
        ) {
          return true;
        }

        if (isPublicPath(pathname)) {
          return true;
        }

        // Dashboard root hosts both the signed-out landing and the signed-in
        // home — never force auth here.
        if (pathname === "/") {
          return true;
        }

        // Require a JWT with a user id claim. sessionVersion is re-checked in
        // the jwt callback / getCurrentUser (this gate stays DB-free: it runs
        // on every matched request); a null/empty token after password reset
        // fails here once the cookie is cleared by a session fetch.
        return !!token?.id || !!token?.sub;
      },
    },
  },
);

export function isPublicPath(pathname: string): boolean {
  // The browser fetches these without cookies when installing the app. Exact
  // matches only: neither has anything under it.
  if (pathname === "/manifest.webmanifest" || pathname === "/sw.js") {
    return true;
  }
  const prefixes = [
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password",
    "/verify-email",
    "/privacy",
    "/terms",
    "/data-deletion",
    "/about",
    "/help",
  ];
  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export const config = {
  matcher: [
    /*
     * Match all paths except static files and images.
     * API routes are included in the matcher but authorized always returns
     * true for /api/* so route handlers keep their own auth.
     */
    "/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
