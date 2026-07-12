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

## What runs, what's skipped, and why (the capability gates)

`core-flows.spec.ts` is gated by env flags so CI runs exactly the flows whose
doubles are **real** and skips the rest — never a false pass:

```ts
const dbReady = !!process.env.E2E_DATABASE_URL;              // gates the whole file
const uploadStubsReady = !!process.env.E2E_UPLOAD_STUBS_READY; // gates the schedule flow
const publishStubsReady = !!process.env.E2E_STUBS_READY;      // gates compose / invite→post
```

| Flow | Needs | Gate | In CI |
| --- | --- | --- | --- |
| register via the UI, then log in | Postgres only | `E2E_DATABASE_URL` | **runs** |
| edit settings and see it persist | Postgres only | `E2E_DATABASE_URL` | **runs** |
| schedule a post → Queue | Postgres + blob upload double + seeded connection | `+ E2E_UPLOAD_STUBS_READY` | **runs** (Task F) |
| compose a post → Activity | Postgres + a real publish path | `+ E2E_STUBS_READY` | **skipped** |
| owner invites → member posts | Postgres + a real publish path | `+ E2E_STUBS_READY` | **skipped** |

The CI job (below) sets `E2E_DATABASE_URL` + `E2E_UPLOAD_STUBS_READY` (plus the
blob env from part 4), so **four** flows run for real and the two publish flows
report skipped. The test bodies are written for real against the current source
(concrete selectors/copy, cross-checked against
`src/app/{login,register,posts/new,queue,activity,settings,join/[token]}/*`
and `src/components/team-section.tsx`), not TODOs.

### Why the schedule flow *can* run but compose / invite *can't* (Task F finding)

The three "posting" flows look alike, but `POST /api/posts` treats them very
differently (see `src/app/api/posts/route.ts` + `src/server/jobs/posting.ts`):

- **Scheduled** intent creates the `PostJob` (status `scheduled`, caption
  snapshotted) with **no** per-platform results, does **not** require a
  connection to fan out to, and **sends no Inngest event**. So the schedule flow
  runs end to end against just Postgres + a working media upload — no platform
  API is ever contacted. Its only real dependency beyond the DB is the blob
  upload (part 4) and a `SocialConnection` row so the composer will submit
  (part 3). Both are now provided; the flow is lit.

- **Immediate** intent (compose, and the member-posts step of the invite flow)
  calls `inngest.send({ name: "post/publish.requested", … })`. The actual
  publish is the async Inngest function `publishToAllPlatforms`
  (`src/server/jobs/inngest-functions.ts`) — the *only* place the platform
  clients (`src/server/platforms/*Client.ts`) are called. This harness runs
  `next start` + Postgres but **no Inngest worker**, so:
  1. `inngest.send()` itself throws. `next start` sets `NODE_ENV=production`, so
     the Inngest SDK infers **cloud** mode, and with no `INNGEST_EVENT_KEY` the
     v3 client fails fast:
     `node_modules/inngest/components/Inngest.js` (`_send`):
     `if (this.mode.isCloud && !this.eventKeySet()) throw … "Failed to send event"`.
     `POST /api/posts` catches it and returns 500, so the composer never shows
     "Post queued" — the flow can't even reach Activity.
  2. Even if the event send were faked to a mock intake (return `{status:200}`),
     no worker ever invokes `publishToAllPlatforms`, so the `PostJobResult`s stay
     `pending` forever and the platform clients are never run. A green would
     prove only "a job row was created and shows in Activity", **not** "composed
     and published to a connected platform" — which is what the flow, and the
     confirm dialog's "This publishes immediately", claim. That's a misleading
     pass, so these stay **skipped** (honest "not exercised").

**Consequence for the platform seam.** Because *no* lightable flow calls a
platform client, there is nothing for a TikTok/base-URL seam or a mock platform
API to faithfully cover here (the brief's rule: "seam ONLY the client(s) your
doubles actually cover"). None was added — a seam with no consumer would be
inert, unexercised code. Lighting compose/invite honestly requires running the
publish worker in E2E (e.g. an Inngest dev server that introspects
`/api/inngest` and invokes the function), which would *then* hit the platform
clients and justify seaming one + a mock platform server. That's a larger,
separate change (a real worker process, not a "plain node http" double) and is
called out as the follow-up, not faked in.

**How the server reaches the test DB.** `playwright.config.ts`'s `webServer`
block fully replaces the child process's environment, so it threads
`E2E_DATABASE_URL` through as the booted server's `DATABASE_URL` (falling back
to the unreachable dummy when unset, so the smoke-only path is unchanged).
Without that, a core-flow run would boot against the dummy DB and every
authenticated request would fail — setting `E2E_DATABASE_URL` alone is not
enough; the config has to forward it.

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

**Connection seed — IMPLEMENTED (Task F), for the schedule flow.** Even a
*scheduled* post can't be submitted from an unconnected composer (the submit
button is disabled and `selectedPlatforms.length === 0` blocks it), so the
schedule flow needs a `SocialConnection` too — but a scheduled job creates no
results and never calls a platform client, so the connection is inert. Because
every test provisions its own random-email user via `registerViaApi`, the
connection is seeded **per test, in-process**, keyed by that fresh user:
`e2e/support/seed-connection.ts`'s `seedWorkspaceConnection(email)` finds the
user's personal workspace (oldest owned membership) and upserts one row. It
constructs its **own** `PrismaClient` pointed explicitly at `E2E_DATABASE_URL`
(never imports `src/lib/db.ts`) and **throws if `E2E_DATABASE_URL` is unset**, so
it can only ever touch a throwaway test DB.

**4. Media upload needs a blob store. — IMPLEMENTED (Task F).**

`src/app/api/upload/route.ts` uses `@vercel/blob/client`. The upload is doubled
**env-only, with no change to product code**, because `@vercel/blob@2` reads its
API base URL from an env var at call time:

```js
// node_modules/@vercel/blob/dist/chunk-UVSKRCEW.js
function getApiUrl(pathname = "") {
  let baseUrl = process.env.VERCEL_BLOB_API_URL
             || process.env.NEXT_PUBLIC_VERCEL_BLOB_API_URL;
  return `${baseUrl || defaultVercelBlobApiUrl}${pathname}`;
}
```

The real `upload()` runs unchanged. It is a two-hop flow:

1. The browser POSTs `/api/upload` (the app's real route). `handleUpload()` calls
   `onBeforeGenerateToken` and signs a **client token locally** from
   `BLOB_READ_WRITE_TOKEN` — no network (verified in
   `node_modules/@vercel/blob/dist/client.js`). So a throwaway,
   correctly-shaped token (`vercel_blob_rw_<storeId>_<secret>`) is all the
   server needs.
2. The browser then PUTs the file bytes to
   `${NEXT_PUBLIC_VERCEL_BLOB_API_URL}/?pathname=<key>` and reads back
   `{ url, downloadUrl, pathname, contentType, contentDisposition, etag }`
   (`createPutMethod` → `requestApi`, `chunk-*.js`).

**Two subtleties that matter:**

- `upload()` runs in the **browser**, so only the build-time-inlined
  `NEXT_PUBLIC_` form of the override reaches the PUT. It must be set for
  `npm run build`, which `playwright.config.ts`'s `webServer` runs as part of
  its command — that config threads it (and the non-public var, for any
  server-side call) through when present, so the smoke-only build is unchanged.
- Using `http://localhost:<port>` (not `127.0.0.1`) as the base makes the SDK's
  `supportsRequestStreams` return `false`, so the PUT body is sent whole rather
  than as a duplex request stream — which is what keeps a cross-origin PUT
  working over plain HTTP/1.1 in Chromium.

The double is a tiny dependency-free Node server, `e2e/support/mock-blob-server.mjs`:
it implements the PUT (store bytes, return the exact `PutBlobResult` JSON), a GET
that re-serves the bytes (so the Queue thumbnail resolves), and permissive CORS
including an OPTIONS preflight that echoes the SDK's `authorization`/`x-api-*`
request headers (the PUT is cross-origin: app on `:3000`, mock on `:9366`). It's
started for the run (CI step below; locally `node e2e/support/mock-blob-server.mjs`).

### Wiring it into CI

**Done** — `.github/workflows/ci.yml` has an `e2e` job (separate from the
fast unit lane) that:

1. Stands up a throwaway `postgres:16` **service container** (never prod),
   health-checked before the steps run.
2. Sets `DATABASE_URL` + `E2E_DATABASE_URL` to that service and a fixed
   throwaway `NEXTAUTH_SECRET`, then runs `npx prisma migrate deploy` against
   it and `npx playwright install --with-deps chromium`.
3. Sets the Task F blob env (`NEXT_PUBLIC_VERCEL_BLOB_API_URL` +
   `VERCEL_BLOB_API_URL` → the mock, a throwaway `BLOB_READ_WRITE_TOKEN`) and
   `E2E_UPLOAD_STUBS_READY: "1"`, starts `e2e/support/mock-blob-server.mjs` in
   the background, then runs `npx playwright test` (tearing the mock down
   after). So the run exercises the public smoke suite + the register,
   settings, **and schedule** flows for real.
4. Does **not** set `E2E_STUBS_READY`, so the compose / invite→post flows report
   skipped — a green that means what it says (see "Why the schedule flow can run
   but compose / invite can't" above).

To extend coverage to the compose / invite→post flows later, you need a running
**publish worker**, not just a mock — see that section. Once the async
`publishToAllPlatforms` actually runs in E2E (e.g. via an Inngest dev server
that introspects `/api/inngest`), add a base-URL env seam to whichever platform
client it will hit (e.g. `const TIKTOK_API_BASE = process.env.TIKTOK_API_BASE ??
"https://open.tiktokapis.com"` — default identical) and a mock platform server
for it, then set `E2E_STUBS_READY: "1"`. The two skipped tests light up with no
change to their bodies.

**Local run.** A `postgres:16` container is the easiest DB source:
`docker run --rm -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=vibesocials_e2e -p 5432:5432 postgres:16`.
Point Prisma at it (`export E2E_DATABASE_URL=… DATABASE_URL="$E2E_DATABASE_URL"`),
`npx prisma migrate deploy`, then — for the DB-only flows — `npx playwright test`.
To also run the schedule flow, start the blob double in one shell
(`node e2e/support/mock-blob-server.mjs`) and in another run:
`NEXT_PUBLIC_VERCEL_BLOB_API_URL=http://localhost:9366 VERCEL_BLOB_API_URL=http://localhost:9366 BLOB_READ_WRITE_TOKEN=vercel_blob_rw_e2eteststore_localdev E2E_UPLOAD_STUBS_READY=1 npx playwright test`.

## Keeping this separate from Vitest

`vitest.config.ts` only globs `src/**/*.test.ts`; this directory is
`app/e2e/**/*.spec.ts` — different root, different suffix, so Vitest never
sees these files and Playwright never sees Vitest's. Nothing further to
configure, but if either convention ever changes, add an explicit
`exclude: ["e2e/**"]` to `vitest.config.ts` to keep the guarantee explicit
rather than incidental.
