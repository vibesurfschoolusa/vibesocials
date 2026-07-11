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
