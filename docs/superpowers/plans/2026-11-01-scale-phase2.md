# Scale Readiness, Phase 2 (Jobs and Platform APIs), Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the publish pipeline and background jobs correct at the reference load: 5,000 workspaces, 20,000 connections, 10,000 posts/day, and bursts of about 500 posts due in the same minute. That means:
- no double posts;
- no post failed by a first 429;
- no step that runs past the 300 s function cap;
- sweeps that drain faster than work arrives.

**Architecture:**
- **Claim-gated platform calls.** Every platform call first claims its `PostJobResult` row (`claimRunId`). That makes the publish functions safe to retry and safe to sleep durably.
- **Flow control in Inngest config.** It covers:
  - env-scoped per-workspace and global concurrency, shared by publish and retry;
  - priority for "Post now";
  - singleton crons;
  - a notification throttle.
- **Typed errors from the platform clients.** Clients classify rate limits (`RATE_LIMITED`) and ambiguous commits (`PUBLISH_UNCONFIRMED`) into typed errors that the run acts on.
- **Serialized token refresh.** Refresh runs under a per-connection advisory lock.
- **Migrations.** Four additive migrations.

**Tech Stack:** Next.js 16, Prisma 6 / Postgres (Neon), Inngest SDK 3.54.2, Vercel Blob, Resend SDK 6.17.2, Vitest 4 (node environment).

**Spec:** the scale-audit reports. They live outside the repo, in the session scratchpad. Read only the section a task cites.
- `C:\Users\Klaus\AppData\Local\Temp\claude\D--Github-apps-vibesocials\16b837d3-1900-4523-b5f8-78ef6e348c80\scratchpad\audit2\jobs-review.md`: B1, H1–H6, M1, M2, M4, M6, M7, "Recommended Inngest flow-control configuration", "Per-platform limits".
- `...\audit2\db-review.md`: H3, H4, M4, M7, M9.
- `...\audit2\correctness-review.md`: L2. L1 and L4 were read and are **not** planned; they are outside the decided scope.

Out of scope, by decision:
- H7 (the X URL footer);
- M8 (X v1.1 → v2);
- B3/M3 (streaming uploads);
- the publish-health redesign;
- M5 (pool config).

## Global Constraints

- **Env files.** Never open `app/.env.local` or any `.env*` except `app/.env.example`. The worktree has no `.env.local`; keep it that way.
- **Databases.** Never connect to production. All database work uses the throwaway docker container `vibesocials-scale-pg` on `127.0.0.1:5499` (user `postgres`, password `postgres`).
  - Create your own fresh database in it and drop it when done.
  - Never touch the `vibesocials_scale` database or the other containers (`vibe-gc-test`, `lightning-postgres`).
- **Branch.** Commit on branch `fix/scale-phase2` only, in worktree `D:\Github_apps\vibesocials\.claude\worktrees\scale-phase2`. Never push.
- **Gates.** Run these in `app/` after every task. They must stay green:
  - `npx tsc --noEmit`: 0 errors;
  - `npx eslint .`: 0 problems;
  - `npx vitest run`: all pass.
- **Error JSON.** Error JSON keeps the existing `{ error: string, code?: string }` shape. New codes are listed per task.
- **Comments.** New code comments cite the audit the way phase 1 did, e.g. `// 2026-11-01 scale audit (jobs H6): ...`.
- **Vendor values.**
  - Every vendor limit lives in a named constant with its source URL in a comment. The sources are in the Vendor facts table below.
  - A value marked *unconfirmed* in that table gets the word "unconfirmed" in its comment.
- **Tests.**
  - Vitest node environment only: `src/**/*.test.ts`. There is no jsdom, so UI copy is tested through pure helpers.
  - Mock `fetch` / `@/lib/fetchWithTimeout`, `@/lib/db` and the Inngest step tools, following the patterns in `inngest-functions.test.ts` (`fakeStep`, `handlerOf`) and the platform client tests.
  - Never call a real platform API, Resend, Inngest or a database.
- **Inngest ids are a contract with in-flight runs.**
  - Never rename a function id.
  - Never rename these existing step ids: `fetch-data`, `publish-to-<platform>`, `finalize-job`, `notify-outcome`, `fetch-retry-data`, `retry-<platform>`, `finalize-retry`, `fail-media-unavailable`, `mark-failed-no-connections`, `claim-due-jobs`, `reconcile-stuck-in-progress`.
  - New step ids are additive and deterministic: no timestamps or random values.
- **Secrets in step output.** Step outputs never contain OAuth tokens or email addresses (existing SEC rule).
- **Migrations.**
  - **Additive only:** nullable columns or new indexes.
  - **Index names:** Prisma default naming (`<Model>_<cols>_idx`), so `prisma migrate diff` shows no drift.
  - **Header:** each `migration.sql` starts with a comment and `SET lock_timeout = '5s';` (db-review M9).
  - **Where they run:** in the Vercel production build, through `scripts/migrate-on-vercel-prod.mjs` (via `DIRECT_URL`), while the old deployment is still serving traffic. So they must work with the old code.
- **Throwaway-DB check ("TDB check <db>").** Run in `app/` (Git Bash):
  1. `docker start vibesocials-scale-pg`
  2. `docker exec vibesocials-scale-pg createdb -U postgres <db>`
  3. `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5499/<db> npx prisma migrate deploy`. Expected: every migration applies, including the new one.
  4. `npx prisma migrate diff --from-url postgresql://postgres:postgres@127.0.0.1:5499/<db> --to-schema-datamodel prisma/schema.prisma --exit-code`. Expected: `No difference detected.`, exit 0.
  5. The task's own `psql` check: `docker exec vibesocials-scale-pg psql -U postgres -d <db> -c '<sql>'`.
  6. `docker exec vibesocials-scale-pg dropdb -U postgres <db>`
- **New env vars** go in `app/.env.example` with a one-line comment. Code reads them through a parser that falls back to the default on a missing or invalid value.

## Vendor facts (checked 2026-11-01)

| # | Fact the plan relies on | Source |
|---|---|---|
| V1 | Event `id` is an idempotency key over 24 h. A duplicate is stored but triggers no function. | https://www.inngest.com/docs/guides/handling-idempotency, https://www.inngest.com/docs/reference/events/send |
| V2 | Function `idempotency` is a CEL key: one run per unique value per 24 h. | https://www.inngest.com/docs/guides/handling-idempotency |
| V3 | A function may have **at most 2** concurrency constraints. A limit counts **executing steps**, and `sleepUntil` frees the slot. `scope: "env"` shares a limit across functions by the evaluated key. A constant key such as `'"openai"'` is allowed. | https://www.inngest.com/docs/guides/concurrency |
| V4 | `priority.run` is a CEL expression evaluating to -600..600 s. It applies within one function, and an invalid expression evaluates to 0. | https://www.inngest.com/docs/guides/priority |
| V5 | Throttle limits run **starts** (period 1 s–7 d); excess runs queue and are not dropped. | https://www.inngest.com/docs/guides/throttling |
| V6 | `singleton: { mode: "skip" }` skips a new run while one is active. A concurrency limit of 1 limits steps, not runs. SDK 3.54.2 types: `singleton?: { key?: string; mode: "skip" \| "cancel" }`. | https://www.inngest.com/docs/guides/singleton, `node_modules/inngest/components/InngestFunction.d.ts:312` |
| V7 | Limits: 5,000 events per `sendEvent`; 4 MiB per step output; `sleepUntil` up to 1 year; 1,000 steps per run; Pro 100 concurrent steps; event 3 MiB (Pro). | https://www.inngest.com/docs/usage-limits/inngest |
| V8 | Retries are counted per step, and completed steps are reused. The handler receives `runId`. `NonRetriableError` and `RetryAfterError` are exported by SDK 3.54.2. | https://www.inngest.com/docs/features/inngest-functions/error-retries/retries, https://www.inngest.com/docs/reference/functions/create |
| V9 | YouTube `videos.insert` has its own bucket of 100 calls/day. The general bucket is 10,000 units. `videos.list` costs 1 unit. "Daily quotas reset at midnight Pacific Time" (page updated 2026-10-15). | https://developers.google.com/youtube/v3/determine_quota_cost |
| V10 | YouTube error reasons: `quotaExceeded` 403; `dailyLimitExceeded` 403; `rateLimitExceeded` 403/429; `userRateLimitExceeded` 403; `uploadLimitExceeded` 400 (per channel, "separate from your Google Cloud project's API quota"). Error body: `error.errors[].reason`. | https://developers.google.com/youtube/v3/docs/core_errors, https://developers.google.com/youtube/v3/docs/errors |
| V11 | Meta throttle codes: 4, 17, 32, 613, 80001 (Page token) and 80002 (Instagram). `X-Business-Use-Case-Usage[...].estimated_time_to_regain_access` is in **minutes**. | https://developers.facebook.com/docs/graph-api/overview/rate-limiting |
| V12 | Instagram code 9 / subcode 2207042 (HTTP 400) means the publishing limit is reached: "try again the following day". Code 4 / subcode 2207051 means suspected spam and is **not** a rate limit. The limit is 100 API posts per 24 h moving window. | https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/error-codes, https://developers.facebook.com/docs/instagram-platform/content-publishing |
| V13 | X returns 429 on excess. `x-rate-limit-reset` is a Unix timestamp in seconds. `POST /2/tweets` allows 100 per 15 min per user and 10,000 per 24 h per app. | https://docs.x.com/x-api/fundamentals/rate-limits |
| V14 | TikTok `rate_limit_exceeded` returns HTTP 429. `video/init` allows 6 requests/min per user token. The body is `{ error: { code, message, log_id } }`. | https://developers.tiktok.com/doc/tiktok-api-v2-error-handling, https://developers.tiktok.com/doc/content-posting-api-reference-direct-post |
| V15 | TikTok refresh: "The returned `refresh_token` may be different … You must use the newly-returned token". Invalidation of the old token is not stated. | https://developers.tiktok.com/doc/oauth-user-access-token-management |
| V16 | LinkedIn rate-limits with 429. Daily limits reset at midnight UTC, and the numbers are unpublished. A refresh returns the same refresh token. | https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits, https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens |
| V17 | GBP: 300 QPM per API and 10 edits/min per profile. It returns 429 on excess; the docs recommend exponential backoff and don't mention `Retry-After`. | https://developers.google.com/my-business/content/limits |
| V18 | Resend allows 10 req/s per team and returns 429 with `retry-after`. `Idempotency-Key` is kept 24 h (≤ 256 chars). A duplicate gets the same response with no resend. A payload mismatch returns 409 `invalid_idempotent_request`; a request still in progress returns 409 `concurrent_idempotent_requests`. SDK 6.17.2 supports `emails.send(payload, { idempotencyKey })`. | https://resend.com/docs/api-reference/rate-limit, https://resend.com/docs/dashboard/emails/idempotency-keys |
| V19 | A Google refresh token stops working after "not been used for six months". | https://developers.google.com/identity/protocols/oauth2 |
| V20 | Postgres advisory locks: the one-key and two-key spaces "do not overlap", and an xact lock is released at the end of its transaction. | https://www.postgresql.org/docs/current/functions-admin.html |

**Unconfirmed.** Each design below fails safe if the guess is wrong.
- **U1:** what Inngest does with a concurrency key or priority expression whose field (`workspaceId`, `immediate`) is missing. This only affects events enqueued before the deploy; the global key still caps them.
- **U2:** Inngest's maximum total request size for one batched send. Dispatch is chunked at 50 events.
- **U3:** YouTube `uploadLimitExceeded` reset time. We wait until the next PT midnight; three misses end as failed.
- **U4:** the maximum ids per `videos.list` call. 50 comes from secondary sources. A wrong cap only leaves metrics stale.
- **U5:** whether Meta (no BUC header), TikTok, LinkedIn and GBP send `Retry-After`. Without one, the backoff schedule applies.
- **U6:** whether `pg_advisory_xact_lock` and `set_config(…, true)` work behind the Neon pooler. Only session-level advisory locks are documented as unsupported (https://neon.com/docs/connect/connection-pooling), and `mediaBlob.ts` already uses xact locks in production. If the lock timeout is ignored, the transaction timeout still bounds the wait.
- **U7:** whether Vercel Fluid keeps running a timed-out invocation's code. The conditional finalize guards against that.

## Review Focus

1. **DST-day YouTube reset.** On DST change days (2026-11-01 today, 2027-03-14), "will publish after <time>" and the budget's day key must land on midnight Pacific, not an hour off. Pinned in Task 4.
2. **Overnight deferral vs. the sweeps.** Take a YouTube result deferred about 20 h while the job's other platforms already finished.
   - The 2 h stuck reconciler and the 6 h stale sweep must not fail it.
   - The job's outcome email is sent once, after YouTube settles.

   Pinned in Task 5.
3. **Events and scanner runs that straddle the deploy.**
   - A `post/publish.requested` without `workspaceId`, `immediate` or an event id still publishes every platform exactly once.
   - A scanner run that re-sends after its step ids changed is deduped by `idempotency: event.data.postJobId`.

   Pinned in Tasks 2 and 3.
4. **Concurrent retries of different platforms of one job.** The `postJobId` concurrency key is gone, so two retry runs can finalize at once. The job must end `completed`/`failed`, not stuck `in_progress`. Pinned in Task 2.
5. **Commit-call outcomes.**
   - A 429 on the tweet-create call after the media uploaded must defer (`RATE_LIMITED`).
   - A 5xx or timeout there must be `PUBLISH_UNCONFIRMED`.
   - A budget refusal before sending stays an ordinary retryable failure.

   Pinned in Task 6.

---

### Task 1: Atomic per-result claim

**Files:**
- Modify: `app/prisma/schema.prisma` (PostJobResult)
- Create: `app/prisma/migrations/20261102100000_post_job_result_claims/migration.sql`
- Create: `app/src/lib/publishOutcomes.ts`
- Create: `app/src/server/jobs/resultClaim.ts`
- Test: `app/src/server/jobs/resultClaim.test.ts`
- Modify: `app/src/server/jobs/inngest-functions.ts`:
  - remove `readStillPendingResult` and the private `finalizeResult`;
  - claim at the start of every `publish-to-<platform>` and `retry-<platform>` step;
  - pass `runId`.
- Modify: `app/src/server/jobs/failPendingResults.ts`, `app/src/server/jobs/scheduledScanner.ts` (`reconcileStuckInProgressJobs`), `app/src/app/api/posts/[postJobId]/retry/route.ts`
- Test: extend `inngest-functions.test.ts`, `failPendingResults.test.ts`, `scheduledScanner.test.ts`, `retry/route.test.ts`

**Why nullable columns, not a new `PostJobResultStatus` value:**
- `pending` keeps its meaning everywhere it is read today: the status recompute, the retry route, `failPendingPostJobResults`, the reconciler, the Activity DTO, the outcome email and publish-health.
- A `claimed` enum value would have to be threaded through every one of those reads, through exhaustive TS switches, and through the old code that keeps serving while the migration lands.
- Two nullable columns are invisible to the old code.

**Interfaces:**
- Produces, in `publishOutcomes.ts`:
  - `PUBLISH_UNCONFIRMED_CODE = "PUBLISH_UNCONFIRMED"`;
  - `PUBLISH_UNCONFIRMED_MESSAGE = "We couldn't confirm this post. It may already be live — check the platform before you retry."` The Activity card prefixes the platform label.
- Produces, in `failPendingResults.ts`:
  - `PUBLISH_UNCONFIRMED: PendingResultFailure`, built from those two;
  - `failPendingPostJobResults` returns `{ failedCount: number; unconfirmedCount: number; status: PostJobStatus }`.
- Produces, in `resultClaim.ts`:
  - `type ClaimOutcome = "claimed" | "not_pending" | "held_by_other_run" | "held_by_this_run"`
  - `type FinalResultData = { status: "success"; externalPostId: string | null } | { status: "failed"; errorCode: string; errorMessage: string }`
  - `claimResult(resultId: string, runId: string, now?: Date): Promise<ClaimOutcome>`
  - `finalizeClaimedResult(resultId: string, runId: string, data: FinalResultData): Promise<boolean>`. It returns false (and logs a warning) when the claim is no longer held.

- [ ] **Step 1: Write the failing tests.**
  - `resultClaim.test.ts`, `claimResult`:
    - It issues exactly `updateMany({ where: { id: "r1", status: "pending", claimRunId: null }, data: { claimRunId: "run-1", claimedAt: NOW } })`. Count 1 → `"claimed"`.
    - Count 0, then a `findUnique` row of:
      - `{ status: "success" }` → `"not_pending"`;
      - `null` → `"not_pending"`;
      - `{ status: "pending", claimRunId: "run-2" }` → `"held_by_other_run"`;
      - `{ status: "pending", claimRunId: "run-1" }` → `"held_by_this_run"`.
  - `resultClaim.test.ts`, `finalizeClaimedResult`:
    - A failure uses `update` with `where: { id: "r1", claimRunId: "run-1", status: "pending" }`. Its data keeps the heartbeat `postJob: { update: { updatedAt: <Date> } }`.
    - A success uses `where: { id, claimRunId, OR: [{ status: "pending" }, { status: "failed", errorCode: "PUBLISH_UNCONFIRMED" }] }`. A confirmed success may replace this run's own unconfirmed mark (U7).
    - A Prisma `P2025` returns `false` and does not throw.
  - `inngest-functions.test.ts`:
    - **Two runs, one call.** `publishToAllPlatforms` for runs `run-1` and `run-2` of the same job. The claim `updateMany` returns 1 for run-1 and 0 for run-2, and run-2's re-read row is `{ status: "pending", claimRunId: "run-1" }`. Expected: `publishVideo` is called **once** in total, and run-2's step returns `status: "skipped"`.
    - **Own claim from a dead attempt.** The re-read row is `{ status: "pending", claimRunId: "run-1" }` while the step runs in `run-1`. Expected: `publishVideo` is not called, and the result is finalized failed `PUBLISH_UNCONFIRMED`.
    - **Retry path.** A result re-claimed by a retry run while the original run (L2) has not reached its step yet. The first claimant publishes and the other skips.
    - Rewrite the existing "only publishes a still-pending result" describe blocks to the claim mocks. Their assertions are unchanged.
  - `failPendingResults.test.ts`:
    - It makes two `updateMany` calls: first `where: { postJobId, status: "pending", claimRunId: { not: null } }` → `PUBLISH_UNCONFIRMED`, then `claimRunId: null` → the caller's failure.
    - `options.platforms` narrows both.
    - The return value includes `unconfirmedCount`.
  - `scheduledScanner.test.ts` (reconciler): a stuck job with one claimed and one unclaimed pending result. The claimed one gets `PUBLISH_UNCONFIRMED`; the unclaimed one gets `PUBLISH_STALLED`.
  - `retry/route.test.ts`: the claim `updateMany` data is `{ status: "pending", errorCode: null, errorMessage: null, claimRunId: null, claimedAt: null }`.
- [ ] **Step 2: Confirm the tests fail.** Run `npx vitest run src/server/jobs/resultClaim.test.ts src/server/jobs/inngest-functions.test.ts src/server/jobs/failPendingResults.test.ts src/server/jobs/scheduledScanner.test.ts "src/app/api/posts/[postJobId]/retry/route.test.ts"`. Expected: FAIL (`resultClaim` is missing; the assertions on the claim args fail).
- [ ] **Step 3: Add the schema and migration.**
  - Schema: add `claimRunId String?` and `claimedAt DateTime?` to `PostJobResult`, with one comment block. The comment covers who holds the claim (the Inngest `runId` of the step about to call the platform) and that a claim is only held inside one step (≤ 300 s).
  - `migration.sql`: the header comment, `SET lock_timeout = '5s';`, then `ALTER TABLE "PostJobResult" ADD COLUMN "claimRunId" TEXT, ADD COLUMN "claimedAt" TIMESTAMP(3);`.
- [ ] **Step 4: Implement the claim in the publish functions.**
  - The handlers destructure `runId`.
  - Each platform step starts with `claimResult(resultRecord.id, runId)`:
    - `not_pending` / `held_by_other_run` → return `{ platform, status: "skipped" }` with no platform call;
    - `held_by_this_run` → `finalizeClaimedResult(..., PUBLISH_UNCONFIRMED)` and return `failed`;
    - `claimed` → today's logic (retry: connection check and repoint, then `publishToPlatform`).
  - Every result write in a platform step goes through `finalizeClaimedResult(resultId, runId, data)`.
  - `failPendingPostJobResults` and the reconciler split claimed and unclaimed rows as tested.
- [ ] **Step 5: Run the TDB check `vs_p2_t1`.** The task's check is `\d "PostJobResult"`. Expected: both columns are present and nullable.
- [ ] **Step 6: Verify.** Run the Step 2 tests, then the gates. Expected: PASS.
- [ ] **Step 7: Commit.** `fix(jobs): claim each platform result atomically before calling the platform`

### Task 2: Event identity, flow control and DB-step retries

**Files:**
- Modify: `app/src/server/jobs/posting.ts` (event type and builders; `prepareDeferredPostJobDispatch` adds `workspaceId`)
- Create: `app/src/server/jobs/publishFlowControl.ts`
- Test: `app/src/server/jobs/publishFlowControl.test.ts`
- Modify: `app/src/server/jobs/failPendingResults.ts` (locked recompute)
- Modify: `app/src/server/jobs/inngest-functions.ts`:
  - options for `publishToAllPlatforms` and `retryPlatforms`;
  - `NonRetriableError`;
  - finalize through the locked recompute;
  - notify event ids;
  - the scanner's current per-job send uses the builder. Task 3 replaces it.
- Modify: `app/src/app/api/posts/route.ts` (POST), `[postJobId]/publish/route.ts`, `[postJobId]/approval/route.ts`, `[postJobId]/retry/route.ts`
- Modify: `app/.env.example` (adds `PUBLISH_CONCURRENCY_PER_WORKSPACE`, `PUBLISH_CONCURRENCY_GLOBAL`)
- Test: `deferredDispatch.test.ts`, `posting.test.ts`, `failPendingResults.test.ts`, `inngest-functions.test.ts`, and the four route tests

**Decisions:**
- **Event ids.**
  - Publish events: `publish-<postJobId>`. A job is dispatched at most once: every dispatcher first moves it out of draft/scheduled/new.
  - Retry events: `retry-<postJobId>-<randomUUID>`, one per request. The random part keeps a legitimate second retry within 24 h from being deduplicated (V1).
- **Function idempotency.** Only `publishToAllPlatforms` gets `idempotency: "event.data.postJobId"` (V2). A function key on retry would swallow legitimate repeat retries; its event id already covers re-sends.
- **Concurrency (V3).** Both functions use the same two **env-scoped** keys, so publish and retry share one budget:
  - per workspace, `'"publish-ws-" + event.data.workspaceId'`, limit 5;
  - global, `'"publish-global"'`, limit 80.

  Both limits are tunable by env and take effect at the next deploy/sync.
  - **Why 5 per workspace:** fewer than 6 TikTok `init`/min per token, because a TikTok step lasts 30–150 s (V14); a ~300-post agency can't take more than 6% of the slots; and X's 100/15 min per user.
  - **Why 80 global:** 80% of Pro's 100 included steps (V7). That leaves room for the scanner, notifications (≤ 8/s), `refresh-connection` (10) and sweeps.
  - **Drain time:** a 500-post burst (~2,000 steps × ~40 s) drains in about 17 min. Buying slots and raising `PUBLISH_CONCURRENCY_GLOBAL` is the lever.
  - **No `postJobId` key on retry any more.** The claim (Task 1) replaces it as the double-publish guard. A row-locked recompute replaces it as the guard against two finalizers racing.
- **"Post now"** gets `priority: { run: "event.data.immediate == true ? 600 : 0" }` (V4, the maximum). An immediate post jumps up to 10 minutes of scheduled backlog. A separate key isn't needed: priority works on the backlog the shared keys create.
- **Item 10: function `retries: 3`.** This is chosen over in-step Prisma retry wrappers, for three reasons:
  - A retried platform step meets its own claim and records `PUBLISH_UNCONFIRMED` instead of calling the platform again.
  - The DB-only steps (`fetch-data`, `fetch-retry-data`, `finalize-*`, `mark-failed-no-connections`, `fail-media-unavailable`) are idempotent reads or recomputes.
  - Retries also rescue the cases wrappers can't reach: a `finalizeClaimedResult` write that fails after the platform accepted the post, and a step killed at 300 s. Today either one fails the run and marks every later platform `PUBLISH_INTERRUPTED`.

  Deterministic failures ("Missing required data") throw `NonRetriableError` (V8).

**Interfaces:**
- Consumes: `claimResult` and `finalizeClaimedResult` (Task 1).
- Produces, in `posting.ts`:
  - `PublishRequestedEventData.workspaceId: string` (now required).
  - `buildPublishEvent<T extends PublishRequestedEventData>(data: T, opts: { immediate: boolean }): { id: string; name: "post/publish.requested"; data: T & { immediate: boolean } }`, with `id = "publish-" + data.postJobId`.
  - `type PublishEvent = ReturnType<typeof buildPublishEvent>`.
  - `buildRetryEvent(data: { postJobId: string; userId: string; workspaceId: string; platforms: Platform[] }, requestId: string): { id: string; name: "post/retry.requested"; data: typeof data }`, with `id = "retry-" + postJobId + "-" + requestId`.
- Produces, in `publishFlowControl.ts`:
  - `DEFAULT_PUBLISH_CONCURRENCY_PER_WORKSPACE = 5`, `DEFAULT_PUBLISH_CONCURRENCY_GLOBAL = 80`.
  - `publishConcurrencyLimits(env?: Record<string, string | undefined>): { perWorkspace: number; global: number }`. Positive integers only; otherwise the default.
  - `publishConcurrency(limits?): [{ scope: "env"; key: string; limit: number }, { scope: "env"; key: string; limit: number }]`.
  - `PUBLISH_PRIORITY = { run: "event.data.immediate == true ? 600 : 0" }`.
- Produces, in `failPendingResults.ts`: `recomputeAndStorePostJobStatus(postJobId: string): Promise<{ status: PostJobStatus; successCount: number }>`.
  - It runs in `prisma.$transaction`.
  - Its first statement is ``tx.$executeRaw`SELECT 1 FROM "PostJob" WHERE "id" = ${postJobId} FOR UPDATE` ``, then it reads the results and writes the status.
  - `failPendingPostJobResults` uses it too.

- [ ] **Step 1: Write the failing tests.**
  - `publishFlowControl.test.ts`:
    - With no env → `{ perWorkspace: 5, global: 80 }`.
    - `"12"` / `"200"` → those values.
    - `"0"`, `"-3"`, `"abc"`, `""` → the defaults.
    - `publishConcurrency({ perWorkspace: 5, global: 80 })` deep-equals `[{ scope: "env", key: '"publish-ws-" + event.data.workspaceId', limit: 5 }, { scope: "env", key: '"publish-global"', limit: 80 }]`.
  - `inngest-functions.test.ts`, options (read `(fn as unknown as { opts: Record<string, unknown> }).opts`):
    - `publishToAllPlatforms` has `retries: 3`, `idempotency: "event.data.postJobId"`, `concurrency` equal to `publishConcurrency()`, `priority` equal to `PUBLISH_PRIORITY`, and `concurrency.length <= 2`.
    - `retryPlatforms` has `retries: 3` and the same concurrency, with no `idempotency` and no `postJobId` key.
  - `inngest-functions.test.ts`, behavior:
    - `fetch-data` with a missing job throws an instance of `NonRetriableError`.
    - `finalize-job` and `finalize-retry` call `recomputeAndStorePostJobStatus("job-1")`. Mock it, or assert `$transaction`.
    - The `notify-outcome` payload has `id: "notify-job-1-run-1"`.
  - **Review Focus 3:** an event with no `workspaceId` and no `immediate` (pre-deploy shape) still publishes every platform.
  - `failPendingResults.test.ts`:
    - `recomputeAndStorePostJobStatus` runs inside `$transaction`, and its first `tx.$executeRaw` call is the `FOR UPDATE` on `"PostJob"`. It returns `{ status: "completed", successCount: 1 }` for `[success, failed]`.
    - **Review Focus 4:** two finalizers serialized by the lock. A mock tx runs callbacks one after another, and the second sees the first one's committed result. The last write is `completed`, not `in_progress`.
  - `deferredDispatch.test.ts`: the `prepareDeferredPostJobDispatch` event includes `workspaceId: "ws-1"`.
  - `posting.test.ts`: `buildPublishEvent(data, { immediate: false })` → `id: "publish-job-1"`, `data.immediate === false`. `buildRetryEvent(d, "abc")` → `id: "retry-job-1-abc"`.
  - Route tests: `inngest.send` is called with `id: "publish-<postJobId>"`, `data.workspaceId === <context workspace id>` and `data.immediate === true` by:
    - `POST /api/posts` (immediate);
    - `POST [postJobId]/publish`;
    - `POST [postJobId]/approval` (publish now).
  - The retry route sends `id` matching `/^retry-job-1-[0-9a-f-]{36}$/` and `data.workspaceId`.
- [ ] **Step 2: Confirm the tests fail.** Run the named files. Expected: FAIL (`publishFlowControl` is missing; the option and send-arg assertions fail).
- [ ] **Step 3: Implement.**
  - The posts route builds its immediate event with `buildPublishEvent({ ...currentData, workspaceId: context.workspace.id }, { immediate: true })`. `location` passes through unchanged.
  - The publish and approval routes call `buildPublishEvent(prep.event, { immediate: true })`.
  - The retry route uses `buildRetryEvent(..., randomUUID())` from `node:crypto`.
  - Document both env vars in `.env.example`, with the 5/80 rationale in one line.
- [ ] **Step 4: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(jobs): stable event ids, idempotency, shared per-workspace and global concurrency, DB-step retries`

### Task 3: Batched scheduled dispatch

**Files:**
- Modify: `app/src/server/jobs/scheduledScanner.ts`
- Modify: `app/src/server/jobs/inngest-functions.ts` (`scheduledPostScanner` only)
- Test: `app/src/server/jobs/scheduledScanner.test.ts` (extend)
- Test: `app/src/server/jobs/scheduledPostScanner.test.ts` (create; handler level, mocks as in `mediaRetentionSweep.test.ts`)

**Decisions:**
- **Batch size.** `DUE_SCAN_BATCH` goes from 100 to 1000, so a 500-post burst is claimed in one tick. The claim SQL is unchanged.
- **Chunks of 50.** Materialize and send run per chunk of 50 jobs: one `materialize-batch-<i>` step plus one `dispatch-batch-<i>` send of up to 50 events. There is no single send because:
  - a worst-case event (7 per-platform captions of 2,200 characters) is about 70 KB, so 50 events fit both the 4 MiB step output (V7) and an unconfirmed request-size cap (U2);
  - a tick is then at most 2 + 3 × 20 steps, against 2,002 today.
- **Deploy straddle.** A scanner run that straddles the deploy re-materializes (idempotent) and re-sends. `idempotency: event.data.postJobId` from Task 2 dedupes the second publish (Review Focus 3).
- **Overlap.** The cron gets `singleton: { mode: "skip" }` (V6). A skipped tick is harmless; the next one claims.

**Interfaces:**
- Consumes: `buildPublishEvent` and `PublishEvent` (Task 2).
- Produces, in `scheduledScanner.ts`:
  - `DUE_SCAN_BATCH = 1000`, `MATERIALIZE_CHUNK_SIZE = 50`.
  - `interface MaterializedBatch { publishEvents: PublishEvent[]; noConnections: Array<{ postJobId: string; userId: string }>; notFound: string[]; errorIds: string[] }`.
  - `materializeClaimedJobs(postJobIds: string[]): Promise<MaterializedBatch>`. It handles jobs one by one, each in its own try/catch.
    - On `ok`: `buildPublishEvent(prep.event, { immediate: false })`.
    - On `NO_CONNECTIONS`: one `postJob.findUnique` for `userId`.
    - On a thrown error: the id goes to `errorIds`, and the job stays `in_progress` for the reconciler, as today.
- Scanner step ids: `claim-due-jobs`, `reconcile-stuck-in-progress`, `materialize-batch-<i>`, `dispatch-batch-<i>` (an array send), and `notify-noconn-batch-<i>` (an array; each event has `id: "notify-noconn-<postJobId>"`). Each send keeps the existing try/catch-and-count.

- [ ] **Step 1: Write the failing tests.**
  - `materializeClaimedJobs(["a", "b", "c"])` where `b` throws: `publishEvents` has the ids `publish-a` and `publish-c` with `data.immediate === false`, and `errorIds` is `["b"]`.
  - A `NO_CONNECTIONS` job lands in `noConnections` with its owner's `userId`.
  - Handler, 120 claimed ids:
    - the `step.run` ids are exactly `["claim-due-jobs", "reconcile-stuck-in-progress", "materialize-batch-0", "materialize-batch-1", "materialize-batch-2"]`;
    - `sendEvent` is called 3 times, with arrays of 50, 50 and 20;
    - no step id matches `/^(materialize|publish)-(?!batch)/`.
  - Handler, 0 claimed: `sendEvent` is not called.
  - Handler, `dispatch-batch-1` rejects: chunks 0 and 2 are still sent, and the summary has `dispatchErrors: 50`.
  - `opts.singleton` deep-equals `{ mode: "skip" }`. `DUE_SCAN_BATCH === 1000`.
- [ ] **Step 2: Confirm the tests fail.** Run `npx vitest run src/server/jobs/scheduledScanner.test.ts src/server/jobs/scheduledPostScanner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the summary shape `{ claimed, dispatched, failedNoConnections, dispatchErrors }`.
- [ ] **Step 4: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `perf(scanner): claim up to 1000 due posts per tick and dispatch them in batched sends`

### Task 4: Rate-limit primitives (client classification and the YouTube budget counter)

**Files:**
- Create: `app/src/server/platforms/rateLimited.ts`
- Test: `app/src/server/platforms/rateLimited.test.ts`
- Create: `app/src/server/platforms/youtubeQuota.ts`
- Test: `app/src/server/platforms/youtubeQuota.test.ts`
- Modify: `app/src/lib/rateLimit.ts`
- Test: `app/src/lib/rateLimit.test.ts` (create; none exists yet)
- Modify: `app/src/server/platforms/transientRetry.ts`. `RATE_LIMITED` is never an in-step retry.
- Modify (classify before the existing error handling at each platform API call site): `xClient.ts` (media INIT/APPEND/FINALIZE/STATUS, v2 tweet), `youtubeClient.ts` (`videos.insert`), `tiktokClient.ts` (`creator_info`, `video/init` HTTP and body code, chunk PUT), `instagramClient.ts` (container, status poll, `media_publish`), `facebookPageClient.ts` (photos), `linkedinClient.ts` (register image/video, upload PUT, `ugcPosts`), `googleBusinessProfileClient.ts` (media create), `gbpLocation.ts` (account and location lookups)
- Test: extend each client test file; create `app/src/server/platforms/googleBusinessProfileClient.test.ts`
- Modify: `app/.env.example` (adds `YOUTUBE_DAILY_UPLOAD_LIMIT=100`)

**Classification rules.** Retry-at sources are in priority order. When the classifier returns `null`, the run's backoff applies (Task 5).

| Platform | Condition | `kind` | `retryAt` | Source |
|---|---|---|---|---|
| x | HTTP 429 | `rate_limited` | `x-rate-limit-reset` × 1000, else `Retry-After` | V13 |
| youtube | 403 with reason `quotaExceeded` or `dailyLimitExceeded` | `youtube_quota` | `nextPacificMidnight(now) + PACIFIC_RESET_GRACE_MS` | V9, V10 |
| youtube | 400 with reason `uploadLimitExceeded` | `daily_limit` | same as above (U3) | V10 |
| youtube | 403 `rateLimitExceeded`/`userRateLimitExceeded`, or any 429 | `rate_limited` | `Retry-After` | V10 |
| tiktok | HTTP 429, or body `error.code === "rate_limit_exceeded"` | `rate_limited` | `Retry-After` (U5) | V14 |
| instagram, facebook_page | body `error.code` ∈ {4, 17, 32, 613, 80001, 80002}, except code 4 with subcode 2207051 (spam); or HTTP 429 | `rate_limited` | `metaRetryAt`, else `Retry-After` (U5) | V11, V12 |
| instagram | code 9 with subcode 2207042 | `daily_limit` | `now + 24 h` | V12 |
| linkedin | HTTP 429 | `rate_limited` | `Retry-After` (U5) | V16 |
| google_business_profile | HTTP 429 | `rate_limited` | `Retry-After` (U5) | V17 |

YouTube reasons are read from `error.errors[].reason` and also from `error.details[].reason`. Anything else returns `null`.

**Interfaces:**
- Produces, in `rateLimited.ts`:
  - `RATE_LIMITED_CODE = "RATE_LIMITED"`, `PACIFIC_RESET_GRACE_MS = 300_000`.
  - `type RateLimitKind = "rate_limited" | "daily_limit" | "youtube_quota"`.
  - `type RateLimitedError = Error & { code: "RATE_LIMITED"; platform: Platform; kind: RateLimitKind; retryAt: number | null }`. Its message is `"<Label> is limiting requests right now."`
  - `rateLimitedError(platform: Platform, kind: RateLimitKind, retryAt: number | null): RateLimitedError`
  - `isRateLimitedError(error: unknown): error is RateLimitedError`
  - `retryAtFromHeaders(headers: Headers, now: number): number | null`. It reads `x-rate-limit-reset` (epoch seconds), then `Retry-After` (delta-seconds or HTTP-date). A value ≤ `now` or unparseable gives `null`.
  - `metaRetryAt(headers: Headers, now: number): number | null`. It takes the maximum `estimated_time_to_regain_access` (minutes) across all `X-Business-Use-Case-Usage` entries. A value ≤ 0 or malformed gives `null`.
  - `pacificDayKey(now: Date): string` (`YYYY-MM-DD` in `America/Los_Angeles`) and `nextPacificMidnight(now: Date): Date`.
  - `classifyRateLimit(platform: Platform, res: Response, now?: number): Promise<RateLimitedError | null>`. It reads a **clone** of the body.
- Produces, in `rateLimit.ts`. `checkRateLimit` is unchanged on the outside and now delegates to:
  - `consumeFixedWindow(opts: { key: string; limit: number; resetAt: Date; failClosed?: boolean }): Promise<RateLimitResult>`. Same upsert, increment and fail-open contract.
  - `exhaustFixedWindow(opts: { key: string; limit: number; resetAt: Date }): Promise<void>`. It upserts `count = limit`, and logs and swallows store errors.
- Produces, in `youtubeQuota.ts`:
  - `DEFAULT_YOUTUBE_DAILY_UPLOAD_LIMIT = 100` (V9).
  - `youtubeDailyUploadLimit(env?): number`. An integer ≥ 0; invalid gives 100; `0` disables YouTube uploads.
  - `consumeYouTubeUploadSlot(now?: Date): Promise<{ allowed: true } | { allowed: false; resetAt: Date }>`, keyed `quota:youtube:videos.insert:<pacificDayKey>` with `resetAt = nextPacificMidnight(now)`. A store error fails open, matching the limiter: Google's own 403 is then classified anyway.
  - `exhaustYouTubeUploadBudget(now?: Date): Promise<void>`.

- [ ] **Step 1: Write the failing tests.**
  - `retryAtFromHeaders`:
    - `Retry-After: 120` → `now + 120_000`;
    - an HTTP-date 90 s ahead → `now + 90_000`;
    - `x-rate-limit-reset: 1793500000` → `1793500000000` (when later than now);
    - a reset in the past → `null`;
    - garbage → `null`.
  - `metaRetryAt`: `{"123":[{"type":"pages","estimated_time_to_regain_access":7}]}` → `now + 420_000`; `0` → `null`; a non-JSON header → `null`.
  - **Review Focus 1**, `nextPacificMidnight`:

    | now (UTC) | expected |
    |---|---|
    | `2026-10-31T12:00:00Z` | `2026-11-01T07:00:00Z` |
    | `2026-11-01T07:30:00Z` | `2026-11-02T08:00:00Z` |
    | `2026-11-01T12:00:00Z` | `2026-11-02T08:00:00Z` |
    | `2027-03-13T12:00:00Z` | `2027-03-14T08:00:00Z` |
    | `2027-03-14T12:00:00Z` | `2027-03-15T07:00:00Z` |

    `pacificDayKey(2026-11-01T06:59:59Z) === "2026-10-31"`, and `pacificDayKey(2026-11-01T07:00:00Z) === "2026-11-01"`.
  - `classifyRateLimit`:
    - one test per table row above;
    - a 500 → `null`;
    - Instagram code 4 / subcode 2207051 → `null`;
    - after classifying, `await res.text()` still returns the original body.
  - `transientRetry.test.ts`: a `RateLimitedError` is not transient, and `withTransientRetries` calls `fn` once.
  - Client tests, one per client:

    | Client | Response | Expected |
    |---|---|---|
    | X | v2 tweet 429 with `x-rate-limit-reset` | `code: "RATE_LIMITED"`, `retryAt` from the header |
    | YouTube | insert 403 `quotaExceeded` | `kind: "youtube_quota"` |
    | TikTok | init 429 | `RATE_LIMITED` |
    | TikTok | init 200 with body `error.code = "rate_limit_exceeded"` | `RATE_LIMITED` |
    | Instagram | container 400 code 80002 | `RATE_LIMITED` |
    | Instagram | `media_publish` 400 code 9 / 2207042 | `kind: "daily_limit"` |
    | Facebook | photos 400 code 32 with a BUC header of 3 min | `retryAt = now + 180_000` |
    | LinkedIn | `ugcPosts` 429 | `RATE_LIMITED`, not `LINKEDIN_POST_CREATION_FAILED` |
    | GBP | media 429 with `Retry-After: 30` | `retryAt = now + 30_000` |
  - `youtubeQuota.test.ts`:
    - the key contains `2026-11-01` for `now = 2026-11-01T12:00:00Z`;
    - the 101st consume with limit 100 → `{ allowed: false, resetAt: 2026-11-02T08:00:00Z }`;
    - `YOUTUBE_DAILY_UPLOAD_LIMIT="0"` → denied on the first call;
    - `"abc"` → limit 100;
    - a rejected upsert → `{ allowed: true }`.
  - `rateLimit.test.ts`:
    - `checkRateLimit` still keys `<userId>:<route>:<bucket>`;
    - `exhaustFixedWindow` upserts `create: { key, count: limit, expiresAt: resetAt }`, `update: { count: limit }`.
- [ ] **Step 2: Confirm the tests fail.** Run `npx vitest run src/server/platforms src/lib/rateLimit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - At each listed call site: `const limited = await classifyRateLimit(<platform>, res); if (limited) throw limited;`, placed before `assertOk` or the client's own error building.
  - Untouched: the TikTok status poll, which absorbs errors by design; token endpoints, whose transient handling exists; and the X v1.1 `statuses/update`, which keeps falling back to v2 on any non-5xx error.
  - `isTransientPublishError` returns `false` for `code === "RATE_LIMITED"`.
  - Between this task and Task 5, a `RateLimitedError` is recorded as a failed result with code `RATE_LIMITED`, as today's 429s are.
- [ ] **Step 4: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(platforms): classify 429 and quota responses as RATE_LIMITED; add the YouTube daily upload counter`

### Task 5: Durable rate-limit deferral and the deferral notice

**Files:**
- Modify: `app/prisma/schema.prisma` (`PostJobResult.deferredUntil`)
- Create: `app/prisma/migrations/20261102110000_post_job_result_deferral/migration.sql`
- Create: `app/src/server/jobs/platformSteps.ts`
- Test: `app/src/server/jobs/platformSteps.test.ts`
- Modify: `app/src/server/jobs/resultClaim.ts` (release for deferral; the claim clears deferral fields)
- Modify: `app/src/server/jobs/inngest-functions.ts`:
  - `publishToPlatform`: YouTube preflight, `RateLimitedError` handling, and `attempt`/`runId` arguments;
  - both publish functions run their platforms through `runPlatformStepsWithDeferrals`;
  - `stalePostJobSweep`: deferral exclusion and `singleton`.
- Modify: `app/src/server/jobs/scheduledScanner.ts` (reconciler deferral exclusion), `app/src/app/api/posts/[postJobId]/retry/route.ts` (also clears `deferredUntil`)
- Create: `app/src/lib/resultDeferral.ts`
- Test: `app/src/lib/resultDeferral.test.ts`
- Modify: `app/src/lib/postsDto.ts`, `app/src/app/api/posts/route.ts` (GET select and mapping), `app/src/components/activity/post-job-card.tsx`
- Test: extend `inngest-functions.test.ts`, `resultClaim.test.ts`, `scheduledScanner.test.ts`, `route.get.test.ts`, `retry/route.test.ts`

**Decisions:**
- **Where the deferral lives.** A deferred result stays `pending`, holds no claim, and carries `deferredUntil` plus `errorCode` `RATE_LIMITED` or `DAILY_LIMIT`.
  - `deferredUntil` is a nullable column, for the same reason the claim is: the old code ignores it.
  - The run sleeps with `step.sleepUntil` (V3: no slot held; V7: well under 1 year).
- **Platform order.** The first pass runs every platform in its existing order. Deferred platforms are retried afterwards, earliest `retryAt` first, so a sleeping YouTube never delays LinkedIn.
- **Bounds.**
  - `MAX_RATE_LIMIT_RETRIES = 3` per result per run.
  - `retryAt` is clamped to at least `now + 30 s`.
  - If `retryAt - now > 24 h`, the run gives up.
  - With no vendor reset time, the backoff is `[60_000, 900_000, 3_600_000]` ms (GBP's documented backoff, V17).
  - When it gives up, the result is finalized failed:
    - code `RATE_LIMITED`, message `"<Label> kept rate-limiting this post. Retry this platform later."`;
    - or code `DAILY_LIMIT`, message `"<Label>'s daily limit is still reached. Retry this platform later."`
- **YouTube budget.** For `youtube`, `publishToPlatform` calls `consumeYouTubeUploadSlot()` after the claim and **outside** `withTransientRetries`, so an in-step retry never spends a second slot.
  - When the budget is exhausted, the run throws `rateLimitedError("youtube", "youtube_quota", resetAt + PACIFIC_RESET_GRACE_MS)` and does not call the API.
  - Any `youtube_quota` error, including Google's own 403, calls `exhaustYouTubeUploadBudget()`. That trips the counter for the rest of the PT day.
- **Sweeps.**
  - The reconciler (2 h) and `stalePostJobSweep` (6 h) skip jobs where `results: { none: { status: "pending", deferredUntil: { gte: cutoff } } }` does not hold.
  - The deferral write also bumps `PostJob.updatedAt`.
  - Claims from a dead run are failed `PUBLISH_UNCONFIRMED` by the reconciler (Task 1).
  - `stalePostJobSweep` gets `singleton: { mode: "skip" }`.

**Interfaces:**
- Consumes:
  - `RateLimitedError`, `isRateLimitedError`, `PACIFIC_RESET_GRACE_MS`, `consumeYouTubeUploadSlot` and `exhaustYouTubeUploadBudget` (Task 4);
  - `claimResult` and `finalizeClaimedResult` (Task 1).
- Produces, in `platformSteps.ts`:
  - `MAX_RATE_LIMIT_RETRIES = 3`, `RATE_LIMIT_BACKOFF_MS = [60_000, 900_000, 3_600_000] as const`, `MIN_RATE_LIMIT_WAIT_MS = 30_000`, `MAX_RATE_LIMIT_WAIT_MS = 86_400_000`.
  - `resolveDeferral(err: RateLimitedError, attempt: number, now: number): { retryAt: number } | { giveUp: true }`
  - `type PlatformStepOutcome = { platform: Platform; status: "success" | "failed" | "skipped"; error?: string } | { platform: Platform; status: "deferred"; retryAt: string }`
  - `interface PlatformStepPlan { platform: Platform; stepId: string; run: (attempt: number) => Promise<PlatformStepOutcome> }`
  - `runPlatformStepsWithDeferrals(step: Pick<GetStepTools<typeof inngest>, "run" | "sleepUntil">, plans: PlatformStepPlan[]): Promise<PlatformStepOutcome[]>`. `GetStepTools` is exported by `inngest`. It returns the final outcome per platform, in plan order.
    - Attempt 0 uses `stepId`. Today's ids stay `publish-to-<p>` and `retry-<p>`.
    - Attempt n uses `` `${stepId}-rl${n}` ``.
    - The sleep before attempt n uses `` `${stepId}-wait-rl${n}` ``.
- Produces, in `resultClaim.ts`:
  - `releaseClaimForDeferral(resultId: string, runId: string, deferral: { until: Date; errorCode: "RATE_LIMITED" | "DAILY_LIMIT" }): Promise<boolean>`. Where `{ id, claimRunId: runId, status: "pending" }`, it sets `claimRunId: null`, `claimedAt: null`, `deferredUntil` and `errorCode`, with `errorMessage: null` and the job heartbeat bump.
  - `claimResult` data now also sets `deferredUntil: null`, `errorCode: null`, `errorMessage: null`.
- Produces, in `resultDeferral.ts`:
  - `type DeferralKind = "daily_limit" | "rate_limited"`
  - `deferralKindFromErrorCode(code: string | null): DeferralKind`. `"DAILY_LIMIT"` gives `daily_limit`; anything else gives `rate_limited`.
  - `describeDeferral(label: string, kind: DeferralKind, until: Date, format: (d: Date) => string): string`
- Produces `PostJobResultDTO.deferral: { kind: DeferralKind; until: string } | null`. It is non-null only for a `pending` result with `deferredUntil` set. `errorCode` itself is still not exposed.

- [ ] **Step 1: Write the failing tests.**
  - `platformSteps.test.ts`, `resolveDeferral`:
    - `retryAt: null` at attempt 0 → `now + 60_000`; at attempt 2 → `now + 3_600_000`;
    - attempt 3 → `giveUp`;
    - `retryAt = now + 25 h` → `giveUp`;
    - `retryAt = now + 5_000` → `now + 30_000`.
  - `platformSteps.test.ts`, `runPlatformStepsWithDeferrals`. Plans x: success, youtube: deferred to T+10 h, linkedin: success. The call order is:
    1. `run("publish-to-x")`
    2. `run("publish-to-youtube")`
    3. `run("publish-to-linkedin")`
    4. `sleepUntil("publish-to-youtube-wait-rl1", T+10h)`
    5. `run("publish-to-youtube-rl1")` with attempt 1

    With two deferred platforms, the earlier `retryAt` is slept first.
  - `inngest-functions.test.ts`:
    - `publishVideo` throws `rateLimitedError("x", "rate_limited", T+2h)`. Expected: no failed finalize; `releaseClaimForDeferral` is called with `until = T+2h` and `RATE_LIMITED`; the step outcome is `deferred`.
    - The 4th consecutive limit (attempt 3) → finalized failed `RATE_LIMITED` with the give-up copy.
    - YouTube with `consumeYouTubeUploadSlot` → `{ allowed: false, resetAt: R }`. Expected: `publishVideo` is not called; the result is deferred to `R + 300_000` with `DAILY_LIMIT`.
    - A `youtube_quota` error from `publishVideo` → `exhaustYouTubeUploadBudget` is called once.
    - `stalePostJobSweep`'s `updateMany` where includes the deferral `none` filter, and its `opts.singleton` is `{ mode: "skip" }`.
  - **Review Focus 2:**
    - `scheduledScanner.test.ts`: the reconciler's `findMany` where includes `results: { none: { status: "pending", deferredUntil: { gte: <now - 2h> } } }`.
    - `inngest-functions.test.ts`: a run where X succeeds and YouTube defers, then succeeds after the sleep. `notify-outcome` is sent exactly once, after `finalize-job`, which itself runs after `publish-to-youtube-rl1`.
  - `resultDeferral.test.ts`:
    - `describeDeferral("YouTube", "daily_limit", d, () => "Nov 2, 12:05 AM") === "YouTube daily limit reached — will publish after Nov 2, 12:05 AM"`;
    - the `rate_limited` copy is `"X rate limit reached — will retry after <t>"`.
  - `route.get.test.ts`:
    - a pending result with `deferredUntil` and `errorCode: "DAILY_LIMIT"` → `deferral: { kind: "daily_limit", until: <ISO> }`;
    - a failed result → `deferral: null`;
    - no DTO key named `errorCode`.
  - `retry/route.test.ts`: the claim data includes `deferredUntil: null`.
- [ ] **Step 2: Confirm the tests fail.** Run the named files. Expected: FAIL.
- [ ] **Step 3: Add the schema and migration.**
  - Schema: add `deferredUntil DateTime?` with a comment.
  - `migration.sql`: the header, `SET lock_timeout = '5s';`, then `ALTER TABLE "PostJobResult" ADD COLUMN "deferredUntil" TIMESTAMP(3);`.
- [ ] **Step 4: Implement.**
  - The card renders one muted line per result with a `deferral`: `describeDeferral(platformLabel(p), kind, new Date(until), d => d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))`.
- [ ] **Step 5: Run the TDB check `vs_p2_t5`.** The task's check is `\d "PostJobResult"`. Expected: `deferredUntil` is present and nullable.
- [ ] **Step 6: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 7: Commit.** `feat(jobs): defer rate-limited platforms with durable sleeps and budget YouTube uploads per Pacific day`

### Task 6: Commit-call safety

**Files:**
- Create: `app/src/server/platforms/commitCall.ts`
- Test: `app/src/server/platforms/commitCall.test.ts`
- Modify: `app/src/server/platforms/transientRetry.ts`. Export `isNeverConnectedFetchError`; `PUBLISH_UNCONFIRMED` is not transient.
- Modify (the final create call only):

  | File | Commit call |
  |---|---|
  | `xClient.ts` | v1.1 `statuses/update` and v2 `POST /2/tweets` |
  | `youtubeClient.ts` | `videos.insert` |
  | `tiktokClient.ts` | the **final** chunk PUT. Direct Post publishes once the upload completes, so earlier chunks stay retryable. |
  | `instagramClient.ts` | `media_publish` |
  | `facebookPageClient.ts` | `POST /{page}/photos` |
  | `linkedinClient.ts` | `POST /v2/ugcPosts` |
  | `googleBusinessProfileClient.ts` | `POST …/media` |
- Modify: `app/src/lib/postsDto.ts`, `app/src/app/api/posts/route.ts` (GET), `app/src/components/activity/post-job-card.tsx`
- Test: extend each client test, `transientRetry.test.ts`, `route.get.test.ts`

**Decisions:**
- **The rule.** Only provably-unsent or rejected outcomes reach the existing retry and failure paths. Everything ambiguous on the commit call becomes `PUBLISH_UNCONFIRMED`, and it is never retried in-step, so upload phases are the only thing `withTransientRetries` repeats. The cases:

  | Outcome of the commit call | Handling |
  |---|---|
  | 5xx | `PUBLISH_UNCONFIRMED` |
  | `FETCH_TIMEOUT` | `PUBLISH_UNCONFIRMED` |
  | post-connect network error | `PUBLISH_UNCONFIRMED` |
  | `PUBLISH_TIME_BUDGET_EXCEEDED` thrown before sending | rethrown unchanged (not sent) |
  | never-connected `TypeError` | rethrown unchanged (provably not sent) |
  | 429 and other 4xx | returned to the caller, which classifies (Task 4) or fails as today |
- **X v1.1.** A v1.1 5xx or ambiguous error no longer falls back to v2, because v1.1 may have posted. A v1.1 4xx/429 still falls back.
- **Inline notice.** The card shows `PUBLISH_UNCONFIRMED` failures inline, outside the collapsed "Show errors" list, so the warning is visible before the Retry button is used.

**Interfaces:**
- Consumes: `PUBLISH_UNCONFIRMED_CODE` and `PUBLISH_UNCONFIRMED_MESSAGE` (Task 1); `classifyRateLimit` (Task 4).
- Produces, in `commitCall.ts`:
  - `publishUnconfirmedError(platform: Platform, cause?: unknown): Error & { code: "PUBLISH_UNCONFIRMED" }`, with the message `PUBLISH_UNCONFIRMED_MESSAGE`.
  - `commitRequest(platform: Platform, send: () => Promise<Response>): Promise<Response>`
- Produces `PostJobResultDTO.unconfirmed: boolean`. It is true for a `failed` result with `errorCode === "PUBLISH_UNCONFIRMED"`.

- [ ] **Step 1: Write the failing tests.**
  - `commitCall.test.ts`:
    - a 503 → throws `PUBLISH_UNCONFIRMED` with `cause` set;
    - a `FETCH_TIMEOUT` error → `PUBLISH_UNCONFIRMED`;
    - `TypeError("fetch failed", { cause: { code: "ECONNRESET" } })` → `PUBLISH_UNCONFIRMED`;
    - `{ cause: { code: "ECONNREFUSED" } }` → the same `TypeError`, rethrown;
    - an error with code `PUBLISH_TIME_BUDGET_EXCEEDED` → rethrown;
    - 429, 400 and 200 → the response is returned.
  - `transientRetry.test.ts`: `withTransientRetries` with a `fn` throwing `PUBLISH_UNCONFIRMED` calls `fn` once.
  - Client tests:
    - YouTube insert 502 → `PUBLISH_UNCONFIRMED`, with the insert fetched once.
    - X v1.1 502 → `PUBLISH_UNCONFIRMED`, and v2 is **not** requested.
    - X v1.1 403 → falls back to v2 (unchanged).
    - TikTok: a 503 on chunk 1 of 3 → `TIKTOK_UPLOAD_FAILED` with `status: 503` (retryable); a 503 on the final chunk → `PUBLISH_UNCONFIRMED`.
    - Instagram `media_publish` 500 → `PUBLISH_UNCONFIRMED`.
    - Facebook photos timeout → `PUBLISH_UNCONFIRMED`.
    - LinkedIn `ugcPosts` 503 → `PUBLISH_UNCONFIRMED`.
    - GBP media 500 → `PUBLISH_UNCONFIRMED`.
  - **Review Focus 5:**
    - X: media uploaded, then v2 tweet 429 → `RATE_LIMITED` (not unconfirmed).
    - YouTube with a deadline 4 s away → `PUBLISH_TIME_BUDGET_EXCEEDED` and no insert request.
  - `route.get.test.ts`: a failed `PUBLISH_UNCONFIRMED` result → `unconfirmed: true`; any other failure → `false`.
- [ ] **Step 2: Confirm the tests fail.** Run `npx vitest run src/server/platforms src/app/api/posts/route.get.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Wrap each commit `fetchWithTimeout` as `commitRequest(platform, () => fetchWithTimeout(...))`. The classification and the existing 401/4xx handling follow unchanged.
- [ ] **Step 4: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `fix(platforms): never re-run a commit call; report an ambiguous commit as PUBLISH_UNCONFIRMED`

### Task 7: Step deadlines for YouTube, LinkedIn, Instagram and GBP

**Files:**
- Modify: `app/src/server/platforms/youtubeClient.ts`, `linkedinClient.ts`, `instagramClient.ts`, `googleBusinessProfileClient.ts`, `gbpLocation.ts`, `googleTokens.ts`, `tiktokClient.ts` (refresh functions only)
- Test: extend `youtubeClient.test.ts`, `linkedinClient.test.ts`, `instagramClient.test.ts`, `googleBusinessProfileClient.test.ts`, `gbpLocation.test.ts`, `googleTokens.test.ts`, `tiktokClient.test.ts`

**Decisions:**
- **Rule.** Same as X/TikTok (`publishBudget.ts`): every request's timeout is `budgetedTimeout(<today's timeout>, ctx.deadline)`, and downloads also get `AbortSignal.timeout(<same value>)`. A request with less than 5 s left is never started.
- **Refreshes.** Token refreshes accept the deadline too, so a refresh during publish can't push the step past it. This is the hook Task 8 wraps.
- **Instagram.**
  - The in-step 5 s polling is kept, but bounded: polling stops while there is still `INSTAGRAM_PUBLISH_RESERVE_MS = 20_000` left for `media_publish`, and ends with `INSTAGRAM_VIDEO_TIMEOUT`. Nothing was published, so a retry is safe.
  - Meta's "once per minute, ≤ 5 min" guidance (V12) needs polling across steps with `step.sleep`. That is phase 3.
- **Result.** All I/O ends by `publishDeadline()` (225 s), so a step ends well inside Vercel's 300 s.

**Interfaces:**
- Produces:
  - `refreshGoogleToken(connection: SocialConnection, opts?: { deadline?: number }): Promise<SocialConnection>`
  - `refreshLinkedInToken(connection, opts?: { deadline?: number })`
  - `ensureFreshLinkedInToken(connection, deadline?: number)`
  - `refreshTikTokToken(connection, opts?: { deadline?: number })`
  - `ensureFreshTikTokToken(connection, deadline?: number)`
  - `resolveGbpLocationName(accessToken: string, raw: string, deadline?: number): Promise<string>`
- Produces, in `instagramClient.ts`:
  - `INSTAGRAM_POLL_INTERVAL_MS = 5_000`, `INSTAGRAM_POLL_MAX_ATTEMPTS = 30`, `INSTAGRAM_PUBLISH_RESERVE_MS = 20_000`.
  - `waitForInstagramContainer(opts: { containerId: string; accessToken: string; connectionId: string; deadline?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<void>`

- [ ] **Step 1: Write the failing tests.** Each of the YouTube, LinkedIn (video), Instagram (reel) and GBP clients gets:
  - "refuses to start once the step budget is spent". With `deadline: Date.now() + MIN_REQUEST_WINDOW_MS - 1`, it rejects with `PUBLISH_TIME_BUDGET_EXCEEDED` and `fetch` is never called.
  - "worst case: hung requests still settle by the step deadline". Use fake timers and a `fetch` mock that only settles on abort, with `deadline = start + PUBLISH_STEP_BUDGET_MS`. Expected: `settledAt <= deadline`. Mirror `tiktokClient.test.ts` "worst case…".

  Plus:
  - `waitForInstagramContainer` with `deadline = clock + 40_000` and a status that stays `IN_PROGRESS`. It throws `INSTAGRAM_VIDEO_TIMEOUT` with `deadline - clock >= INSTAGRAM_PUBLISH_RESERVE_MS`, and `media_publish` is never requested.
  - `googleTokens.test.ts`: with a deadline 8 s away, the token fetch's timeout argument is `<= 8_000`.
  - `gbpLocation.test.ts`: each lookup's timeout argument is `<=` the remaining time.
- [ ] **Step 2: Confirm the tests fail.** Run `npx vitest run src/server/platforms`. Expected: FAIL.
- [ ] **Step 3: Implement.** Thread `deadline` from `ctx` into every helper call:
  - LinkedIn: `uploadImage`, `uploadVideo` and `createPost` get a `deadline` parameter.
  - YouTube/GBP: the refresh call passes `{ deadline }`.
- [ ] **Step 4: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `fix(platforms): bound YouTube, LinkedIn, Instagram and GBP requests by the step deadline`

### Task 8: Serialized token refresh and the connection-health fan-out

**Files:**
- Create: `app/src/server/platforms/connectionRefresh.ts`
- Test: `app/src/server/platforms/connectionRefresh.test.ts`
- Modify: `app/src/server/platforms/connectionHealth.ts` (guarded flag, superseded error)
- Modify: `googleTokens.ts`, `tiktokClient.ts`, `linkedinClient.ts`. Their refreshers pass the tokens they used to the guarded flag.
- Modify (route every refresh through the helper): `youtubeClient.ts`, `googleBusinessProfileClient.ts`, TikTok/LinkedIn `ensureFresh*`, `app/src/server/googleReviews.ts`, `app/src/app/api/connections/google_business_profile/locations/route.ts`, the metrics sync `resolveConnection` in `inngest-functions.ts`
- Modify: `app/src/server/jobs/connectionHealthSweep.ts`
- Modify: `app/src/server/jobs/inngest-functions.ts`:
  - rewrite `connectionHealthSweep`;
  - add a `refreshConnection` function, registered in `inngestFunctions`.
- Test: extend `connectionHealth.test.ts`, `googleTokens.test.ts`, `tiktokClient.test.ts`, `linkedinClient.test.ts`, `connectionHealthSweep.test.ts`; create `app/src/server/jobs/connectionHealthJobs.test.ts`

**Decisions:**
- **Which platforms.**
  - TikTok rotates refresh tokens (V15).
  - X is **OAuth 1.0a** in this app and never refreshes (`xClient.ts:97-101`). It is excluded until an OAuth 2.0 migration, which must use this helper.
  - Google and LinkedIn don't rotate (V16; `googleTokens.ts` header) but still go through the helper, so there is one choke point and the guarded flag applies everywhere.
  - Instagram and Facebook make no refresh call.
- **The lock.**
  - The helper opens `prisma.$transaction` (`{ maxWait: 10_000, timeout: min(60_000, time left) }`) only to **hold** the lock:
    - `SELECT set_config('lock_timeout', '20000ms', true)`;
    - then `SELECT pg_advisory_xact_lock(7301, hashtext(<connectionId>))`.

    This is the two-key space, so it can't collide with `mediaBlob.ts`'s one-key URL locks (V20).
  - Reads and writes go through the normal extended `prisma`: tokens are decrypted, and Read Committed sees the previous holder's commit. So the platform refreshers stay unchanged.
  - The lock is transaction-scoped, which the Neon pooler allows (U6).
- **Re-read inside the lock.** If the stored `accessToken` or `refreshToken` differs from the caller's snapshot, another process already refreshed. The stored row is returned and no refresh is made.
- **Re-read before flagging.** A refresher's terminal failure calls `markConnectionNeedsReconnect(id, code, { expected })`.
  - If the stored tokens differ from `expected`, it writes nothing and the refresher throws `TOKEN_REFRESH_SUPERSEDED`.
  - The helper turns that into "return the stored row".
- **Health sweep.**
  - The cron only pages connection ids, filtered in SQL. Each id is fanned out to `refresh-connection`: `retries: 2`, `concurrency: [{ key: "event.data.socialConnectionId", limit: 1 }, { limit: 10 }]` (V3).
  - Event ids `refresh-<id>-<UTC YYYY-MM-DD>` dedupe a re-run on the same day.
  - The cron gets `singleton: { mode: "skip" }`.
- **Google connections** refresh only when idle for about 7 days: `expiresAt < now - GOOGLE_IDLE_REFRESH_MS`. A Google token lives 1 h, so `expiresAt` is about the last refresh plus 1 h, and no new column is needed. That is well inside the 6-month unused-token expiry (V19). Other platforms keep the 24 h horizon.

**Interfaces:**
- Consumes: the refresher deadline options and `budgetedTimeout` (Task 7).
- Produces, in `connectionRefresh.ts`:
  - `REFRESH_LOCK_NAMESPACE = 7301`, `REFRESH_LOCK_WAIT_MS = 20_000`, `REFRESH_TX_TIMEOUT_MS = 60_000`, `CONNECTION_REFRESH_BUSY_CODE = "CONNECTION_REFRESH_BUSY"`.
  - `refreshConnectionToken(snapshot: SocialConnection, refresh: (current: SocialConnection) => Promise<SocialConnection>, opts?: { deadline?: number }): Promise<SocialConnection>`. It throws:
    - `CONNECTION_GONE` when the row is gone;
    - `RECONNECT_REQUIRED` when the row is already flagged (no refresh);
    - `CONNECTION_REFRESH_BUSY` with `status: 503` on a lock timeout. It is transient, so the publish retries in-step; nothing was sent.
    - `PUBLISH_TIME_BUDGET_EXCEEDED` when there is less than `MIN_REQUEST_WINDOW_MS` left. No transaction is opened.
- Produces, in `connectionHealth.ts`:
  - `markConnectionNeedsReconnect(connectionId: string, code: string, opts?: { expected?: { accessToken: string; refreshToken: string | null } }): Promise<"flagged" | "superseded" | "error">`. Without `opts`, behavior is unchanged.
  - `TOKEN_REFRESH_SUPERSEDED_CODE = "TOKEN_REFRESH_SUPERSEDED"`, `tokenRefreshSupersededError(): Error & { code: string }`.
- Produces, in `connectionHealthSweep.ts`:
  - `GOOGLE_IDLE_REFRESH_MS = 604_800_000`, `HEALTH_SWEEP_PAGE_SIZE = 1000`.
  - `isProactiveRefreshEligible(connection: { platform: Platform; needsReconnect: boolean; expiresAt: Date | string | null }, now: Date): boolean`
  - `proactiveRefreshWhere(now: Date): Prisma.SocialConnectionWhereInput`
- Produces the event `connection/refresh.requested` `{ socialConnectionId: string }`.
- Produces the function `refreshConnection` (id `refresh-connection`) with steps:
  - `refresh` returns `"refreshed" | "flagged" | "already_flagged" | "not_eligible" | "gone" | "no_refresh" | "transient_error"`;
  - `notify-owners` runs only on `"flagged"`.
- The cron's steps are `start` (returns the ISO `now`), then `page-<i>` and `fan-out-<i>`.

- [ ] **Step 1: Write the failing tests.**
  - `connectionRefresh.test.ts` (`$transaction` mock invokes the callback with a tx that records `$executeRaw`):
    - **Lock order:** the `set_config` and then `pg_advisory_xact_lock(7301, hashtext('conn-1'))` statements run before the re-read.
    - **Stored tokens changed:** `refresh` is not called, and the stored row is returned.
    - **Tokens unchanged:** `refresh` is called once, with the stored row.
    - **Superseded:** `refresh` throws `TOKEN_REFRESH_SUPERSEDED`, and the re-read row is returned.
    - **Row states:** a gone row → `CONNECTION_GONE`; `needsReconnect: true` → `RECONNECT_REQUIRED`, with no `refresh` call.
    - **Lock timeout:** the raw query rejects with a Prisma error whose message contains `lock timeout` / code `55P03`, giving `CONNECTION_REFRESH_BUSY` with `status: 503`.
    - **Two concurrent calls, one refresh.** The mock serializes the callbacks, and the second call's re-read returns the first call's new tokens. `refresh` is called exactly once.
    - **Deadline:** with 4 s left → `PUBLISH_TIME_BUDGET_EXCEEDED` and `$transaction` is not called.
  - `connectionHealth.test.ts`:
    - with `expected` tokens that differ from the re-read → no `update`, `"superseded"`;
    - equal → `update` with the three flag fields, `"flagged"`.
  - `tiktokClient.test.ts`: an `invalid_grant` while the stored refresh token was already rotated → throws `TOKEN_REFRESH_SUPERSEDED` and never writes `needsReconnect`. The same holds in `googleTokens.test.ts` (access token changed) and `linkedinClient.test.ts`.
  - `connectionHealthSweep.test.ts`:
    - Google with `expiresAt` 8 days ago → eligible; 6 days ago → not;
    - TikTok expiring in 23 h → eligible;
    - X with `expiresAt: null` → not;
    - `proactiveRefreshWhere` matches those rules.
  - `connectionHealthJobs.test.ts`:
    - **Cron paging.** The `findMany` uses `select: { id: true }` only (no token fields) and `take: 1000`. Pages of 1000 and 3 → 2 `sendEvent` arrays with ids `refresh-<id>-2026-11-01` → no third page query. The cron's `opts.singleton` is `{ mode: "skip" }`.
    - **Flagged.** `refreshConnection` with a refresher that flags → the `notify-owners` step emails each owner once.
    - **Transient.** A transient error → no email.
    - **Already flagged.** No refresher call and no email.
    - **Metrics sync.** An expired YouTube token goes through `refreshConnectionToken` (module mock).
- [ ] **Step 2: Confirm the tests fail.** Run `npx vitest run src/server/platforms src/server/jobs/connectionHealthSweep.test.ts src/server/jobs/connectionHealthJobs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In the clients, `ensureFresh*`, YouTube and GBP use `refreshConnectionToken(conn, (c) => refreshX(c, { deadline }), { deadline })`. TikTok keeps writing the refreshed connection back to `ctx.socialConnection`.
- [ ] **Step 4: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `fix(tokens): serialize OAuth refresh per connection and fan out the health sweep`

### Task 9: Media-retention batching

**Files:**
- Modify: `app/prisma/schema.prisma` (MediaItem)
- Create: `app/prisma/migrations/20261102120000_media_retention_keyset_index/migration.sql`
- Create: `app/src/server/jobs/mediaRetentionBatch.ts`
- Test: `app/src/server/jobs/mediaRetentionBatch.test.ts`
- Modify: `app/src/server/jobs/inngest-functions.ts` (`mediaRetentionSweep`)
- Test: update `app/src/server/jobs/mediaRetentionSweep.test.ts`

**Decisions:**
- **Cadence.** The sweep runs hourly at `15 * * * *`. Each run loops up to 15 `sweep-batch-<i>` steps of 200 candidates, and each batch has a 150 s in-step budget (plus at most one 15 s item transaction, which stays under 300 s).
  - Capacity is 3,000/h, about 72,000/day, against about 10,000/day of inflow.
  - The cron gets `singleton: { mode: "skip" }`.
- **Candidate order.**
  - Candidates are keyset-paged on `(createdAt, id)` with `createdAt < cutoff`. Every eligible row satisfies that, because `lastUsedAt >= createdAt`.
  - The new index `@@index([deletedAt, createdAt, id])` serves `deletedAt IS NULL AND createdAt < cutoff ORDER BY createdAt, id`.
  - The cursor keeps a skipped or errored row from being re-selected within a run.
- **The per-item transaction moves verbatim:**
  - the `FOR UPDATE`;
  - the eligibility re-check;
  - the `deletedAt` write;
  - `deleteBlobUnlessShared`, whose guard semantics are unchanged.

**Interfaces:**
- Produces, in `mediaRetentionBatch.ts`:
  - `RETENTION_BATCH_SIZE = 200`, `RETENTION_MAX_BATCHES_PER_RUN = 15`, `RETENTION_BATCH_BUDGET_MS = 150_000`.
  - `type RetentionCursor = { createdAt: string; id: string }`
  - `sweepExpiredMediaBatch(opts: { after: RetentionCursor | null; now?: Date; take?: number; budgetMs?: number; clock?: () => number }): Promise<{ candidates: number; swept: number; skipped: number; errors: number; next: RetentionCursor | null; exhausted: boolean }>`

- [ ] **Step 1: Write the failing tests.**
  - The `findMany` args:
    - the where includes `deletedAt: null`, `createdAt: { lt: cutoff }`, today's `postJobs` some/none filter, and, with `after`, `OR: [{ createdAt: { gt: c } }, { createdAt: c, id: { gt: i } }]`;
    - `orderBy: [{ createdAt: "asc" }, { id: "asc" }]`, `take: 200`, `select: { id: true, createdAt: true }`.
  - **Exhaustion:** 150 rows → `exhausted: true`; 200 rows → `exhausted: false` with `next` set to the last row.
  - **Budget:** a clock past the budget after the 2nd item → 2 items processed, `next` is the 2nd, `exhausted: false`.
  - **Shared blob:** a shared blob → `kept_shared`, and `del` is not called (moved from `mediaRetentionSweep.test.ts`).
  - Handler:
    - batch 0 not exhausted, batch 1 exhausted → exactly 2 `sweep-batch-*` steps;
    - batches that never exhaust → 15 steps;
    - `opts.triggers` (or `cron`) is `15 * * * *`, and `opts.singleton` is `{ mode: "skip" }`.
  - Capacity: `RETENTION_BATCH_SIZE * RETENTION_MAX_BATCHES_PER_RUN * 24 >= 20_000` (twice the reference inflow).
- [ ] **Step 2: Confirm the tests fail.** Run `npx vitest run src/server/jobs/mediaRetentionBatch.test.ts src/server/jobs/mediaRetentionSweep.test.ts`. Expected: FAIL.
- [ ] **Step 3: Add the schema and migration.**
  - Schema: add `@@index([deletedAt, createdAt, id])` to MediaItem, with its comment.
  - `migration.sql`: the header, `SET lock_timeout = '5s';`, then `CREATE INDEX "MediaItem_deletedAt_createdAt_id_idx" ON "MediaItem"("deletedAt", "createdAt", "id");`.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run the TDB check `vs_p2_t9`.** The task's check is `\di "MediaItem_deletedAt_createdAt_id_idx"`. Expected: one row.
- [ ] **Step 6: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 7: Commit.** `perf(media): drain media retention hourly in batched steps`

### Task 10: YouTube metrics by staleness

**Files:**
- Modify: `app/prisma/schema.prisma` (PostJobResult)
- Create: `app/prisma/migrations/20261102130000_youtube_metrics_checked_at/migration.sql`
- Modify: `app/src/server/jobs/metricsScanner.ts`, `app/src/server/platforms/youtubeMetrics.ts`
- Create: `app/src/server/jobs/youtubeMetricsSync.ts`. It holds the page logic and the per-workspace connection resolve moved out of `inngest-functions.ts`.
- Modify: `app/src/server/jobs/inngest-functions.ts` (`youtubePostMetricsSync`)
- Test: `metricsScanner.test.ts`, `youtubeMetrics.test.ts` (extend); `app/src/server/jobs/youtubeMetricsSync.test.ts` (create)

**Decisions:**
- **Ordering.** Results are picked least-recently-**checked** first. That uses a new nullable `PostJobResult.metricsCheckedAt`, stamped on every attempt (found, not found or error). The selector:
  - filters `metricsCheckedAt IS NULL OR < now - 1 h`;
  - orders `metricsCheckedAt ASC NULLS FIRST, createdAt DESC`;
  - is served by `@@index([platform, status, metricsCheckedAt])`.

  `PostMetric.fetchedAt` alone would starve the run: deleted or private videos never get a metric row, so they would sort first forever.
- **Batching and budget.**
  - Ids are grouped per workspace (connection) and sent 50 per `videos.list` call (1 unit; V9; the 50 cap is U4).
  - Each run has a budget of `METRICS_UNITS_PER_RUN = 300` units, so at most 7,200/day out of the shared 10,000 general bucket.
  - A run pages up to 10 × 200 results.
  - A `quotaExceeded` stops the run.
- **Overlap.** The cron gets `singleton: { mode: "skip" }`.
- **Refresh.** The connection refresh uses `refreshConnectionToken` (Task 8).

**Interfaces:**
- Produces, in `metricsScanner.ts`:
  - `METRICS_PAGE_SIZE = 200`, `METRICS_MAX_PAGES_PER_RUN = 10`, `METRICS_UNITS_PER_RUN = 300`, `METRICS_MIN_REFRESH_MS = 3_600_000`, `YOUTUBE_STATS_IDS_PER_CALL = 50`.
  - `selectYouTubeMetricEligibleResults(take?: number, now?: Date): Promise<EligibleMetricResult[]>`
  - `METRICS_SYNC_BATCH` is removed.
- Produces, in `youtubeMetrics.ts`: `fetchYouTubeVideoStatisticsBatch(videoIds: string[], accessToken: string): Promise<{ ok: true; byId: Map<string, { stats: YouTubeStatistics; raw: unknown }> } | { ok: false; code: string; quotaExceeded: boolean }>`. It never throws, and an id absent from `items` is "not found".
- Produces, in `youtubeMetricsSync.ts`: `syncYouTubeMetricsPage(opts: { unitsLeft: number; now?: Date }): Promise<{ attempted: number; updated: number; notFound: number; errors: number; unitsUsed: number; stop: boolean }>`
- Handler steps: `sync-page-<i>`. The loop ends when `attempted === 0`, `stop`, the units are spent, or `i === 10`.

- [ ] **Step 1: Write the failing tests.**
  - **Selector args:** `where` has `platform: "youtube"`, `status: "success"`, `externalPostId: { not: null }`, and `OR: [{ metricsCheckedAt: null }, { metricsCheckedAt: { lt: now - 1h } }]`. `orderBy` is `[{ metricsCheckedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }]`.
  - **Batch fetch:** one request with `id=v1%2Cv2` (or `v1,v2`) whose response holds only `v1` → `byId` has `v1` and `v2` is absent. A 403 `quotaExceeded` → `{ ok: false, quotaExceeded: true }`. A network error → `{ ok: false }`, with no throw.
  - **Page of 120 results** (workspace A with 70, workspace B with 50):
    - 3 calls (50, 20 and 50), `unitsUsed: 3`;
    - one `postJobResult.updateMany({ where: { id: { in: <all 120> } }, data: { metricsCheckedAt: now } })`;
    - one upsert per found video;
    - a found video with all-null stats is not upserted (unchanged rule).
  - **Budget:** `unitsLeft: 2` → 2 calls; only the attempted ids are stamped.
  - **Quota:** `quotaExceeded` → `stop: true`.
  - **Handler:** pages until `attempted === 0`; `opts.singleton` is `{ mode: "skip" }`.
- [ ] **Step 2: Confirm the tests fail.** Run the named files. Expected: FAIL.
- [ ] **Step 3: Add the schema and migration.**
  - Schema: add `metricsCheckedAt DateTime?` and `@@index([platform, status, metricsCheckedAt])`.
  - `migration.sql`: the header, `SET lock_timeout = '5s';`, `ALTER TABLE "PostJobResult" ADD COLUMN "metricsCheckedAt" TIMESTAMP(3);`, then `CREATE INDEX "PostJobResult_platform_status_metricsCheckedAt_idx" ON "PostJobResult"("platform", "status", "metricsCheckedAt");`.
  - The comment in `migration.sql` notes that this is a plain `CREATE INDEX` on today's small table; db-review M9 covers big-table builds later.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run the TDB check `vs_p2_t10`.** The task's check is `\d "PostJobResult"`. Expected: the column and the index are listed.
- [ ] **Step 6: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 7: Commit.** `perf(metrics): refresh YouTube stats by staleness in 50-id batches within a per-run quota`

### Task 11: Notification throttle and retryable delivery

**Files:**
- Modify: `app/src/server/notifications/email.ts`, `app/src/server/notifications/postOutcomeEmail.ts`
- Modify: `app/src/server/jobs/inngest-functions.ts` (`sendNotification`, and `refreshConnection`'s `notify-owners`)
- Test: `email.test.ts`, `postOutcomeEmail.test.ts`, `inngest-functions.test.ts`, `connectionHealthJobs.test.ts`

**Decisions:**
- **Throttle.** `sendNotification` gets `throttle: { limit: 8, period: "1s", burst: 1 }` (V5). That is 8/s against Resend's 10 req/s team limit (V18), leaving 2/s for auth, approval and reconnect mail sent outside Inngest.
- **Retries.** `retries` goes from 1 to 4.
- **Throwing inside the step.** A Resend 429, a 409 `concurrent_idempotent_requests`, a 5xx or a network error now throws inside `deliver-notification`:
  - a 429 or 409-concurrent throws `RetryAfterError(…, 2_000)` (V8);
  - the rest throw `EmailRetryableError`.

  A 4xx rejection is still logged and dropped. `sendEmail` without options keeps its never-throws contract for every other caller.
- **Duplicates.** The existing step-ack pattern stays: the send is the last action of the single memoized `deliver-notification` step, so no later step can re-run it. A retry re-runs that step only when the send threw (nothing was sent) or its ack was lost. Resend's `Idempotency-Key` (V18) makes the lost-ack case a no-op:
  - `post-outcome/<runId>` for outcome emails;
  - `reconnect/<connectionId>/<UTC day>/<ownerUserId>` for reconnect emails.

  A 409 `invalid_idempotent_request` means a send with that key already went out, so it is logged and treated as sent.

**Interfaces:**
- Produces, in `email.ts`:
  - `sendEmail(params: SendEmailParams, opts?: { idempotencyKey?: string; throwOnRetryable?: boolean }): Promise<void>`
  - `class EmailRetryableError extends Error { code = "EMAIL_RETRYABLE" }`
  - `isRetryableEmailError(error: unknown): boolean`. True for `EmailRetryableError` or Inngest `RetryAfterError`.
- Produces, in `postOutcomeEmail.ts`: `deliverPostOutcomeNotification({ userId, postJobId, idempotencyKey }: { userId: string; postJobId: string; idempotencyKey?: string }): Promise<void>`. It rethrows only `isRetryableEmailError`; everything else is swallowed as today.

- [ ] **Step 1: Write the failing tests.**
  - `email.test.ts`, with `throwOnRetryable: true`. The Resend mock resolves to:

    | Resend result | Expected |
    |---|---|
    | `{ error: { statusCode: 429, name: "rate_limit_exceeded" } }` | rejects with `RetryAfterError` |
    | `statusCode: 503` | rejects with `EmailRetryableError` |
    | a thrown network error | rejects with `EmailRetryableError` |
    | `422` | resolves (logged) |
    | 409 `invalid_idempotent_request` | resolves |
    | 409 `concurrent_idempotent_requests` | rejects with `RetryAfterError` |
  - `email.test.ts`, without options: every case resolves (the existing tests stay green). `idempotencyKey: "k"` is passed as `emails.send(payload, { idempotencyKey: "k" })`.
  - `postOutcomeEmail.test.ts`:
    - a send rejecting with `EmailRetryableError` → `deliverPostOutcomeNotification` rejects;
    - a DB error is still swallowed;
    - `sendEmail` receives `{ idempotencyKey: "post-outcome/run-1", throwOnRetryable: true }`.
  - `inngest-functions.test.ts`:
    - `sendNotification` options: `throttle` deep-equals `{ limit: 8, period: "1s", burst: 1 }`, and `retries: 4`;
    - the handler passes `idempotencyKey: "post-outcome/run-1"`;
    - a retryable error makes the `deliver-notification` step reject.
  - `connectionHealthJobs.test.ts`: the owner emails carry `reconnect/conn-1/2026-11-01/<ownerUserId>` and `throwOnRetryable: true`.
- [ ] **Step 2: Confirm the tests fail.** Run the named files. Expected: FAIL.
- [ ] **Step 3: Implement.** In the `notify-owners` step, the owner query selects `user: { select: { id: true, email: true } }`.
- [ ] **Step 4: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `fix(notifications): throttle outcome emails under Resend's limit and retry 429/5xx without duplicates`
