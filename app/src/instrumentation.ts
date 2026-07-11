import type { Instrumentation } from "next";

// Health track H1 — server/edge Sentry init (Next.js instrumentation hook,
// stable since Next 15; see https://nextjs.org/docs/app/guides/instrumentation).
//
// THE OVERRIDING CONSTRAINT: with no DSN env, `register()` returns before
// touching `@sentry/nextjs` at all, and `onRequestError` below early-returns
// before calling into Sentry. Sentry is a real dependency (so imports here
// are cheap/side-effect-free — see the package's own docs), but nothing it
// exports is ever CALLED unless a DSN is configured.

/** Prefer the server-only `SENTRY_DSN`; fall back to `NEXT_PUBLIC_SENTRY_DSN`
 *  so a deployment that only sets the public var (one DSN for client+server)
 *  still gets server/edge capture. Same fallback order as
 *  `lib/logger.ts`'s `isSentryEnabled()`. */
function resolveDsn(): string | undefined {
  return process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;
}

/** Runs once when a new server instance starts, for BOTH the Node.js and
 *  edge runtimes (Next calls `register()` in both). */
export async function register(): Promise<void> {
  const dsn = resolveDsn();
  if (!dsn) {
    return;
  }

  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn,
      tracesSampleRate: 0.1,
      enabled: true,
      // Explicit (matches the default): do not auto-attach request headers,
      // cookies, or IP addresses to events. The logger's own key-based
      // redaction (see lib/logger.ts) covers what we explicitly log; this
      // keeps Sentry's OWN auto-instrumentation from ever picking up an
      // Authorization/Cookie header by default.
      sendDefaultPii: false,
    });
  }
}

/** Server-side error hook for Route Handlers, Server Components, Server
 *  Actions, and proxy/middleware errors — see
 *  https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation#onrequesterror */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (!resolveDsn()) {
    return;
  }
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(error, request, context);
};
