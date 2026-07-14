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
   `-pooler`) for the app; the direct host is for migrations/DDL if you need it.
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
- `NEXTAUTH_URL`: differs per environment (production domain vs the generated
  preview URL); register the matching OAuth redirect URIs for each.
- All secrets (`NEXTAUTH_SECRET`, platform tokens, `RESEND_API_KEY`, blob and
  Sentry tokens) live in Vercel, not in the repo. `app/.env.example` is the
  authoritative list of every variable the app reads.

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
