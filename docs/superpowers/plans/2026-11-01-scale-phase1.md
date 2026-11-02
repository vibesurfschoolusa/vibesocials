# Scale Readiness, Phase 1, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the phase-1 scale blockers and cheap high-impact issues from the 2026-11-01 scale audit:
- missing indexes, security patches, the unpaginated media list;
- background polling load and auth query count;
- AI cost abuse;
- three approval and media correctness bugs.

**Architecture:** Most fixes are local to one route, hook or lib module. Two Prisma migrations: one adds indexes, one normalizes stored blob URLs. No new services or infrastructure. Pinning the region and setting the pooled DB URL are user-owned vendor settings and are out of scope here.

**Tech Stack:** Next.js 16 App Router, React 19, Prisma 6 / Postgres, NextAuth v4 (JWT), Vitest, Playwright.

**Spec:** the scale-audit reports. They live outside the repo, in the session scratchpad. Read only the section a task cites.
- `C:\Users\Klaus\AppData\Local\Temp\claude\D--Github-apps-vibesocials\16b837d3-1900-4523-b5f8-78ef6e348c80\scratchpad\audit2\db-review.md`
- `...\audit2\web-review.md` (sections W3, W4, W5, W6, W11)
- `...\audit2\correctness-review.md` (sections M1, M2, M3)
- `...\audit2\jobs-review.md` (context only; phase 2)

## Global Constraints

- Never open `app/.env.local` or any `.env*` except `app/.env.example`. It holds production credentials. The worktree has no `.env.local`; keep it that way.
- Never connect to production. Any database work uses the throwaway docker container `vibesocials-scale-pg` on `127.0.0.1:5499`, user `postgres`, password `postgres`. Create your own fresh database in it (`createdb`) and drop it when done. Never touch the `vibesocials_scale` database or the other containers (`vibe-gc-test`, `lightning-postgres`).
- Commit on branch `fix/scale-phase1` only. Never push.
- Gates after every task, run in `app/`, must stay green:
  - `npx tsc --noEmit`: 0 errors;
  - `npx eslint .`: 0 problems;
  - `npx vitest run`: all pass.
- Error JSON keeps the existing `{ error: string, code?: string }` shape. New codes are listed per task.
- New code comments cite the audit the way existing comments do, e.g. `// 2026-11-01 scale audit (W5): ...`.
- Prisma index names use Prisma's default naming, `<Model>_<col1>_<col2>_idx`, so `prisma migrate diff` shows no drift.

## Review Focus

1. **Media "Load more" across inserts and deletes:** the library is paged by `(createdAt desc, id desc)`. Inserts or deletes between pages must not duplicate or skip items. Pinned in Task 3.
2. **Hidden tab coming back:** when a tab becomes visible after its jobs finished, the feed shows fresh state immediately, with no wait for the next tick. Pinned in Task 4.
3. **Password reset elsewhere:** after the change, it still revokes API access on the next request (`getCurrentUser` returns null). Pinned in Task 5.
4. **Blob URL canonicalization:** real Vercel Blob URLs and the e2e mock blob URLs (`http://localhost:9366/...`, explicit port on a local dev host) are still accepted unchanged. Pinned in Task 8.
5. **AI provider parameters:** the OpenAI fallback provider never receives `reasoning_effort`. An over-long field returns 400 without calling the provider. Pinned in Task 6.

---

### Task 1: Security patch upgrades

**Files:**
- Modify: `app/package.json`, `app/package-lock.json`

**Interfaces:** none. Later tasks build and test on these versions.

- [ ] **Step 1: Upgrade the direct dependencies.** Run in `app/`:
  - `npm install next@16.4.3 eslint-config-next@16.4.3 next-auth@4.24.15 @sentry/nextjs@^10.78.0 @vercel/blob@^2.8.2 @prisma/client@6.19.3`
  - and `npm install -D prisma@6.19.3`, or keep `prisma` in whichever section it already lives in.
- [ ] **Step 2: Apply non-breaking transitive fixes.** Run `npm audit fix` (never `--force`).
- [ ] **Step 3: Verify the audit.** Run `npm audit --omit=dev`.
  - Expected: no `critical`.
  - Record every remaining `high` with the reason it needs a major upgrade. Known: `inngest` → `zod`, and `prisma` → `deepmerge-ts`. Put these in the commit body.
- [ ] **Step 4: Run the gates.**
  - Run tsc, eslint and vitest.
  - Then build with throwaway env only: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5499/postgres NEXTAUTH_SECRET=x NEXTAUTH_URL=http://localhost:3000 npm run build`. The migrate step skips because `VERCEL_ENV` is unset.
  - Expected: the build succeeds, with no new deprecation warnings about `proxy.ts`, `reactCompiler` or `experimental.serverActions`. If Next 16.4 deprecates something we use, fix it in this task.
- [ ] **Step 5: Commit.** `chore(deps): patch next, next-auth, sentry, blob, prisma security advisories`

### Task 2: Scale indexes and a direct migration URL

**Files:**
- Modify: `app/prisma/schema.prisma` (models PostJobResult, PostJob, MediaItem, PostMetric, SocialConnection, WorkspaceInvite)
- Create: `app/prisma/migrations/20261101160000_scale_indexes/migration.sql`
- Modify: `app/scripts/migrate-on-vercel-prod.mjs`
- Modify: the existing deploy doc that discusses `DATABASE_URL` (`docs/STAGING_SETUP.md` mentions `-pooler`; pick the doc that owns production env setup)

**Interfaces:**
- Produces:
  - the index `MediaItem_workspaceId_deletedAt_createdAt_id_idx`, used by Task 3's query shape;
  - the env var `DIRECT_URL`, optional, used only for migrations.

- [ ] **Step 1: Add the indexes to `schema.prisma`.** Keep every existing index (no drops in this phase).
  - PostJobResult:
    - `@@index([postJobId, platform])`
    - `@@index([socialConnectionId])`
    - `@@index([platform, createdAt])`
  - PostJob:
    - `@@index([mediaItemId, status])`
    - `@@index([workspaceId, status, createdAt])`
    - `@@index([userId])`
  - MediaItem:
    - `@@index([workspaceId, deletedAt, createdAt, id])`
    - `@@index([storageLocation])`
    - `@@index([userId])`
  - PostMetric:
    - `@@index([postJobResultId])`
    - `@@index([userId])`
  - SocialConnection: `@@index([userId])`
  - WorkspaceInvite: `@@index([workspaceId, revokedAt])`

  Add a one-line comment per index naming the query it serves. db-review.md "Recommended index list" has the mapping.
- [ ] **Step 2: Write `migration.sql`.**
  - One plain `CREATE INDEX "<name>" ON "<Table>"(...)` per index, matching what Prisma would generate.
  - No `CONCURRENTLY`: production tables are small today, and Prisma runs the file as one script.
  - Header comment: future big-table indexes should be built out-of-band with `CONCURRENTLY`.
- [ ] **Step 3: Verify there is no drift on a fresh throwaway DB.**
  - Start the container: `docker start vibesocials-scale-pg`.
  - Create the DB: `docker exec vibesocials-scale-pg createdb -U postgres vs_t2`.
  - Apply: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5499/vs_t2 npx prisma migrate deploy`.
  - Diff: `npx prisma migrate diff --from-url <same> --to-schema-datamodel prisma/schema.prisma --exit-code`.
  - Expected: `No difference detected.`, exit 0.
- [ ] **Step 4: Make `migrate-on-vercel-prod.mjs` prefer `DIRECT_URL`.**
  - Run `prisma migrate deploy` with `env: { ...process.env, DATABASE_URL: process.env.DIRECT_URL || process.env.DATABASE_URL }`.
  - Log which variable was used, `[migrate-on-vercel-prod] using DIRECT_URL` or `using DATABASE_URL`. Never log the value.
- [ ] **Step 5: Verify the script by hand.**
  - Drop and recreate `vs_t2`.
  - Run `VERCEL_ENV=production DATABASE_URL=postgresql://invalid:1/none DIRECT_URL=postgresql://postgres:postgres@127.0.0.1:5499/vs_t2 node scripts/migrate-on-vercel-prod.mjs`.
  - Expected: it logs `using DIRECT_URL` and every migration applies.
  - Then drop `vs_t2`: `docker exec vibesocials-scale-pg dropdb -U postgres vs_t2`.
- [ ] **Step 6: Document the pooled setup.** In the deploy doc, cover:
  - Production `DATABASE_URL` is the Neon pooled host (`-pooler`), with `?sslmode=require&connection_limit=5&pool_timeout=20&connect_timeout=15`, and no `pgbouncer=true`.
  - `DIRECT_URL` is the direct (non-pooler) host. Migrations use it.
  - Keep the Vercel function region equal to the Neon region.
- [ ] **Step 7: Commit.** `perf(db): add FK and hot-path indexes; migrate via DIRECT_URL when set`

### Task 3: Paginate the media library

**Files:**
- Modify: `app/src/app/api/media/route.ts` (GET only)
- Modify: `app/src/components/media-library.tsx`
- Create: `app/src/lib/mediaPagination.ts`, but only if no reusable cursor helper exists. Check how `app/src/app/api/posts/route.ts` builds `nextCursor` first; if it is a standalone helper, reuse it.
- Test: `app/src/app/api/media/route.test.ts`, created or extended. Add a component test only if `media-library` already has one.

**Interfaces:**
- Consumes: the MediaItem index from Task 2. Query shape: `workspaceId` + `deletedAt: null`, ordered `createdAt desc, id desc`.
- Produces: `GET /api/media?cursor=<opaque>&limit=<n>` → `{ items: MediaItemDto[], nextCursor: string | null }`.
  - Default limit 60, max 60. A larger limit is clamped to 60; a non-numeric or <1 limit returns 400 `INVALID_LIMIT`.
  - The cursor is opaque base64url of `{ createdAt ISO, id }`. A bad cursor returns 400 `{ error: "Invalid cursor", code: "INVALID_CURSOR" }`.

- [ ] **Step 1: Write the failing route tests.**
  - The first page returns 60 items, plus `nextCursor` when there are 61 or more.
  - The last page returns `nextCursor: null`.
  - `limit=10` returns 10.
  - `limit=500` is clamped to 60.
  - `limit=abc` returns 400 `INVALID_LIMIT`.
  - A garbage cursor returns 400 `INVALID_CURSOR`.
  - Equal `createdAt` values tie-break by `id desc`: the keyset `where` is `OR: [{ createdAt: { lt } }, { createdAt: equal, id: { lt } }]`. Assert the `findMany` args.
  - It fetches `take: limit + 1` to detect more pages, with no COUNT.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3: Implement the paged GET.** Only these items are page-sized; the per-item DTO is unchanged (`toMediaItemDto`).
- [ ] **Step 4: Update `media-library.tsx`.**
  - Load page 1.
  - Show "Load more" while `nextCursor` is set, and append pages deduped by `id`.
  - After a successful upload (POST), prepend the new item instead of refetching everything.
  - After a delete, remove the item locally.
- [ ] **Step 5:** Run the tests and the gates. Expect a pass.
- [ ] **Step 6: Commit.** `perf(media): paginate the media library (keyset, 60 per page)`

### Task 4: Calmer session and feed polling

**Files:**
- Modify: `app/src/components/session-provider.tsx`
- Modify: `app/src/lib/postJobPolling.ts`, `app/src/hooks/usePostJobs.ts`
- Modify: the feed component that renders the polled list (find it from `usePostJobs` consumers), for the stop hint.
- Test: `app/src/lib/postJobPolling.test.ts`; extend the hook tests if `usePostJobs` has any.

**Interfaces:**
- Produces: `export function nextPollDelayMs(elapsedMs: number): number | null` in `postJobPolling.ts`.
- `usePostJobs` exposes `pollingStopped: boolean` on its result.

- [ ] **Step 1: Write the failing tests for `nextPollDelayMs`.**

  | elapsed (ms) | expected |
  |---|---|
  | `0` | `10_000` |
  | `119_999` | `10_000` |
  | `120_000` | `30_000` |
  | `599_999` | `30_000` |
  | `600_000` | `60_000` |
  | `1_799_999` | `60_000` |
  | `1_800_000` | `null` |
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3: Implement `nextPollDelayMs` and use it in `usePostJobs`.**
  - The schedule starts when polling starts (some job is in flight). It resets to 0 whenever a job newly enters the in-flight set: a new publish, a retry, or a watch added by `postJobPolling`.
  - `null` stops the timer and sets `pollingStopped = true`.
  - While `document.visibilityState === "hidden"`, skip fetches without advancing to stopped.
  - On `visibilitychange` to visible, fetch immediately, then continue the schedule.
  - Unchanged: the poll stops as soon as no job is in flight.
- [ ] **Step 4: Add the stop hint.** When `pollingStopped` is true, the feed shows: `Still processing — refresh to check for updates.`
- [ ] **Step 5: Change the session provider.**
  - In `session-provider.tsx`, set `refetchInterval={0}` and keep `refetchOnWindowFocus`.
  - Comment: server routes enforce `sessionVersion` on every request via `getCurrentUser` (W4).
- [ ] **Step 6: Pin the hidden-tab behavior** (Review Focus 2), if the hook has tests with fake timers.
  - While hidden, no fetch fires across a 60 s advance.
  - Dispatching `visibilitychange` to visible fires exactly one fetch immediately.
- [ ] **Step 7:** Run the tests and the gates. Expect a pass.
- [ ] **Step 8: Commit.** `perf(feed): back off and pause polling in hidden tabs; stop session refetch timer`

### Task 5: Fewer auth queries per request

**Files:**
- Modify: `app/src/lib/auth.ts`, `app/src/lib/workspace.ts`, `app/src/app/api/posts/route.ts` (GET's `memberCount` use)
- Modify: `app/src/app/api/__test-helpers__/workspaceContextMock.ts`
- Test: `app/src/lib/auth.test.ts` and `app/src/lib/workspace.test.ts` (extend existing)

**Interfaces:**
- Produces:
  - `export const serverSessionAuthOptions: NextAuthOptions` in `auth.ts`. It equals `authOptions` except that its `jwt` callback does not query the DB on token reads; on sign-in (`user` present) it still copies `id` and `sessionVersion`.
  - `export async function getWorkspaceMemberCount(workspaceId: string): Promise<number>` in `workspace.ts`.
  - `WorkspaceContext` no longer has `memberCount`.

- [ ] **Step 1: Write the failing tests.**
  - `getCurrentUser` calls `getServerSession` with `serverSessionAuthOptions` and issues exactly one `prisma.user.findUnique`.
  - `serverSessionAuthOptions.callbacks.jwt({ token: { id: "u1", sessionVersion: 0 } })` returns the token without calling prisma.
  - `authOptions.callbacks.jwt` still queries `sessionVersion`; this is unchanged, it serves `/api/auth/session`.
  - A `sessionVersion` mismatch still makes `getCurrentUser` return null (Review Focus 3).
  - `getWorkspaceContext` no longer calls `workspaceMember.count`.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3: Implement `serverSessionAuthOptions`.**
  - Use it only inside `getCurrentUser`.
  - The NextAuth route handler keeps `authOptions`.
  - Grep for other `getServerSession(` callers; none are expected outside `auth.ts`.
  - Comment why this is safe: `getCurrentUser` compares `sessionVersion` against the row it loads.
- [ ] **Step 4: Move the member count out of the context.**
  - Remove the `memberCount` query from `getWorkspaceContext`.
  - `GET /api/posts` calls `getWorkspaceMemberCount(context.workspace.id)` where it builds `workspaceMemberCount`.
  - Update the test mock helper.
- [ ] **Step 5:** Run the tests and the gates. Expect a pass.
- [ ] **Step 6: Commit.** `perf(auth): drop the redundant per-request session-version and member-count queries`

### Task 6: AI endpoint guards

**Files:**
- Create: `app/src/lib/aiGuards.ts`
- Modify: `app/src/lib/llm.ts`, `app/src/app/api/posts/auto-caption/route.ts`, `app/src/app/api/posts/enhance-caption/route.ts`, `app/src/app/api/reviews/draft-response/route.ts`
- Test: route tests for the three routes (extend existing), `app/src/lib/aiGuards.test.ts`, `app/src/lib/llm.test.ts`

**Interfaces:**
- Produces, in `aiGuards.ts`:
  - `export const AI_LIMITS = { caption: 2200, shortField: 40, reviewComment: 4000, name: 200, workspaceDailyCalls: 200 } as const`
  - `export function findOverlongAiField(fields: Array<{ field: string; value: unknown; max: number }>): { field: string; max: number } | null`. Strings longer than `max` fail; non-strings are ignored, because existing type validation owns them.
  - `export async function checkWorkspaceAiQuota(workspaceId: string): Promise<{ allowed: boolean; retryAfterSeconds?: number }>`. It uses the existing `checkRateLimit` with key `ai:workspace:<workspaceId>`, limit `AI_LIMITS.workspaceDailyCalls`, and a 24 h window, shared by all three routes.
- Produces, in `llm.ts`: `export function reasoningParams(provider: string, model: string): { reasoning_effort?: "low" }`. It returns `{ reasoning_effort: "low" }` only when provider is xai and the model matches `/^grok-4\.(5|6|7)(\b|-)/`; otherwise `{}`.

- [ ] **Step 1: Write the failing tests.**
  - `findOverlongAiField`: 2,200 characters passes, 2,201 fails, and a non-string is ignored.
  - `reasoningParams`:
    - (`xai`, `grok-4.5`) → `{ reasoning_effort: "low" }`
    - (`xai`, `grok-4.20-0309-non-reasoning`) → `{}`
    - (`openai`, `gpt-4o-mini`) → `{}`
  - Per route:
    - An over-long field returns 400 `{ code: "AI_INPUT_TOO_LONG", error: "<field> is too long (max <n> characters)." }` and the provider fetch is not called.
    - The workspace quota exhausted returns 429 `{ code: "AI_WORKSPACE_DAILY_LIMIT", error: "Your workspace has reached today's AI limit. Try again tomorrow.", retryAfterSeconds }`.
    - The xai request body includes `reasoning_effort: "low"` for `grok-4.5`.
    - The provider fetch is called with an abort `signal`.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3: Implement.**
  - Order in each route: auth → length check → existing per-user limit → workspace quota → provider call.
  - Limits:
    - auto-caption: `platform`, `language`, `tone` → `shortField`.
    - enhance-caption: `caption` → `caption`, and short fields → `shortField`.
    - draft-response: review comment → `reviewComment`; reviewer and business names → `name`; short fields → `shortField`.
  - Provider fetch: `signal: AbortSignal.timeout(20_000)`. On abort, return 504 `{ error: "The AI service took too long. Try again.", code: "AI_TIMEOUT" }`.
  - Spread `reasoningParams(...)` into the request body.
- [ ] **Step 4:** Run the tests and the gates. Expect a pass.
- [ ] **Step 5: Commit.** `fix(ai): cap prompt inputs, add a per-workspace daily quota, timeouts and low reasoning effort`

### Task 7: Owners see per-platform captions before approving

**Files:**
- Modify: `app/src/app/api/posts/route.ts` (GET DTO mapping), the `PostJobDTO` type (in `app/src/lib/postsDto.ts`)
- Modify: `app/src/app/queue/queue-view.tsx` (the job card)
- Modify: `app/src/server/notifications/approvalRequested.ts` (and the email template it uses)
- Test: extend the existing tests for `postsDto`, `approvalRequested`, and the queue view, if one exists.

**Interfaces:**
- Consumes: `resolvePostCaptionSource(job, mediaItem)`, the caption-snapshot unit the publish path uses (grep for it).
- Produces: `PostJobDTO.platformCaptions: Partial<Record<Platform, string>> | null`. It holds exactly the override texts the publish path will use for the job's target platforms, and is `null` when there are none.

- [ ] **Step 1: Write the failing tests.**
  - The DTO for a job with `perPlatformOverrides: { linkedin: "Hidden text" }` has `platformCaptions.linkedin === "Hidden text"`.
  - A job with none has `platformCaptions === null`.
  - The approval-request email body contains the per-platform text, HTML-escaped (`<b>` renders as text).
  - The queue card renders `LinkedIn: Hidden text` under a heading `Platform-specific captions`, if the view has tests.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3: Implement.**
  - Derive `platformCaptions` from the same `resolvePostCaptionSource` result the publish path uses, so the owner sees what will publish.
  - Render the block on every Queue card that has it. It matters most in the pending-approval state, but it is shown to everyone.
  - Add the block to the approval-request email.
- [ ] **Step 4:** Run the tests and the gates. Expect a pass.
- [ ] **Step 5: Commit.** `fix(approval): show per-platform captions to the approving owner`

### Task 8: Canonical blob URLs for the shared-blob guard

**Files:**
- Modify: `app/src/lib/blobUrl.ts`, `app/src/app/api/media/route.ts` (POST), `app/src/app/api/posts/route.ts` (POST, `storageLocation: body.blobUrl`), `app/src/server/jobs/mediaBlob.ts`
- Create: `app/prisma/migrations/20261101170000_canonicalize_blob_urls/migration.sql`
- Test: `app/src/lib/blobUrl.test.ts`, the `mediaBlob` guard tests, and the media/posts route tests (extend existing)

**Interfaces:**
- Produces: `export function canonicalBlobUrl(url: string): string | null` in `blobUrl.ts`.
  - It trims, then parses with `new URL`.
  - It returns `null` when `isAllowedBlobUrl` is false, or the URL has a username/password, a search, a hash, or an explicit port. An explicit port is allowed only when the existing `isLocalDevHost(hostname)` is true, which covers the e2e mock `http://localhost:9366/...`.
  - Otherwise it returns `protocol + "//" + host + pathname`. WHATWG parsing already lower-cases the host and resolves dot segments; keep `:port` only for local dev hosts.

- [ ] **Step 1: Write the failing tests.**
  - `canonicalBlobUrl`:
    - `U` → `U`;
    - `" " + U` → `U`;
    - `U + "?x=1"` → `null`;
    - `U + "#f"` → `null`;
    - an upper-case host → lower-case canonical;
    - `https://host:443/p` → `null`;
    - `https://host/a/./b` → `https://host/a/b`;
    - `https://user:pw@host/p` → `null`;
    - `http://localhost:9366/x.png` → unchanged.
  - Guard: with a live canonical row A and a variant row B (legacy data) deleted through the guard, the outcome is `kept_shared` and `del` is not called.
  - Routes: POST `/api/media` and POST `/api/posts` with `U + "?x=1"` return 400 with the existing `BLOB_URL_REJECTED_MESSAGE`; with `" " + U` they store `U`.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3: Implement.**
  - Both write paths store `canonicalBlobUrl(...)` and reject `null`.
  - `deleteBlobUnlessShared` computes `key = canonicalBlobUrl(media.storageLocation) ?? media.storageLocation`.
  - It takes the advisory lock on `key`.
  - It counts other live rows whose `storageLocation` is in `[key, media.storageLocation]` (deduplicated).
  - It calls `del(key)`.
- [ ] **Step 4: Write the data migration.** Normalize existing `MediaItem.storageLocation` rows idempotently: `btrim`, drop everything from the first `?` or `#`, lower-case the scheme and host, and remove a literal `:443` after an `https` host. Update only rows whose value changes. Verify on a fresh throwaway DB as in Task 2, Step 3: insert 3 variant rows by hand, run the migration, and check they are canonical and a canonical row is untouched. Then drop the DB.
- [ ] **Step 5:** Run the tests and the gates. Expect a pass.
- [ ] **Step 6: Commit.** `fix(media): canonicalize blob URLs so the shared-blob guard can't be bypassed`

### Task 9: Refuse posts after a workspace switch in another tab

**Files:**
- Modify: `app/src/app/posts/new/page.tsx` (pass the rendered workspace id), `app/src/components/create-post-form.tsx` (send it and handle 409), `app/src/app/api/posts/route.ts` (POST)
- Test: the posts route test (extend), and the create-post-form test if one exists.

**Interfaces:**
- POST `/api/posts` accepts an optional string `workspaceId`. When present and different from `context.workspace.id`, it returns 409 `{ error: "You switched workspace in another tab. Reload this page before posting.", code: "WORKSPACE_CHANGED" }` before any write. When absent, behavior is unchanged (API compatibility).

- [ ] **Step 1: Write the failing tests.**
  - A mismatch returns 409 `WORKSPACE_CHANGED`, with no `mediaItem.create`, `postJob.create` or `inngest.send` call.
  - A matching id proceeds.
  - An absent field proceeds.
  - A non-string `workspaceId` returns 400 `{ code: "INVALID_WORKSPACE_ID" }`.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3: Implement the route check and the composer.** The composer sends the workspace id that rendered the page, and shows the 409 message through its existing error display without resetting the form.
- [ ] **Step 4:** Run the tests and the gates. Expect a pass.
- [ ] **Step 5: Commit.** `fix(composer): refuse a post when the workspace changed in another tab`
