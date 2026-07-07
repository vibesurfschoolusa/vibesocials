# Vibe Socials: Audit Remediation Plan

Status: DRAFT for review. Last updated 2026-07-07.

This plan turns the security and code audit of 2026-07-07 into a phased, multi-model
implementation program. It is meant to be read, challenged, and corrected by the
implementing agent before any code is written. Line references are "as of the audit"
against a clean clone; re-verify them, because they may drift as work lands.

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
  Appears unused by the client. Delete it or read the token server-side from the DB.
- SEC-7 (high): 48 npm vulnerabilities including 1 critical (protobufjs RCE,
  GHSA-xq3m-2v4x-88gg, pulled via Google libs) and 15 high. Run `npm audit fix`, then bump the
  stragglers deliberately.

### Tier 2: Correctness and reliability

- COR-1 (high): TikTok truncates large videos (data loss). `tiktokClient.ts:116` computes
  `totalChunks = Math.floor(size / CHUNK_SIZE)` and the upload loop (208-211) caps every chunk
  including the last at `CHUNK_SIZE`, while init declares `video_size: size` (163). Any video
  not an exact multiple of 10MB uploads short. Separately, a poll that ends without
  `publish_complete` still returns success (294-304), and the poll swallows fetch errors
  (287-289). Fix: extend the final chunk to `size`; treat a non-complete poll as failure.
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
  deletes blob on success only) and `server/jobs/inngest-functions.ts` (the path actually used,
  deletes blob always). `createAndRunPostJob` looks like dead code. Pick one, delete the other.
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
| Security-critical and subtle correctness: SEC-1, SEC-2, COR-1, and the design of the Phase 2 shared helpers | Opus |
| Adversarial review of each phase diff before it becomes a PR (a fresh agent, never the author) | Opus |
| Mechanical, well-scoped fixes: SEC-3, SEC-4, SEC-6, HLT-4, HLT-6, UX-3, and `npm audit fix` | Sonnet |
| Bulk pattern application once Opus sets the pattern: apply `fetchWithTimeout` across ~40 call sites (COR-2), the HLT-2 dedup, unit tests (HLT-5) | Sonnet |

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
the prior PR is approved and merged, since line references and shared helpers shift.

### Phase 0: Guardrails

- HLT-1: add `.github/workflows/ci.yml` running install, `prisma generate`, `tsc --noEmit`,
  `eslint`, `next build` on push and PR.
- Because the active token may lack `workflow` scope, prepare the branch and hand it to the
  owner to push. Everything after this phase should be gated by the workflow.

### Phase 1: Tier 1 security

- Parallelizable (different files): SEC-1, SEC-3, SEC-4, SEC-6, SEC-7.
- Sequential as a unit (shared OAuth surface): SEC-2 across the four callbacks and their start
  routes, plus SEC-5 (add a shared rate-limit utility, then apply it to the three AI routes and
  add the Blob-host allowlist).
- Opus owns SEC-1, SEC-2, SEC-5-design; Sonnet owns SEC-3, SEC-4, SEC-6, SEC-7.

### Phase 2: Shared foundation

Opus designs and lands small, well-tested helpers that later phases depend on:

- `fetchWithTimeout(url, init, ms)` using AbortController.
- `assertOk(res, { code, prefix })`: logs the raw body server-side, throws a sanitized,
  code-tagged error (fixes the COR-3 class in one place).
- `refreshGoogleToken(connection)`: single implementation that preserves `refreshToken`.
- `resolveGbpLocationName(...)`: one copy of the store-code resolver.
- Optional: `downloadToBuffer(url)`, `pollUntil(fn, opts)`.

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
- HLT-5 (Sonnet): add the unit tests; drive `eslint` to green.

### Phase 5: Tier 4 UX polish

- UX-1 through UX-6, lowest stakes. Toast-based feedback, component refactors, grapheme-safe
  truncation, input validation, then the dependency majors last (with CI gating them).

## 6. Verification gate (every phase)

- `tsc --noEmit` run separately (vitest does not typecheck, so a green test run is not enough).
- `eslint` (do not increase the error count; Phase 4 drives it to zero).
- `next build`.
- Run prettier (`npm run format` or `npx prettier --write`) before the first push so the CI
  lint job does not fail on formatting.
- For anything runtime-observable, drive the affected flow in a local dev server and confirm
  behavior, not just that it compiles.

## 7. Open questions for the reviewing agent

1. Is putting CI in Phase 0 worth the workflow-scope handoff friction, or should CI land later?
2. Should HLT-3 keep the Inngest pipeline (current prod path) and delete the synchronous one, or
   is there a reason to keep both?
3. Is a lightweight in-memory rate limiter acceptable for SEC-5 on Vercel's serverless model, or
   is a shared store (Upstash/Redis) needed for it to be effective across instances?
