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
      // Dummy, unreachable DB so `new PrismaClient()` (constructed eagerly by
      // `src/lib/db.ts`) has a DATABASE_URL to read and the server process
      // boots. Nothing this suite exercises issues a real query: the four
      // public routes under test are statically prerendered, and the
      // next-auth `jwt` session strategy never touches Prisma for an
      // unauthenticated request. See e2e/README.md for the full rationale.
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      // next-auth v4 hard-requires a `secret` once NODE_ENV=production (which
      // `next start` sets) — every page mounts `useSession()`, which calls
      // `GET /api/auth/session`, and that route 500s without this (observed:
      // "[next-auth][error][NO_SECRET] ... MissingSecretError"). Dummy value
      // is fine: this server instance is throwaway and talks to no real DB.
      NEXTAUTH_SECRET: "e2e-test-secret-do-not-use-in-production",
      // Silences next-auth's "[warn][NEXTAUTH_URL]" (harmless — it falls
      // back to inferring the URL from request headers — but this matches
      // real deployments, which always set it, and keeps webServer's log
      // free of noise that isn't ours to ignore-by-default).
      NEXTAUTH_URL: baseURL,
    },
  },
});
