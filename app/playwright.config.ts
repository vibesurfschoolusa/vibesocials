import { defineConfig, devices } from "@playwright/test";

/**
 * Health track H3 — E2E harness.
 *
 * Scope reality: this sandbox has no database and no OAuth credentials, so
 * only PUBLIC routes (login/register/privacy/terms — see
 * `e2e/public-routes.smoke.spec.ts`) can be exercised end-to-end here. The
 * authenticated core flows in `e2e/core-flows.spec.ts` are scaffolded but
 * skipped unless `E2E_DATABASE_URL` is set — see `e2e/README.md`.
 *
 * Chromium only, headless, single project. Kept deliberately separate from
 * Vitest (`vitest.config.ts` only ever globs `src/**\/*.test.ts`, so it never
 * sees this directory; this config in turn only ever looks under `testDir`).
 */

const PORT = 3000;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",

  use: {
    baseURL,
    headless: true,
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // Builds and boots the real Next.js server for the duration of the run.
  webServer: {
    command: "npm run build && npm run start",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    // `npm run build` (prisma generate + next build) plus `next start` can
    // take a while on a cold cache or a slow CI runner; generous on purpose.
    timeout: 180_000,
    env: {
      // DATABASE_URL resolution:
      //  - Smoke-only run (no E2E_DATABASE_URL): a dummy, unreachable DB so
      //    `new PrismaClient()` (constructed eagerly by `src/lib/db.ts`) has a
      //    URL to read and the server boots. Nothing the smoke suite exercises
      //    issues a real query — the four public routes are statically
      //    prerendered and the next-auth `jwt` strategy never touches Prisma
      //    for an unauthenticated request (see e2e/README.md).
      //  - core-flows run: when `E2E_DATABASE_URL` is set (a throwaway,
      //    migrated test Postgres — NEVER prod), the webServer MUST boot
      //    against it or every authenticated flow would hit the unreachable
      //    dummy. `webServer.env` fully replaces the child's environment, so
      //    without threading it through here the CI/local core-flow run could
      //    never reach a real database. Falls back to the dummy so the
      //    smoke-only path is byte-for-byte unchanged.
      DATABASE_URL:
        process.env.E2E_DATABASE_URL ?? "postgresql://user:pass@localhost:5432/db",
      // next-auth v4 hard-requires a `secret` once NODE_ENV=production (which
      // `next start` sets) — every page mounts `useSession()`, which calls
      // `GET /api/auth/session`, and that route 500s without this (observed:
      // "[next-auth][error][NO_SECRET] ... MissingSecretError"). A fixed dummy
      // is fine for the throwaway server; honor an explicit override so a
      // core-flow run can sign a real, decodable session cookie (the login
      // flow depends on the running server and the encoder agreeing on it).
      NEXTAUTH_SECRET:
        process.env.NEXTAUTH_SECRET ?? "e2e-test-secret-do-not-use-in-production",
      // Silences next-auth's "[warn][NEXTAUTH_URL]" (harmless — it falls
      // back to inferring the URL from request headers — but this matches
      // real deployments, which always set it, and keeps webServer's log
      // free of noise that isn't ours to ignore-by-default).
      NEXTAUTH_URL: baseURL,
      // Blob store token for the compose/schedule/invite flows' upload step
      // (@vercel/blob/client, src/app/api/upload/route.ts). Only threaded
      // through when present — those flows are additionally gated on
      // E2E_STUBS_READY in core-flows.spec.ts, so the DB-only flows never need
      // it. Passing `undefined` here is a no-op (the key is simply absent).
      ...(process.env.BLOB_READ_WRITE_TOKEN
        ? { BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN }
        : {}),
    },
  },
});
