// Applies pending Prisma migrations during the Vercel PRODUCTION build.
//
// Why: deploys previously shipped code automatically while the schema had to
// be migrated by hand — which is exactly how prod ran for days with the
// `20260714*` migrations unapplied (every User read threw P2022 and signup
// 500'd; found + fixed 2026-07-17). This makes "deploy to main" atomic-ish:
// migrations land right before the build that expects them.
//
// Scope guard: VERCEL_ENV === "production" ONLY.
// - Local `npm run build` (VERCEL_ENV unset) skips — no accidental writes
//   from a developer machine; dev-db-guard covers `npm run dev` separately.
// - Preview builds skip too: preview shares the production DATABASE_URL, so
//   letting a PR's preview build migrate the live DB would apply schema
//   changes before that PR is even reviewed.
import { execSync } from "node:child_process";

if (process.env.VERCEL_ENV !== "production") {
  console.log(
    `[migrate-on-vercel-prod] VERCEL_ENV=${process.env.VERCEL_ENV ?? "(unset)"} — skipping prisma migrate deploy.`,
  );
  process.exit(0);
}

console.log("[migrate-on-vercel-prod] production build — running prisma migrate deploy…");
execSync("npx prisma migrate deploy", { stdio: "inherit" });
