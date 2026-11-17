import type { Instrumentation } from "next";

import { SENTRY_DATA_COLLECTION, redactForSentry } from "@/lib/sentryRedaction";

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
      // R44: no cookies, request headers, user, bodies or query values are
      // collected. `sendDefaultPii: false` did not stop them: with SDK 10.78 it
      // keeps the Cookie header, the parsed cookies and every request header
      // but the IP ones, so the session JWT rode along on every server event.
      dataCollection: SENTRY_DATA_COLLECTION,
      // One rule for everything that leaves the process (lib/sentryRedaction.ts):
      // outgoing upload URLs (capability URLs) lose their query and path, and
      // every string loses its link token (/c/, /u/, /v/, /join/, their API
      // routes, fragments, callbackUrl and the router-state tree).
      beforeBreadcrumb: redactForSentry,
      beforeSendSpan: redactForSentry,
      beforeSend: redactForSentry,
      beforeSendTransaction: redactForSentry,
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
