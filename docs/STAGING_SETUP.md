# Staging setup and the dev-database guard

How to run Vibe Socials against a safe database in development, and what the new
`predev` guard does.

## Why this exists

`app/.env.local` on the maintainer machine points at the **production** Neon
database. Nothing stops a routine `npm run dev` from booting the app against the
live data - and worse, `prisma migrate dev`, `prisma db push`, or a seed script
run in that shell would mutate or wipe production.

To make that mistake loud instead of silent, `npm run dev` now runs a guard
first:

- **Script:** `app/scripts/dev-db-guard.mjs`, wired as the npm `predev` hook
  (`app/package.json`). Zero dependencies.
- **What it does:** reads `DATABASE_URL` from `.env.local`, parses the host, and
  **refuses to start `next dev`** (exit 1, bordered banner) when the host is
  remote. `localhost`, `127.0.0.1`, and `::1` are allowed and start silently.
- **Fail-open by design:** a missing `.env.local`, a missing `DATABASE_URL`, or
  a URL it cannot parse all exit 0 - the guard never bricks a fresh clone's
  first `npm run dev`. It only blocks the one case it is certain about: a
  parseable, non-local host with no opt-in.
- **Escape hatch:** `DEV_DB_OK=1 npm run dev` acknowledges an intentional remote
  (e.g. staging) and proceeds.
- **Scope:** `predev` only. It is **not** part of `build`, `start`, CI, or
  Vercel, so it can never block a deploy or a pipeline.

## Recommended: a local Postgres for day-to-day dev

The simplest safe setup keeps the guard green because the host is local:

```bash
docker run --rm -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=vibesocials \
  -p 5432:5432 postgres:16
```

Then in `app/.env.local`:

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/vibesocials?schema=public"
```

Apply the schema and start:

```bash
cd app
npx prisma migrate deploy   # applies prisma/migrations/* (never `migrate dev` on shared data)
npm run dev
```

## Creating a Neon branch as staging

When you need production-shaped data instead of an empty local DB, branch it in
Neon rather than pointing at production:

1. Neon dashboard -> the project -> **Branches** -> **New branch**, from the
   production branch, named e.g. `staging`. Neon branches are copy-on-write, so
   this is cheap and fully isolated from production.
2. Copy the branch connection string. Use the **pooled** host (contains
   `-pooler`) for the app; the direct host is for migrations/DDL if you need it
   (production does the same, see
   [Production database connections](#production-database-connections-pooled-and-direct)).
3. Apply migrations to the branch (never `migrate dev` against shared data):

   ```bash
   DATABASE_URL="<staging-branch-url>" npx prisma migrate deploy
   ```

A staging branch is still a **remote** host, so the guard will block a plain
`npm run dev` against it - that is intended. See the escape hatch below.

## Pointing `.env.local` at staging

1. Set `DATABASE_URL` in `app/.env.local` to the staging branch string.
2. Start dev with the opt-in, because the host is remote:

   ```bash
   DEV_DB_OK=1 npm run dev
   ```

The guard prints a one-line acknowledgement and starts. Do **not** put
`DEV_DB_OK=1` in `.env.local` - that would defeat the guard permanently. It is a
per-invocation shell variable.

## Port note (WhaleCopy on :3000)

`next dev` and `next start` default to **port 3000**, which is also where
WhaleCopy runs. If WhaleCopy is up, start Vibe Socials on another port:

```bash
npm run dev -- -p 3001      # or:  PORT=3001 npm run dev
```

If you change the port, update `NEXTAUTH_URL` and every OAuth `*_REDIRECT_URI` /
`X_CALLBACK_URL` in `.env.local` to match, or the auth callbacks will fail. (The
Playwright E2E harness also uses `:3000` for its throwaway server and `:9366`
for the mock blob server - keep those free when running the suite locally.)

## Vercel environment scoping (production vs preview)

In **Project Settings -> Environment Variables**, scope each variable to the
right environment so preview deploys never touch production:

- `DATABASE_URL`: **Production** -> the production Neon branch; **Preview** -> a
  staging/preview Neon branch, never production. This is the deployed-side
  equivalent of the local guard.
- `DIRECT_URL`: **Production** -> the production Neon branch's **direct**
  (non-pooler) host. Optional; used only by migrations. See
  [Production database connections](#production-database-connections-pooled-and-direct)
  below.
- `NEXTAUTH_URL`: differs per environment (production domain vs the generated
  preview URL); register the matching OAuth redirect URIs for each.
- All secrets (`NEXTAUTH_SECRET`, platform tokens, `RESEND_API_KEY`, blob and
  Sentry tokens) live in Vercel, not in the repo. `app/.env.example` is the
  authoritative list of every variable the app reads.

## Production database connections (pooled and direct)

Added after the 2026-11-01 scale audit. Production uses two connection strings
for the same Neon branch:

- **`DATABASE_URL` is the pooled host** (the hostname contains `-pooler`). Every
  serverless function instance shares Neon's PgBouncer instead of opening its
  own Postgres connections. End the URL with exactly this query string. It
  **replaces** the query string the URL already has, it is not appended to it: a
  Neon URL pasted from the dashboard already ends in `?sslmode=require`, so
  adding this block after it would put a second `?` in the URL. Delete the old
  `?sslmode=require` first.

  ```
  ?sslmode=require&connection_limit=5&pool_timeout=20&connect_timeout=15
  ```

  Do **not** add `pgbouncer=true`. The app only takes transaction-scoped
  advisory locks (`pg_advisory_xact_lock` inside transactions) and never uses
  `SET`, `LISTEN`, temp tables, or session advisory locks, so it is safe on the
  transaction-mode pooler as is. (`connection_limit=5` is for Fluid compute,
  where one instance serves many requests; use 3 if Fluid compute is off; never
  below 3, because OAuth refresh holds a lock connection while it reads and
  writes. `app/src/server/platforms/connectionRefresh.ts` reads the value: it
  runs at most `min(2, connection_limit - 1)` refresh locks per instance; at
  `connection_limit=1` it skips the lock and logs a warning.)
- **`DIRECT_URL` is the direct host** (the same hostname **without**
  `-pooler`). Prisma Migrate takes a session-level advisory lock and runs its
  schema engine over one connection, which a transaction-mode pooler can break.
  `app/scripts/migrate-on-vercel-prod.mjs` therefore runs
  `prisma migrate deploy` with `DIRECT_URL` when it is set, and logs
  `[migrate-on-vercel-prod] using DIRECT_URL` plus
  `[migrate-on-vercel-prod] target host: <host>` (the variable name and the
  host only, never the credentials or the query). With `DIRECT_URL` unset it falls back to `DATABASE_URL`, exactly
  as before, so setting it is optional. The running app never reads it.

Set `DIRECT_URL` for the **Production** environment only. Preview builds skip
migrations (see the script's header), so they do not need it.

Keep the **Vercel function region equal to the Neon region** (Project Settings
-> Functions -> Function Region, vs. the region shown on the Neon project).
Every request makes several database round trips; a cross-region hop adds its
latency to each of them.

### Release checklist

- After a deploy that changes blob handling (upload routes, `blobUrl` checks,
  `BLOB_*` settings), upload one file through the composer and one through the
  media library, so both write paths are exercised against the live store.
- If `prisma migrate deploy` ever fails mid-build, the build stops and every
  later build fails with P3009 until the failed migration is resolved. Resolve it
  with the direct connection, then redeploy:

  ```bash
  DATABASE_URL="<DIRECT_URL value>" npx prisma migrate resolve --rolled-back <migration_name>
  ```

  `<migration_name>` is the folder name under `app/prisma/migrations/` of the
  migration that failed (its row in `_prisma_migrations` has no
  `finished_at`). Fix whatever made it fail first; `--rolled-back` only lets the
  next deploy run it again.

#### Releasing pipeline changes (Inngest)

Added after the 2026-11-02 phase 2 final review. Use this whenever a deploy
changes the Inngest functions in `app/src/server/jobs/inngest-functions.ts`
(their configuration, steps or event ids), and always for the scale-phase
releases.

1. **Ship one phase at a time.** Deploy and verify phase 1 (the `20261101*`
   migrations) first. Then deploy phase 2 (the `20261102*` migrations). Do not
   push both in one build.
2. **Before promoting a deploy that changes Inngest functions:**
   - Pause `scheduled-post-scanner` in the Inngest dashboard a couple of minutes
     ahead. If you cannot pause it, confirm that no scanner run is active and
     that no post is due within about 5 minutes.
   - Avoid 04:40-05:20 UTC, the window of the `connection-health-sweep`
     (cron `45 4 * * *`).
   - Resume the scanner at least 5 minutes after the Inngest sync. That gives
     every old-code step time to end within its 300 s limit.

   Why: events sent by the old scanner carry no event id, so a scanner run that
   straddles the deploy can re-send them, and an old run that is still in flight
   can publish alongside a new one.
3. **After every deploy, check that the Inngest sync took effect.** In the
   Inngest dashboard (or from the response of
   `PUT https://<domain>/api/inngest`), confirm the functions show the new
   configuration:
   - `publish-to-all-platforms`: concurrency, priority and idempotency
     (`event.data.postJobId`), with `retries: 3`;
   - `send-notification`: the throttle (8 per second);
   - the singleton crons (`scheduled-post-scanner`, `media-retention-sweep`,
     `youtube-post-metrics-sync`, `stale-post-job-sweep`,
     `connection-health-sweep`);
   - a registered `refresh-connection`.

   If anything is missing, force a resync.
4. **Rollback.**
   - Prefer rolling forward.
   - If you roll back, immediately force an Inngest resync (dashboard "Resync",
     or `PUT https://<domain>/api/inngest`). Then confirm
     `publish-to-all-platforms` shows `retries: 0` again. Older code has no
     claim guard, so phase 2's `retries: 3` must not stay registered against it.
   - Expected side effects of a rollback: deferred posts that wake on old code
     send a "Pending" email, and the 2 h reconciler later marks them stalled.

## Sandbox platform apps

For OAuth posting flows in staging, do not reuse production social-app
credentials. Use each provider's sandbox/test app where available and point its
redirect URI at your staging URL:

- **TikTok** sandbox mode with private test users - see `docs/TIKTOK_SETUP.md`.
- **Meta** (Facebook/Instagram) app kept in development mode with test users.
- **LinkedIn** a separate development app - see `docs/LINKEDIN_SETUP.md`.

This keeps test posts off real audiences and off production API quotas.

## E2E environment variables (recap)

The Playwright suite runs against its **own** throwaway Postgres and in-process
doubles; it never touches staging or production. The full explanation of what
runs, what is skipped, and why lives in **[`app/e2e/README.md`](../app/e2e/README.md)**.

Quick recap of the knobs (all E2E-only; see the "E2E only" block in
`app/.env.example`):

- `E2E_DATABASE_URL` - a disposable, migrated test Postgres; `playwright.config.ts`
  threads it through as the booted server's `DATABASE_URL`.
- `E2E_UPLOAD_STUBS_READY` - lights the schedule-post upload flow.
- `E2E_STUBS_READY` - would light the compose / invite publish flows; deliberately
  left unset (see the README for why a green there would be misleading).
- `NEXT_PUBLIC_VERCEL_BLOB_API_URL` / `VERCEL_BLOB_API_URL` / `BLOB_READ_WRITE_TOKEN`
  - point `@vercel/blob` at the mock blob server (`e2e/support/mock-blob-server.mjs`).

CI provisions a throwaway `postgres:16` service container for these - it is
never pointed at a real database.
