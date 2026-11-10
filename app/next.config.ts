import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // Allow larger file uploads for videos
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
  },
  // Auth-path aliases people actually type. Without these, an anonymous
  // visitor at /signup was middleware-bounced to /login?callbackUrl=%2Fsignup
  // — a login form in response to trying to sign up, and a 404 after logging
  // in. Redirects run before middleware, so these never hit that path.
  async redirects() {
    return [
      { source: "/signup", destination: "/register", permanent: true },
      { source: "/sign-up", destination: "/register", permanent: true },
      { source: "/signin", destination: "/login", permanent: true },
      { source: "/sign-in", destination: "/login", permanent: true },
    ];
  },
  // No page of this app is meant to be shown inside another site's frame, and
  // the signed-in pages carry one-click controls (disconnect an account, remove
  // a member, cancel a post) that a framing page could trick a user into
  // clicking. Browsers also must not guess a response's type from its bytes.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      // Phones must check for a new service worker on every visit, so a fix
      // to it is not held back by an HTTP cache.
      {
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      },
    ];
  },
};

// Health track H1 — Sentry build wrapper (source-map upload + build-time
// instrumentation). Strictly additive and gated:
//
// - No SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN -> `withSentryConfig` is never
//   called at all; `next build` sees the exact `nextConfig` object above,
//   byte-for-byte, same as before this file existed. This is THE guarantee
//   that the production build succeeds with zero Sentry env.
// - DSN set but no SENTRY_AUTH_TOKEN -> still wraps (for the webpack-level
//   error/performance instrumentation), but `sourcemaps.disable: true` means
//   no source-map upload is attempted, so no auth-token-shaped failure is
//   possible either way.
// - Both set -> full source-map upload, as normal.
const sentryDsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;

export default sentryDsn
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: sentryAuthToken,
      sourcemaps: {
        disable: !sentryAuthToken,
      },
      // Keep build output quiet and never phone home during our own builds.
      silent: true,
      telemetry: false,
      // Conservative defaults: no ad-blocker-evading tunnel route, and no
      // widened upload of Next.js/dependency internals.
      widenClientFileUpload: false,
    })
  : nextConfig;
