import * as Sentry from "@sentry/nextjs";

// Health track H1 — client-side Sentry init.
//
// `instrumentation-client.ts` is a Next.js file convention (stable, no
// exports required): it runs before the app becomes interactive, in the
// browser. See
// https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client
//
// THE OVERRIDING CONSTRAINT: with no NEXT_PUBLIC_SENTRY_DSN, `Sentry.init`
// below is simply never called (the whole body is guarded by `if (dsn)`), so
// nothing initializes by default. Merely importing `@sentry/nextjs` has no
// observable side effect on its own (no network calls, no global patches) --
// only `init()` does real work -- so this early-return is the complete gate.
// `NEXT_PUBLIC_` because this value must reach client-side code (server-only
// `SENTRY_DSN` is not visible here).

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    enabled: true,
    // Explicit (matches the default) -- see instrumentation.ts for why.
    sendDefaultPii: false,
  });
}

// Next.js calls this hook (if exported) on every client-side navigation,
// UNCONDITIONALLY -- not gated on whether Sentry initialized above. It must
// therefore always be a real, safe function: Sentry's own tracer when
// enabled, a genuine no-op (never `undefined`, never throws) when disabled.
export const onRouterTransitionStart = dsn ? Sentry.captureRouterTransitionStart : (): void => {};
