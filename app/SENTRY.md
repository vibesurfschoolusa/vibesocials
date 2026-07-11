# Sentry error monitoring

Error monitoring is **off by default**. The app builds and runs identically
whether or not any of these are set — nothing below is required.

## Env vars (all optional)

| Variable | Where | Purpose |
| --- | --- | --- |
| `SENTRY_DSN` | server | Enables server/edge error capture (`src/instrumentation.ts`). Also enables the logger's `warn`/`error` → Sentry forwarding (`src/lib/logger.ts`). |
| `NEXT_PUBLIC_SENTRY_DSN` | server + browser | Enables client-side error capture (`src/instrumentation-client.ts`). Must be `NEXT_PUBLIC_*` to reach browser code; also counts as an enable signal for the logger's Sentry forwarding, same as `SENTRY_DSN`. |
| `SENTRY_AUTH_TOKEN` | build only | Enables source-map upload during `next build` (via `withSentryConfig` in `next.config.ts`). Without it, source maps are never uploaded — the build still succeeds, Sentry just shows minified stack traces. |
| `SENTRY_ORG` / `SENTRY_PROJECT` | build only | Org/project slug for source-map upload. Only relevant alongside `SENTRY_AUTH_TOKEN`. |

## How to enable

Set `SENTRY_DSN` (and `NEXT_PUBLIC_SENTRY_DSN`, same value, for client-side
errors too) in your deployment environment (e.g. Vercel project env vars),
redeploy, and errors start flowing. Add `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` +
`SENTRY_PROJECT` on top of that to get readable (un-minified) stack traces
via source-map upload.

## What's gated, and how

- **`src/lib/logger.ts`** — the structured logger used across server code
  (`logger.debug/info/warn/error`). Works as a plain console logger with zero
  Sentry env. `warn`/`error` calls only forward to Sentry
  (`captureMessage`/`captureException`) when `isSentryEnabled()` is true.
  Context is deep-redacted (SEC-1 — see the denylist in `logger.ts`) before
  it is ever written to the console OR forwarded to Sentry.
- **`src/instrumentation.ts`** — server/edge init. `register()` returns
  immediately if `SENTRY_DSN` is unset; `onRequestError` returns immediately
  under the same condition.
- **`src/instrumentation-client.ts`** — browser init. `Sentry.init(...)` is
  only called if `NEXT_PUBLIC_SENTRY_DSN` is set.
- **`next.config.ts`** — `withSentryConfig` (the build-time wrapper that
  enables source-map upload and build instrumentation) is only applied if a
  DSN is set; with none, `next build` sees the plain `nextConfig` object,
  unmodified. Even when a DSN is set, source maps are only uploaded if
  `SENTRY_AUTH_TOKEN` is also present (`sourcemaps: { disable: !authToken }`).

None of the above throws, alters a response, or fails the build when the
relevant env var is absent.
