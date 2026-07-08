# Vibe Socials: Audit Remediation Plan

Status: REVIEWED AND CORRECTED, ready to execute. Last updated 2026-07-07.

This plan turns the security and code audit of 2026-07-07 into a phased, multi-model
implementation program. It was reviewed and corrected by the implementing agent on
2026-07-07 before execution. Line references re-verified against the working tree at
commit 4370ba7; they may drift as work lands.

Review outcome: baseline confirmed exactly (build and `tsc --noEmit` green; eslint
172 problems / 134 errors / 38 warnings; `npm audit` 48 vulnerabilities, 1 critical,
15 high, 31 moderate, 1 low). SEC-1, SEC-2, SEC-3, SEC-4, SEC-6, and COR-1 reproduce
at the cited lines. Corrections made by this review are marked "REVISED" inline:
COR-1 is worse than originally written, HLT-3's dead-code claim was wrong, Phase 1's
parallel grouping had a file conflict, the prettier gate referenced tooling that does
not exist, the workflow-scope assumption is outdated, and the test harness has to land
in Phase 2 rather than Phase 4. The three open questions are answered in section 7.

## 1. Context

Vibe Socials is a Next.js 16 (App Router) + TypeScript + Prisma/Postgres app. A logged-in
user uploads one video or photo plus a caption and publishes it to six platforms (TikTok,
YouTube, X, LinkedIn, Instagram, Google Business Profile) using that user's own OAuth
connections. Posting runs as an Inngest background job. It is deployed at vibesocials.wtf.

- App root: `app/` (the Next app is a subdirectory, not the repo root).
- Roughly 11k lines across 80 source files.
- Baseline health at audit time: `next build` passes, `tsc --noEmit` passes, `eslint`
  reports 172 problems (134 errors), `npm audit` reports 48 vulnerabilities (1 critical,
  15 high, 31 moderate, 1 low). No CI exists.

### Do not "fix" these correct behaviors

The dedup and refactor phases must preserve, not break, the following:

- Per-platform failure isolation: each platform publishes in its own try/catch and writes
  its own `PostJobResult`, so one platform failing does not corrupt another. Keep this.
- Google token refresh correctly updates only `accessToken` and `expiresAt` and never
  overwrites `refreshToken` (youtubeClient.ts:53-59, googleBusinessProfileClient.ts:59-65,
  googleReviews.ts:77-83). The shared helper introduced in Phase 2 must keep this property.
- TikTok and Google Business Profile OAuth already use HMAC-signed state via
  `app/src/lib/oauthState.ts`. This is the correct pattern the other callbacks must adopt.
- No live secrets are committed. The matches in `docs/*_SETUP.md` are placeholders
  (`your_client_secret_here`). Do not treat them as leaks.

## 2. Findings register

Each finding has a stable ID used by phases and PRs below.

### Tier 1: Security

- SEC-1 (high): Full OAuth tokens serialized to the browser. `app/src/app/settings/page.tsx:17`
  fetches full `SocialConnection` rows and passes them into the `<ConnectionsSection>` client
  component (line 58). App Router serializes every field (accessToken, refreshToken, and page
  tokens in `metadata`) into the browser payload. The component needs only display fields.
- SEC-2 (high): Forgeable OAuth state on four callbacks. LinkedIn, Instagram, YouTube, and
  Facebook Page decode `userId` from unsigned `base64url(JSON)` with no HMAC and no session
  check: `auth/instagram/callback/route.ts:24-34`, `auth/linkedin/callback/route.ts:26-41`,
  `auth/youtube/callback/route.ts:33-44`, `auth/facebook_page/callback/route.ts:24-34`. Their
  start routes emit the unsigned state (`.../start/route.ts`). This is OAuth CSRF and
  cross-account connection injection. Fix by routing all four through `oauthState.ts`.
- SEC-3 (high): Tokens written to retained logs. `auth/tiktok/callback/route.ts:87` logs
  `fullResponse: JSON.stringify(tokenJson)` (access + refresh token). `auth/instagram/callback/route.ts:122`
  and `auth/facebook_page/callback/route.ts:120` log `pagesData` containing page access tokens.
- SEC-4 (high): `app/src/app/api/geocode/route.ts:3` has no `getCurrentUser()` gate; any
  anonymous caller can drive the paid `GOOGLE_MAPS_API_KEY`.
- SEC-5 (high): No rate limiting on AI routes, plus an SSRF-by-proxy.
  `posts/auto-caption/route.ts`, `posts/enhance-caption/route.ts`, and
  `reviews/draft-response/route.ts` call OpenAI with no per-user throttle (unbounded spend).
  `auto-caption` hands a user-supplied `blobUrl` to OpenAI as an `image_url` to fetch; restrict
  it to your own Blob host.
- SEC-6 (medium): `app/src/app/api/tiktok/post-status/route.ts:19-34` accepts an access token
  as a query-string param and forwards it as a Bearer (token lands in logs/history; open proxy).
  REVISED, confirmed unused: a repo-wide search finds no caller (the only references are the
  route file itself and this plan). Delete the route.
- SEC-7 (high): 48 npm vulnerabilities including 1 critical (protobufjs RCE,
  GHSA-xq3m-2v4x-88gg, pulled via Google libs) and 15 high. Run `npm audit fix`, then bump the
  stragglers deliberately.

### Tier 2: Correctness and reliability

- COR-1 (high): TikTok truncates large videos (data loss). `tiktokClient.ts:116` computes
  `totalChunks = Math.floor(size / CHUNK_SIZE)` and the upload loop (208-211) caps every chunk
  including the last at `CHUNK_SIZE`, while init declares `video_size: size` (163). Any video
  not an exact multiple of 10MB uploads short. Separately, a poll that ends without
  `publish_complete` still returns success (294-304), and the poll swallows fetch errors
  (287-289). REVISED, confirmed and worse than written: the `throw` for
  `publishStatus === "failed"` (282-284) sits inside the same `try` whose `catch` (287-289)
  only warns, so even an explicit "failed" status from TikTok is swallowed, the loop keeps
  polling a terminal state, and the function still returns success. Fix: extend the final
  chunk to `size` (TikTok's FILE_UPLOAD contract: the last chunk absorbs trailing bytes, up
  to 128MB); move the failed-status handling out of the swallow-all catch; treat a
  non-complete poll as failure.
- COR-2 (medium): No timeouts on any of the roughly 40 upstream `fetch` calls across the
  platform clients. A hung upstream stalls the serverless invocation, and because platforms run
  in `Promise.all`, one hang blocks the batch. Fix with a shared `fetchWithTimeout` (Phase 2).
- COR-3 (medium): Raw upstream error bodies reach users. About 25 sites do
  `throw new Error(...${errorBody})`; the job runner stores `error.message` into
  `PostJobResult.errorMessage` (posting.ts:148, inngest-functions.ts:116), which the UI renders.
  Log the raw body server-side, return a sanitized, code-tagged message (Phase 2 normalizer).
- COR-4 (medium): `youtubeClient.ts:174` hardcodes `privacyStatus: "public"`; every YouTube
  post is immediately public. Make it a user choice, default unlisted.
- COR-5 (medium): Instagram and LinkedIn never refresh tokens (instagramClient.ts:5-12,
  linkedinClient.ts has no expiry check). When the token expires, posts fail with a raw error.
  Implement refresh.

### Tier 3: Engineering health

- HLT-1 (high leverage): No CI. Add a GitHub Actions workflow running `tsc --noEmit`, `eslint`,
  and `next build`. Note: pushing `.github/workflows` requires the repo owner's account
  (workflow token scope); hand that branch off rather than pushing it from the agent.
- HLT-2 (medium): Heavy duplication. Google `refreshAccessToken` is copy-pasted three times
  (youtubeClient.ts:5-64, googleBusinessProfileClient.ts:11-70, googleReviews.ts:27-88, ~60
  lines each); the store-code resolver twice (gbp:190-284, googleReviews:206-314, ~90 lines,
  explicitly "copied"); the not-ok error block ~25 times; a download-to-Buffer pattern ~6
  times; no-op refresh stubs 3 times; poll loops 4 times. Consolidate into the Phase 2 helpers.
- HLT-3 (medium): Two divergent posting pipelines. `server/jobs/posting.ts` (synchronous,
  deletes blob on success only) and `server/jobs/inngest-functions.ts` (deletes blob always).
  REVISED, the original "createAndRunPostJob looks like dead code" claim is wrong: the
  synchronous pipeline is live API surface. `POST /api/posts` (posts/route.ts) has three
  branches: the JSON `blobUrl` branch goes through `createPostJobOnly` + `inngest.send`
  (the Inngest pipeline); the JSON `mediaItemId` branch calls
  `createAndRunPostJobForExistingMedia` (posts/route.ts:158) and the multipart branch calls
  `createAndRunPostJob` — both synchronous. The only client caller, `create-post-form.tsx:197`,
  always sends `blobUrl` JSON, so the synchronous branches are unreachable from the current UI
  but remain invokable by any authenticated caller (and bypass TikTok metadata handling).
  Decision (open question 2): keep the Inngest pipeline; delete the synchronous execution
  functions and the `mediaItemId`/multipart branches of posts/route.ts, keeping
  `createPostJobOnly`. Flag in the PR that this narrows the public API of POST /api/posts in
  case any non-repo client depends on it.
- HLT-4 (low): User photos committed at `app/storage/uploads/...` (two WhatsApp images). PII in
  git and dead weight now that storage is Vercel Blob. Remove and gitignore.
- HLT-5 (medium): No tests. Add unit tests for at least the caption-footer builder, the TikTok
  chunk math (COR-1), and `oauthState` round-tripping.
- HLT-6 (low): Dead code. Engagement feature disabled (handlers return 410) but ~500 lines of
  helpers remain (some placing tokens in query strings); `connections/page.tsx` only redirects
  yet imports Prisma; no-op refresh stubs; debug `console.log`s scattered in routes and clients.

### Tier 4: Product and UX polish

- UX-1: `reviews/page.tsx` (568 lines) uses `alert()`/`confirm()` for all feedback and a raw
  `<img>`; a single fetch error flips the whole page to an error view with no retry.
- UX-2: Large files to break up: `reviews/page.tsx` (568), `auth/linkedin/callback/route.ts`
  (455), `create-post-form.tsx` (441), `tiktok-post-settings.tsx` (290).
- UX-3: `settings/route.ts:13-22` writes `companyWebsite`/`defaultHashtags` with no type
  validation.
- UX-4: Caption truncation slices by UTF-16 code unit and can split emoji (tiktokClient.ts:107,
  xClient.ts:417, youtubeClient.ts:165).
- UX-5: Dependencies a major version behind (Prisma 6 to 7, Inngest 3 to 4, lucide-react 0 to
  1, eslint 9 to 10, TypeScript 5 to 6). Upgrade deliberately with the CI gate in place.
- UX-6: `create-post-form.tsx` can upload the file to Blob twice (attach at 304, submit at 159);
  logs blob URLs to console.

## 3. Delegation model

Work is assigned by risk and difficulty, not evenly.

| Work | Model |
|------|-------|
| Orchestration, sequencing, integration, final verification gate | Fable (orchestrator) |
| Security-critical and subtle correctness: SEC-1, SEC-2 (with SEC-3 folded in, see below), SEC-5, COR-1, and the design of the Phase 2 shared helpers | Opus |
| Adversarial review of each phase diff before it becomes a PR (a fresh agent, never the author) | Opus |
| Mechanical, well-scoped fixes: SEC-4, SEC-6, HLT-4, HLT-6, UX-3, and `npm audit fix` | Sonnet |
| Bulk pattern application once Opus sets the pattern: apply `fetchWithTimeout` across ~40 call sites (COR-2), the HLT-2 dedup, unit tests (HLT-5) | Sonnet |

REVISED, one reassignment: SEC-3 (token logging) was Sonnet-tier mechanical work, but two of
its three files (`auth/instagram/callback/route.ts`, `auth/facebook_page/callback/route.ts`)
are the same files SEC-2 rewrites, so running them as separate agents is a guaranteed merge
conflict. SEC-3 moves into the SEC-2 agent, which owns the whole OAuth callback surface
(including the TikTok callback's `fullResponse` log, so the finding stays in one pair of
hands). The tier upgrade costs nothing; the file-conflict avoidance is the point.

## 4. Isolation and parallelism

Constraint: never run two repo-mutating agents in the shared working tree at once (they race
on git HEAD and the index).

- Within a phase, findings that touch different files run as parallel worktree-isolated agents
  (`isolation: 'worktree'`). Findings that touch the same files (for example the four OAuth
  callbacks in SEC-2, or anything touching a platform client that COR-2 also rewrites) run
  sequentially.
- Across phases, work is strictly sequential: later phases depend on earlier ones (Phase 3 and
  Phase 4 both build on the Phase 2 helpers).
- The orchestrator integrates worktree branches and resolves conflicts.

## 5. Phase sequence

Each phase ends in one pull request. Do not merge; hand the PR to the repo owner for explicit
approval (agent-authored merges require the owner's go-ahead). Start the next phase only after
the prior PR is approved and merged, since line references and shared helpers shift. (Phase 0
is the one exception: its CI workflow does not change app code, so Phase 1 may start on the
owner's approval without waiting for the merge itself.)

### Phase 0: Guardrails

- HLT-1: add `.github/workflows/ci.yml` running install, `prisma generate`, `tsc --noEmit`,
  `eslint`, `next build`, and `npm run test --if-present` (the test script arrives in
  Phase 2; `--if-present` keeps the workflow valid from day one) on push and PR.
- REVISED, workflow scope: the active `gh` token reports the `workflow` scope, so the original
  assumption that the push must fail is outdated. Attempt the push directly; only if it is
  rejected (git's HTTPS credential may differ from gh's keyring token), fall back to the
  original handoff: prepare the branch locally and give the owner the exact push command.
- Everything after this phase should be gated by the workflow once the owner merges it. Later
  phases do not block on that merge: the same commands run locally as each phase's gate, and
  CI picks up retroactively once the workflow file is on `main`.

### Phase 1: Tier 1 security

REVISED grouping (the original put SEC-3 in the parallel set, but SEC-3 shares two files with
SEC-2). Four parallel tracks, disjoint files, each in its own worktree:

- Track A (Opus): SEC-2 + SEC-3 — HMAC state via `oauthState.ts` across the four callbacks and
  their start routes, plus removal of token/page-token logging in the TikTok, Instagram, and
  Facebook Page callbacks. One agent owns the whole OAuth callback surface.
- Track B (Opus): SEC-1 — replace the full `SocialConnection` rows passed to
  `ConnectionsSection` with a display-only DTO (id, platform, accountIdentifier, and the
  non-secret metadata display fields the component actually reads).
- Track C (Opus): SEC-5 — DB-backed per-user rate limiter (decision in section 7, question 3)
  applied to the three AI routes, plus the Blob-host allowlist for `auto-caption`'s `blobUrl`.
  Touches `prisma/schema.prisma` + a new migration; nothing else in this phase does.
- Track D (Sonnet): SEC-4 (auth-gate the geocode route) and SEC-6 (delete the unused
  post-status route).
- Track E (Sonnet): SEC-7 — `npm audit fix` without `--force`, then report what remains rather
  than forcing majors. Isolated because it churns `package-lock.json`.

### Phase 2: Shared foundation

Opus designs and lands small, well-tested helpers that later phases depend on:

- `fetchWithTimeout(url, init, ms)` using AbortController.
- `assertOk(res, { code, prefix })`: logs the raw body server-side, throws a sanitized,
  code-tagged error (fixes the COR-3 class in one place).
- `refreshGoogleToken(connection)`: single implementation that preserves `refreshToken`.
- `resolveGbpLocationName(...)`: one copy of the store-code resolver.
- Optional: `downloadToBuffer(url)`, `pollUntil(fn, opts)`.

REVISED, two additions:

- The vitest harness must land here, not in Phase 4: this phase's helpers are specified as
  "well-tested" and Phase 3's COR-1 requires a unit test, so the test runner is a Phase 2
  dependency. Add vitest + a `test` script (which the Phase 0 CI already invokes via
  `--if-present`). HLT-5 in Phase 4 then only expands coverage.
- Each helper migrates one pilot consumer in this phase (e.g. `youtubeClient.ts`'s refresh
  onto `refreshGoogleToken`, one fetch site onto `fetchWithTimeout`/`assertOk`) so the design
  is proven against real call sites; bulk application stays in Phases 3 and 4.

### Phase 3: Tier 2 correctness

- COR-1 (Opus, subtle): fix the chunk math and the false-success poll; add a unit test.
- COR-2 (Sonnet): apply `fetchWithTimeout` across the ~40 platform-client fetches.
- COR-3 (Sonnet): route error handling through `assertOk`.
- COR-4 (Sonnet): make YouTube privacy a user choice.
- COR-5 (Sonnet, Opus review): implement Instagram and LinkedIn token refresh.

### Phase 4: Tier 3 engineering health

- HLT-2 (Sonnet): dedup the three Google refreshes and the store-code resolver into the Phase 2
  helpers; collapse the repeated error and download patterns.
- HLT-3 (Opus decides which pipeline to keep): collapse the two posting paths.
- HLT-4, HLT-6 (Sonnet): remove committed media and gitignore; delete dead code and debug logs.
- HLT-5 (Sonnet): expand the unit tests (caption-footer builder, `oauthState` round-trip; the
  harness and the first tests landed in Phases 2-3); drive `eslint` to green.

### Phase 5: Tier 4 UX polish

- UX-1 through UX-4 and UX-6, lowest stakes. Toast-based feedback, component refactors,
  grapheme-safe truncation, input validation.
- REVISED, UX-5 descoped from this program: the major-version bumps (Prisma 6→7, Inngest 3→4,
  eslint 9→10, TypeScript 5→6) are prod-deploy risks that local build cannot fully vet, and
  they belong in a dedicated upgrade PR after this program, at the owner's discretion. What
  `npm audit fix` resolves within semver in Phase 1 (SEC-7) still happens.

## 6. Verification gate (every phase)

- `tsc --noEmit` run separately (vitest does not typecheck, so a green test run is not enough).
- `eslint` (do not increase the error count; Phase 4 drives it to zero).
- `next build`.
- `npm run test` once the harness exists (Phase 2 onward).
- REVISED, prettier dropped: the repo has no prettier dependency, no prettier config, and no
  `format` script, and the Phase 0 CI deliberately contains no formatting check. Running
  `npx prettier --write` would reformat the whole codebase into every diff. New code follows
  the existing file style; eslint is the style gate.
- REVISED, runtime verification reality: there is no `.env` anywhere in the working tree, so a
  local dev server has no `DATABASE_URL`, no OAuth app credentials, and no `OPENAI_API_KEY`
  (the app appears to be developed against prod, per the debug-in-prod commit history). Runtime
  behavior is verified through unit tests exercising the changed logic (chunk math, state
  signing/verification, rate-limit window, DTO shape) plus `next build`'s page-level
  compilation. Each PR states explicitly what was runtime-verified and what the owner should
  smoke-test after deploy. If the owner runs `vercel env pull` into `app/.env.local`, later
  phases can drive flows in a real dev server.

## 7. Open questions — answered by the review (2026-07-07)

1. CI in Phase 0? YES, kept first. The friction assumption was wrong (the token has `workflow`
   scope, so a direct push is likely to work), the workflow is ~40 lines of one-shot work, and
   every later PR benefits from CI gating once merged. Later phases do not block on the CI
   merge because each phase runs the same commands locally; if the push is rejected after all,
   the branch is handed to the owner and Phase 1 proceeds regardless.
2. Which posting pipeline? KEEP INNGEST, delete the synchronous execution path. Evidence: the
   only client caller (`create-post-form.tsx:197`) always posts `blobUrl` JSON, which routes
   through `createPostJobOnly` + `inngest.send`; the synchronous branches are unreachable from
   the UI, drift-prone (they bypass TikTok metadata), and one of them (multipart) re-implements
   upload handling. Deleting them also shrinks the raw-error surface COR-3 worries about.
   `createPostJobOnly` stays. The PR flags the API-surface narrowing for the owner.
3. Rate limiter store? NEITHER in-memory NOR a new vendor: use the Postgres that is already
   there. In-memory on Vercel serverless is per-instance (horizontal scale multiplies the
   limit, recycling resets it) — it looks like protection without being any. Upstash/Redis
   works but adds a vendor, env vars, and owner setup before the PR even functions. A
   fixed-window per-user counter in a small `RateLimit` table via Prisma is atomic across
   instances, costs one cheap query on routes that already hit the DB for auth, and gives
   HLT-5 an easy test target. It fails OPEN with a loud server-side log if the store errors
   (including "migration not yet applied"), so the limiter can never take posting down. The
   PR documents the required `prisma migrate deploy`. The helper's interface takes
   `(userId, routeKey, limit, windowMs)` so an Upstash backend could swap in later without
   touching the routes.
