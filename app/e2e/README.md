# E2E tests (Playwright)

Health track H3. Two spec files, two very different guarantees:

| File | What it covers | Runs here (no DB, no OAuth)? |
| --- | --- | --- |
| `public-routes.smoke.spec.ts` | `/login`, `/register`, `/privacy`, `/terms` — HTTP 200, expected heading, no console/page errors, basic a11y sanity | **Yes** — verified green |
| `core-flows.spec.ts` | register→login, compose→publish, schedule→queue, edit settings | **No** — skipped by design, see below |

Chromium only, headless. Config: `playwright.config.ts` at the `app/` root.

## Running the smoke tests

```bash
cd app
npm install
npx playwright install chromium   # one-time, downloads the browser binary
npx playwright test               # or: npm run test:e2e
```

`playwright.config.ts` has a `webServer` block, so this builds and boots the
app for you (`npm run build && npm run start`) against a dummy
`DATABASE_URL`, waits for `http://127.0.0.1:3000` to respond, runs the
specs, then tears the server down. You don't need a database running, a
`.env` file, or anything else — that's the entire point of the smoke suite.

Locally the server is reused across runs (`reuseExistingServer: true` when
`CI` isn't set) — if you already have `npm run dev` or `npm run start`
running on port 3000, Playwright will hit that instead of starting its own.

### Why this works without a database

- `/login`, `/register`, `/privacy`, and `/terms` are statically prerendered
  (`○ (Static)` in `next build`'s route summary) — their HTML is generated
  once at build time, not per-request, so there's nothing for them to query.
- They're also exactly the app's `PUBLIC_ROUTE_PREFIXES`
  (`src/components/shell/nav.ts`), which `AppShell` renders with no session
  redirect and no chrome — no `getServerSession`/Prisma call sits in front of
  them.
- `src/lib/auth.ts` uses the next-auth `jwt` session strategy, so even the
  client-side `useSession()` call every page makes (`GET /api/auth/session`)
  never touches Prisma — it just decodes (or, with no cookie, fails to find)
  a JWT.
- `src/lib/db.ts` constructs `new PrismaClient()` at import time, so the
  process needs *some* `DATABASE_URL` string to boot even though nothing in
  this suite issues a real query — Prisma only resolves the connection
  lazily, on the first actual query. `playwright.config.ts`'s `webServer.env`
  sets a syntactically-valid, unreachable one
  (`postgresql://user:pass@localhost:5432/db`) for exactly this reason.

If a public route's behavior ever changes to require auth (a redirect, a
non-200 status, a hydration error because a data hook assumes a session),
the smoke spec should start failing loudly — that's a real regression, not a
harness problem, and the fix is to adapt the app or the assertion to match
the new *intended* behavior, not to loosen the check.

## Why `core-flows.spec.ts` is skipped here

It's gated behind an env flag and never runs in this sandbox:

```ts
const dbReady = !!process.env.E2E_DATABASE_URL;
test.describe(dbReady ? "core flows" : "core flows (skipped — needs E2E_DATABASE_URL)", () => {
  test.skip(!dbReady, "Set E2E_DATABASE_URL to a seeded test DB to run these");
  ...
});
```

`E2E_DATABASE_URL` is unset here, so the whole file reports as **skipped**,
never **passed** — a skip is honest about "not exercised"; a pass would be a
lie. The test bodies are written for real against the current source
(concrete selectors, concrete copy, cross-checked against
`src/app/{login,register,posts/new,queue,activity,settings}/*` as of this
commit) so they're ready to run as-is once the infra below exists, not TODOs.

### What it takes to actually run these

**1. A seeded, migrated test Postgres.**

```bash
# Point Prisma at a real (disposable, test-only) database:
export E2E_DATABASE_URL="postgresql://user:pass@host:5432/vibesocials_e2e"
export DATABASE_URL="$E2E_DATABASE_URL"   # Prisma CLI reads DATABASE_URL, not E2E_DATABASE_URL
npx prisma migrate deploy                 # applies prisma/migrations/* — no dev-mode drift
```

No standalone seed *script* is required beyond that: every test in
`core-flows.spec.ts` provisions its own user by calling
`POST /api/auth/register` directly (see `registerViaApi()` in the spec) with
a fresh, collision-free email — the same endpoint the real register form
uses. That keeps each test isolated and safe to run in parallel
(`fullyParallel: true`) without a shared fixture user or a run-order
dependency. If you'd rather pre-seed fixed accounts (e.g. for a scenario
that needs an *existing* connection or post history baked in), add a
`prisma/seed-e2e.ts` that upserts them with `prisma.user.create({ data: {
email, passwordHash: bcrypt.hashSync(...), ... } })` — mirror
`src/app/api/auth/register/route.ts`'s hashing (bcrypt, cost 10) so
`authorize()` in `src/lib/auth.ts` accepts the password, and run it with
`npx tsx prisma/seed-e2e.ts` (or `prisma db seed`) after `migrate deploy`.

**2. Session strategy — why there's no cookie-injection step.**

The app uses next-auth **v4** with `session: { strategy: "jwt" }`
(`src/lib/auth.ts`). There is no `Session` database table to seed and no
server-side session store — the session *is* the signed JWT in the
`next-auth.session-token` cookie (unprefixed over plain HTTP, which is what
`next start` on `127.0.0.1` serves in this setup;
`__Secure-next-auth.session-token` only applies once served over HTTPS).
That means:

- The straightforward, guaranteed-correct approach — and what
  `core-flows.spec.ts` does — is to drive the real login form
  (`POST` to next-auth's `callback/credentials` route under the hood) and
  let the browser receive a genuine cookie. No fixture wiring needed beyond
  a DB with a matching user row.
- A cookie-injection shortcut (encode a valid JWT with
  `next-auth/jwt`'s `encode()` using the same `NEXTAUTH_SECRET` the server
  runs with, then `context.addCookies([...])` to skip the UI login) is
  possible as a *speed* optimization if this suite grows large enough that
  the login round-trip matters, but isn't implemented here — get the
  UI-driven version running first, since it's what actually exercises the
  login route.
- Whichever way you sign in, set `NEXTAUTH_SECRET` in the E2E webServer env
  to the same value the running server uses (a fixed, non-empty test secret
  is fine — this is a disposable test DB, not production).

**3. OAuth test doubles for the posting flows.**

`compose a post` and `schedule a post` call `POST /api/posts`, which — once
a job is dispatched (Inngest, `src/server/jobs/posting.ts`) — calls the real
platform SDKs/REST APIs (`src/server/platforms/*Client.ts`) using whatever
OAuth tokens are on the user's `SocialConnection` rows. Two honest options,
neither implemented here:

- **Sandbox/developer test apps.** Several platforms offer this
  (TikTok's sandbox mode with unaudited test users is the most direct fit
  given `docs/TIKTOK_SETUP.md`). Connect a real-but-harmless test account,
  store its tokens on the seeded user via the seed script, and let the
  E2E run hit the real (sandboxed) API.
- **Stub the HTTP layer.** Every client currently hardcodes its API base
  URL as a module-level constant (e.g. `TIKTOK_API_BASE` in
  `src/server/platforms/tiktokClient.ts`) — there's no env seam to redirect
  it at a mock server today. Either add one (read the base URL from an env
  var, default to the real one) so a local mock server can stand in during
  E2E, or preload a Node-level HTTP interceptor (e.g. `msw/node`) before
  `next start` boots the server process. Either is a small, real code
  change — call it out as a follow-up, don't fake it into this harness.

Either way, the connection also has to exist in the DB
(`prisma.socialConnection.create(...)` in the seed script) — an
unconnected test user sees an empty `PlatformPreviewList` and the "connect a
platform" empty states instead of anything to publish to.

**4. Media upload needs a blob store.**

`src/app/api/upload/route.ts` uses `@vercel/blob/client`, which needs a real
`BLOB_READ_WRITE_TOKEN`. For E2E, either point it at a real (test/dev)
Vercel Blob store, or stub the upload route the same way as the OAuth
clients above. Without one, `compose a post` / `schedule a post` fail at the
upload step before they ever reach a platform client.

### Wiring it into CI

Not done in this change (out of scope for H3 — see the task's own framing:
a working smoke harness + a credible scaffold, not a fake green suite). When
the owner is ready:

1. Provision a throwaway Postgres service for the job (e.g. GitHub Actions'
   `services: postgres:` container, or a Neon/Supabase branch database).
2. In `.github/workflows/ci.yml`, add a step after the existing `Test` step
   that sets `E2E_DATABASE_URL` (+ `DATABASE_URL`, `NEXTAUTH_SECRET`, and the
   OAuth-double strategy chosen above from part 3) and runs
   `npx prisma migrate deploy && npx playwright install chromium --with-deps
   && npx playwright test`.
3. Until then, `core-flows.spec.ts` stays a documented, reviewable scaffold
   — every future PR that touches the auth/compose/queue/settings UI can
   still be checked against it by eye (do the selectors/copy in the spec
   still match the real page?), which is most of the value of having it
   checked in even unexecuted.

## Keeping this separate from Vitest

`vitest.config.ts` only globs `src/**/*.test.ts`; this directory is
`app/e2e/**/*.spec.ts` — different root, different suffix, so Vitest never
sees these files and Playwright never sees Vitest's. Nothing further to
configure, but if either convention ever changes, add an explicit
`exclude: ["e2e/**"]` to `vitest.config.ts` to keep the guarantee explicit
rather than incidental.
