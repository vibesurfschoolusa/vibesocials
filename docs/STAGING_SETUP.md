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
   migrations) first. Then deploy phase 2 (the `20261102*` migrations). Deploy
   phase 3 (the `20261103*` migrations) only after phase 2 is deployed and
   verified, and on its own. Do not push two phases in one build.

   **Before you push phase 3, check the size of the results table.** Run this
   against production (read-only):

   ```sql
   SELECT count(*) FROM "PostJobResult";
   ```

   Phase 3's migrations run during the build. They add two columns
   (`workspaceId` and `uploadState`) and build an
   index on `"PostJobResult"` with a plain `CREATE INDEX` (which blocks writes to
   the table while it builds). Then they backfill `"workspaceId"` on every row
   in one `UPDATE` (which locks every row it changes until it ends). Both are
   quick on a small table. If the count is large (say over 1M rows), they can
   hold their locks long enough to stall publishing, so plan a quiet window for
   the push. Each migration gives up after 5 s if it has to wait for a lock
   held by another transaction (`lock_timeout`), and the build then fails. The
   backfill is idempotent. Recover a failed backfill the way the "Release
   checklist" above describes:

   ```bash
   DATABASE_URL="<DIRECT_URL value>" npx prisma migrate resolve --rolled-back 20261103100100_backfill_post_job_result_workspace_id
   ```

   Then redeploy. Do not edit the committed migration files to get past a
   failure: their checksums must not change.
2. **Before promoting a deploy that changes Inngest functions:**
   - Pause `scheduled-post-scanner` in the Inngest dashboard a couple of minutes
     ahead. If you cannot pause it, confirm that no scanner run is active and
     that no post is due within about 5 minutes.
   - After pausing, open the runs list of `scheduled-post-scanner` and confirm
     that **no run is Running or Paused** before you promote. Inngest's pause
     can hold or cancel a run that is already active, so a run that is still
     Running or Paused can straddle the deploy. If one is, wait for it to end.
   - Avoid 04:40-05:20 UTC, the window of the `connection-health-sweep`
     (cron `45 4 * * *`).
   - Resume the scanner at least 5 minutes after the Inngest sync. That gives
     every old-code step time to end within its 300 s limit.

   Why: events sent by the old scanner carry no event id, so a scanner run that
   straddles the deploy can re-send them, and an old run that is still in flight
   can publish alongside a new one.
3. **After every deploy, check that the Inngest sync took effect.** The
   function configuration can be verified **only in the Inngest dashboard**:
   `PUT https://<domain>/api/inngest` returns just `{ message, modified }`, not
   the configuration. In the dashboard, confirm the functions show the new
   configuration:
   - `publish-to-all-platforms`: concurrency, priority and idempotency
     (`event.data.postJobId`), with `retries: 3`;
   - `send-notification`: the throttle (8 per second);
   - the singleton crons (`scheduled-post-scanner`, `media-retention-sweep`,
     `youtube-post-metrics-sync`, `stale-post-job-sweep`,
     `connection-health-sweep`);
   - a registered `refresh-connection`.

   If anything is missing, force a resync (dashboard "Resync", or
   `PUT https://<domain>/api/inngest`), then check the dashboard again.
4. **Rollback.**
   - Prefer rolling forward.
   - If you roll back, pause `scheduled-post-scanner` before you roll back, and
     resume it at least 5 minutes after the resync, the same as step 2 (including
     the check that no run is Running or Paused).
   - Immediately after the rollback, force an Inngest resync (dashboard
     "Resync", or `PUT https://<domain>/api/inngest`). Then confirm in the
     dashboard that `publish-to-all-platforms` shows the `retries` value that
     the rolled-back code registers:
     - **Phase 3 back to phase 2:** `retries: 3`. Phase 2 code has the claim
       guard and registers `retries: 3` itself.
     - **Back to before phase 2:** `retries: 0`. Older code has no claim guard,
       so phase 2's `retries: 3` must not stay registered against it.
   - Expected side effects of a rollback:
     - Deferred posts that wake on old code send a "Pending" email, and the 2 h
       reconciler later marks them stalled.
     - **Instagram (phase 3 back to phase 2).** From the phase 3 merge, every
       Instagram Reels video polls its container across steps, once a minute.
       This applies to every account and is **not** behind
       `LARGE_UPLOAD_PLATFORMS`. A rollback while a Reels post is between two
       polls hands that result to old code. The user gets the "Pending" email,
       the 2 h reconciler fails the result `PUBLISH_STALLED` about 2 h later, and
       the container Instagram already created is left orphaned (never
       published). Nothing was posted, because the publish call only comes after
       the poll. The user can retry.
     - Large videos that are part-way through an upload: see "Enabling
       large-video uploads (phase 3)" below.

#### Enabling large-video uploads (phase 3)

Phase 3 can upload a video above 50 MiB in bounded chunks across several steps,
for YouTube, TikTok, X and LinkedIn, instead of loading the whole file into one
step's memory. `LARGE_UPLOAD_PLATFORMS` (a comma list of `youtube`, `x`,
`tiktok`, `linkedin`; see `app/.env.example`) decides which platforms use it.
**It is empty by default, so the new path is off everywhere and every platform
keeps today's buffered upload.** An empty or invalid value means none, `none`
means none, and unknown names are ignored.

It is off by default because the streamed paths rely on vendor behaviour we
could not confirm from the vendors' documentation: whether Vercel Blob answers
a `Range` request, how long a YouTube upload session lives, X's v1.1 APPEND
limits, whether LinkedIn accepts a multipart upload for 50 to 200 MB, and how
TikTok reports an out-of-sync chunk. A ~100 MB test video on each platform's
sandbox account is the confirmation, so enable the platforms one at a time,
after the promotion:

1. Set `LARGE_UPLOAD_PLATFORMS=<platform>` (for example `youtube`) in the Vercel
   production environment and redeploy. The value is read at the next deploy.
2. **YouTube only:** before the test, note today's value of the daily upload
   counter (read-only):

   ```sql
   SELECT "count" FROM "RateLimitEntry"
   WHERE "key" = 'quota:youtube:videos.insert:<today in Pacific time, YYYY-MM-DD>';
   ```

   No row means 0.
3. Publish one ~100 MB video to that platform from its sandbox/test account (see
   "Sandbox platform apps" below).
4. Check that the run really crossed a step: the run of `publish-to-all-platforms`
   in the Inngest dashboard must show at least one `publish-to-<platform>-c1` step
   (for example `publish-to-youtube-c1`). If the ~100 MB run finished in a single
   step, the cross-step path was not tested: repeat with a bigger file, up to
   512 MB, until a `-c1` step appears.
5. Check that the post went out, with the full video playable on the platform.
   - **YouTube:** run the query from step 2 again. The counter must have risen by
     exactly 1 for the one video (one upload session). The counter is app-wide,
     so run the test in a quiet window, or subtract any other YouTube results
     that started during the test. More than 1 left over means a session was
     started twice; stop and investigate before you enable another platform.
   - **TikTok:** record whether the status poll confirmed the post, or the result
     ended `TIKTOK_PUBLISH_PENDING` ("check TikTok before retrying"). For a
     pending result, check the sandbox account for the video before you do
     anything else, and do not retry it blindly.
6. Add the next platform to the list (`youtube,tiktok`, and so on) and repeat
   from step 1.

On a failure, remove that platform from the list (or set `none`) and redeploy.
The platform goes back to the buffered upload. A result that already has saved
upload state for its run stays on the new path, so switching a platform off never
strands an upload that has started. A rollback in the middle of an upload leaves
those results `pending`; the 2 h reconciler fails them as stalled. The same holds
for an Instagram Reels post that is between two polls (see the rollback side
effects above), whatever `LARGE_UPLOAD_PLATFORMS` says.

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
