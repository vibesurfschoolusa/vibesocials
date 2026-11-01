# Audit Fixes Implementation Plan (2026-11-01)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Tasks run sequentially on branch `fix/audit-findings` in the worktree `D:\Github_apps\vibesocials\.claude\worktrees\audit-fixes`.

**Goal:** Fix every defect found by the 2026-11-01 full-app audit (live browser reproduction + four code reviews), without regressing anything that works today.

**Spec:** this plan is its own spec. The audit findings it fixes were verified live (L) or in source (S) by the controller; items marked (R) were reported by a reviewer with a concrete code path — the implementer must confirm the code path before fixing, and report "not reproducible" instead of fixing if the claim is wrong.

## Global Constraints

- **Work only inside the worktree** `D:\Github_apps\vibesocials\.claude\worktrees\audit-fixes`. Never touch `D:\Github_apps\vibesocials` (the main checkout). Never open or use `app/.env.local` (it holds a PRODUCTION database credential). Never run anything against a remote database.
- A throwaway Postgres is running for you: `postgresql://postgres:postgres@127.0.0.1:5499/vibesocials_audit` (all current migrations applied) plus an empty `shadow` database on the same server. Always pass it explicitly via `DATABASE_URL=... npx prisma ...`. Use it to generate/verify migrations (`npx prisma migrate dev --create-only` or `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url postgresql://postgres:postgres@127.0.0.1:5499/shadow --script`) and to apply them (`npx prisma migrate deploy`). After a schema change, run `npx prisma generate`.
- **Migrations auto-apply on prod deploy.** Schema changes must be additive or loosening (new nullable/defaulted columns, NOT NULL → NULL, FK cascade → set null). Migration folder name format: `YYYYMMDDHHMMSS_snake_name` with a timestamp later than `20260726120000`. After writing one, verify `migrate diff` (migrations → schema) prints an empty migration.
- **No new `PostJobStatus` enum value.** A held post is `status: draft` + `submittedForApprovalAt != null` (see `app/src/lib/approval.ts`).
- Route handlers read params as `const { x } = await Promise.resolve(context.params);`. Route-test fixtures must pass params as a resolved Promise (PR #41 lesson).
- Owner gates use `requireOwnerContext()` / `getWorkspaceContext({ requireRole: "owner" })` — never a hand-rolled role check for owner-only endpoints.
- `sendEmail` (`app/src/server/notifications/email.ts`) never throws; an email failure must never fail a user request.
- API responses never contain access/refresh tokens (SEC-1 DTOs).
- Tests: Vitest, node environment only, colocated as `app/src/**/*.test.ts` (no jsdom, no React Testing Library). UI logic you change must live in (or be extracted to) a pure function in `app/src/lib/` (or a colocated `*.ts` helper) with table-driven tests. Follow TDD: write the failing test first and record RED/GREEN evidence in your report.
- **Gates before every commit** (run from `app/`): `npx tsc --noEmit` (clean), `npx eslint .` (0 errors; do not add warnings), `npx vitest run` (all pass, pristine output).
- Commits: conventional style `<type>(scope): summary`, one or more per task, each ending with exactly these trailer lines:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QQAL3MCAxjdjfszHxmCZh5
  ```
- Do not modify files outside your task's scope except where strictly needed to compile; list any such file in your report with the reason.

---

### Task 1: Enforce approval on the server

**Problem (L/S):** With `Workspace.requireApproval` on, the hold is only applied at creation (`app/src/app/api/posts/route.ts` ~L497). A member can (a) save a draft, then `POST /api/posts/{id}/publish` → it publishes live (reproduced live), (b) call publish on a *pending* held post → 202 `in_progress` (reproduced live), (c) edit an *approved* scheduled post via `PATCH /api/posts/{id}` and the cron publishes unreviewed text. Also: approving skips the email-verification gate; owners are never told a post is waiting (`buildApprovalRequestedEmail` in `app/src/server/notifications/approvalEmail.ts` is never called); a member cancelling their own held post shows as "rejected"; and `inngest.send` failures after the DB commit leave jobs stuck `in_progress`.

**Files:** `app/src/app/api/posts/[postJobId]/publish/route.ts`, `app/src/app/api/posts/[postJobId]/route.ts` (PATCH), `app/src/app/api/posts/[postJobId]/approval/route.ts`, `app/src/app/api/posts/[postJobId]/cancel/route.ts`, `app/src/app/api/posts/route.ts` (create: owner notification + send-failure handling only), `app/src/lib/approval.ts` (+ test), `app/src/lib/postsDto.ts` (expose `updatedAt`), `app/src/server/notifications/approvalEmail.ts` (or a new sibling module for the owner-notify helper), plus tests.

**Required behavior** (put every decision rule in pure functions in `lib/approval.ts` with table-driven tests; routes call them):

1. Define `needsApproval = workspace.requireApproval && role === "member" && job.approvedAt == null`. Owners are never affected.
2. **Publish route**, when `needsApproval`:
   - Job already pending (`submittedForApprovalAt` set) → `409 { code: "AWAITING_APPROVAL", error: "This post is waiting for an owner's approval." }`. No state change.
   - Otherwise (plain draft, or a `scheduled` job that was never approved) → **submit it for approval instead of publishing**: one atomic conditional `updateMany` that sets `status: "draft"`, `submittedForApprovalAt: now`, `approvedAt: null`, `approvedByUserId: null`, and `scheduledFor` = the validated body `scheduledFor` if given, else keep the job's existing `scheduledFor` for a scheduled job, else `null`. Respond `202 { ok: true, status: "draft", approvalState: "pending", scheduledFor }` and notify owners (item 6). Nothing is dispatched.
3. **PATCH (edit)**, when `requireApproval && role === "member"`:
   - Job `scheduled` (approved or not) → apply the edit AND re-hold it in the same conditional update: `status: "draft"`, `submittedForApprovalAt: now`, `approvedAt: null`, `approvedByUserId: null`, `scheduledFor` kept/updated. Notify owners. Response includes `approvalState: "pending"`.
   - Job pending → apply the edit and set `submittedForApprovalAt: now`.
   - Plain draft → unchanged behavior.
4. **Approval route:**
   - When the approve outcome is `publish_now`, apply `isEmailVerifiedForPublish(owner)` BEFORE any state change (same 403 `EMAIL_VERIFY_REQUIRED` response as the publish route).
   - Accept an optional body field `reviewedUpdatedAt` (ISO string). If present and not equal to the job's current `updatedAt`, return `409 { code: "CHANGED_SINCE_REVIEW", error: "This post changed since you opened it. Review the latest version." }` without deciding. Make the decision update conditional on `updatedAt` too so a concurrent edit can't slip in.
   - Success response contract (Task 2 depends on it): `200 { ok: true, decision: "approve"|"reject", status: "scheduled"|"in_progress"|"cancelled", approvalState: "approved"|"rejected", scheduledFor: string|null }`.
5. **Cancel route:** cancelling a pending held post through `/cancel` (a withdrawal, not an owner rejection) must also clear `submittedForApprovalAt` in the same update so `deriveApprovalState` reports `"none"`, not `"rejected"`.
6. **Owner notification:** whenever a post becomes pending (create-time hold in `POST /api/posts`, publish-route submit, edit re-hold), email every OWNER of the workspace via `buildApprovalRequestedEmail({ submitterName, workspaceName, caption, appBaseUrl: process.env.NEXTAUTH_URL ?? null })` + `sendEmail`. Respect `User.notifyOnPostComplete === false` as an opt-out? **No** — that pref is about outcomes; approval requests always send. Never fail the request on email errors; don't email the submitter.
7. **Dispatch failures:** in `POST /api/posts` (immediate), the publish route, and the approval route (publish_now), wrap `inngest.send`. On failure: mark every still-`pending` result `failed` with `errorCode: "DISPATCH_FAILED"`, `errorMessage: "Couldn't start publishing. Please try again."`, recompute the job status with the existing helper, and return `503 { code: "DISPATCH_FAILED", error: "Couldn't start publishing. Please try again." }` (include `postJobId` in the create route's error body). Put the mark-failed logic in one shared server helper with a test.
8. Add `updatedAt: string` to the post job DTO returned by `GET /api/posts` (update the DTO comment that says there's no UI use — Task 2 uses it for `reviewedUpdatedAt`).

**Tests:** pure-rule tables in `lib/approval.test.ts` covering every branch above (owner unaffected; member draft → submit; member pending → 409; member scheduled-unapproved → submit; member edit approved scheduled → re-hold; cancel pending → none); route-level tests following existing route test patterns in the repo for publish (both bypasses from the problem statement now blocked), approval (email-verify gate, `CHANGED_SINCE_REVIEW`, response contract), and the dispatch-failure helper.

---

### Task 2: Approval and Queue UX

**Depends on Task 1's contracts** (controller will paste the final interfaces into the dispatch).

**Problem (L/S/R):** The Queue shows "Publish now"/Edit to members on non-pending posts with no hint that approval applies; approving a future-dated post removes it from the Queue (`app/src/app/queue/queue-view.tsx` ~L467 calls `removeJob` on every decision); the "Approved, but couldn't publish" 409 leaves stale Approve/Reject buttons; the approve hint says "keeps its scheduled time" even when the time has passed (`approvalOutcome` will publish now); drafts can't be scheduled from the Queue even though the composer's success message says they can (`create-post-form.tsx` ~L788); and the composer's publish confirmation tells a member "This publishes immediately and can't be undone" when their post will actually be held (L).

**Files:** `app/src/app/queue/queue-view.tsx`, `app/src/app/api/posts/route.ts` (GET response only: add `workspaceRequireApproval: boolean` next to `workspaceRole`), `app/src/lib/postsDto.ts` (response type), `app/src/app/posts/new/page.tsx`, `app/src/components/create-post-form.tsx` (confirmation copy only), a pure helper module for queue action/label rules (e.g. `app/src/lib/queueActions.ts` + test).

**Required behavior:**
1. Pure helper decides, per job + viewer (`role`, `requireApproval`), which actions render and their labels. For a member in an approval workspace: on a plain draft the primary action reads **"Submit for approval"** (calls the same publish endpoint; on `202` with `approvalState: "pending"` update the card in place to pending, toast "Sent for approval"); on a scheduled post the Edit dialog shows a one-line notice "Saving changes sends this post back for approval." Owners and non-approval workspaces: unchanged.
2. **Schedule a draft:** the draft Edit dialog gains an optional "Schedule for" date-time (reuse the existing `datetime-local` ↔ UTC helpers used for scheduled posts). Saving with a time calls `POST /api/posts/{id}/publish` with `{ scheduledFor }` after the caption PATCH; for members in approval workspaces the copy says "Submit for approval" and the result is pending. Update the card from the response.
3. **Decisions:** use Task 1's response contract — approve → `status: "scheduled"` updates the card in place (approved, scheduled, stays in list and calendar); `in_progress` → remove + toast "Approved — publishing now"; reject → remove. On `409` (`NOT_PENDING_APPROVAL`, `CHANGED_SINCE_REVIEW`, or a dispatch/prep failure) → toast the server's error and re-fetch the queue. Send `reviewedUpdatedAt: job.updatedAt` with every decision.
4. **Approve hint:** compute with `approvalOutcome(job, new Date(), SCHEDULE_BUFFER_MS)`: "Approving keeps its scheduled time (…)" only when the outcome is `schedule`, else "Its scheduled time has passed — approving publishes it now."
5. **Composer confirmation:** `posts/new/page.tsx` passes `holdsForApproval = context.role === "member" && context.workspace.requireApproval` to `CreatePostForm`; when true, the publish-now confirmation reads title "Submit for approval?", body "An owner will review this post before it publishes to <platforms>.", confirm button "Submit for approval".

**Tests:** table-driven tests for the queue action/label helper and the approve-hint rule.

---

### Task 3: TikTok publishing correctness

**Problem (S, TikTok docs confirmed):** `app/src/server/platforms/tiktokClient.ts` `decidePollOutcome` (~L130) compares against lowercase `"publish_complete"`/`"failed"`, but TikTok returns `PUBLISH_COMPLETE`, `FAILED`, `PROCESSING_UPLOAD`, `PROCESSING_DOWNLOAD`, `SEND_TO_USER_INBOX` (https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status). Every TikTok post therefore times out after 10×3s and is recorded failed (Retry then duplicates it). The unit tests encode the same wrong casing. TikTok access tokens expire after ~24h but the client never refreshes them (no refresh method, so the health sweep in `app/src/server/jobs/inngest-functions.ts` ~L1157 skips TikTok), and a 401 never sets `needsReconnect`.

**Files:** `app/src/server/platforms/tiktokClient.ts` (+ test), `app/src/server/platforms/connectionHealth.ts` (only if a new reconnect code must be registered), `app/src/server/jobs/inngest-functions.ts` (only the health-sweep refresh wiring, if needed), plus any post-job-card retry-eligibility rule if one exists.

**Required behavior:**
1. Normalize the status case-insensitively. `PUBLISH_COMPLETE` and `SEND_TO_USER_INBOX` → complete; `FAILED` → failed (include TikTok's `fail_reason` in the error message when present); anything else → pending. Fix the tests to use TikTok's real values (keep one lowercase case to prove normalization).
2. Poll budget: up to ~120s total (e.g. 24 × 5s). On exhaustion throw code `TIKTOK_PUBLISH_PENDING` with message "TikTok is still processing this video — it may still appear on your account. Check TikTok before retrying." If the codebase has a per-error-code "retryable" rule for the Retry button, mark `TIKTOK_PUBLISH_PENDING` as not auto-retry-suggested there; if not, the message is enough (say which in your report).
3. **Token refresh:** add a TikTok refresh following the existing Google/LinkedIn refresh patterns (look at `googleTokens.ts` and `linkedinClient.ts`): `POST https://open.tiktokapis.com/v2/oauth/token/` (`application/x-www-form-urlencoded`: `client_key`, `client_secret`, `grant_type=refresh_token`, `refresh_token`); response `access_token`, `expires_in`, `refresh_token`, `refresh_expires_in`. Verify field names against https://developers.tiktok.com/doc/oauth-user-access-token-management before coding. Refresh before publishing when `expiresAt` is null-safe-past or within 5 minutes, persist via `prisma.socialConnection.update` (the `db.ts` extension encrypts), and expose it so the connection health sweep refreshes TikTok like the others. Terminal refresh failure (HTTP 400/401, or `error` = `invalid_grant`-style) → mark `needsReconnect` via the existing connection-health helper; 429/5xx/network → throw a transient error WITHOUT flagging.
4. A 401 from any TikTok API call during publish maps to a reconnect-required code that the existing connection-health machinery recognizes (follow how `FACEBOOK_PAGE_RECONNECT_REQUIRED` works), so the connection is flagged and the user sees "reconnect" copy.

**Tests:** poll-outcome table with real values; refresh success persists new tokens + expiry; terminal vs transient refresh failure (flag vs no flag); 401 → reconnect code. Mock `fetch` the way existing client tests do.

---

### Task 4: Publish pipeline reliability

**Files:** `app/src/server/jobs/inngest-functions.ts`, `app/src/server/jobs/posting.ts`, `app/src/server/jobs/scheduledScanner.ts`, `app/src/server/jobs/stalePostJobs.ts` (if needed), `app/src/server/platforms/transientRetry.ts`, `app/src/server/platforms/googleTokens.ts`, `app/src/server/platforms/linkedinClient.ts`, `app/src/server/platforms/instagramClient.ts`, `app/src/server/platforms/youtubeClient.ts`, `app/src/server/platforms/xClient.ts`, and their tests.

**Required behavior:**
1. **Caption source (S):** retry (`inngest-functions.ts` ~L639) rebuilds the caption from `mediaItem.baseCaption`/`perPlatformOverrides`, ignoring the job's own caption; immediate jobs never snapshot their caption on the job (`buildPostJobCreateData` in `posting.ts` ~L292 gates `baseCaption`/`perPlatformOverrides` on `isDeferred`); YouTube's title uses `mediaItem.baseCaption` (`youtubeClient.ts` ~L134). Fix: every job (all intents) snapshots `baseCaption` + `perPlatformOverrides`; retry and YouTube title use job-first precedence `job.baseCaption ?? mediaItem.baseCaption` (same as `prepareDeferredPostJobDispatch`). Keep `scheduledFor` gating as is.
2. **Refresh failure classification (S):** `googleTokens.ts` (~L87-114) flags `needsReconnect` on ANY non-2xx; `linkedinClient.ts` (~L174-184) on any refresh failure. Flag only terminal auth failures (HTTP 400/401, e.g. `invalid_grant`); 429/5xx/network → throw a transient error without flagging.
3. **Instagram (R):** treat Graph API `OAuthException` / `error.code === 190` (any HTTP status, usually 400) as reconnect-required, matching `facebookPageClient.ts` (~L35). Reuse/share that detection rather than duplicating it.
4. **In-step retry duplicates (R):** `transientRetry.ts` (~L84) retries every `TypeError` (Node fetch's "fetch failed"), which can re-publish after a platform already accepted a create call. Only retry network errors whose `cause.code` proves the connection was never established: `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `EHOSTUNREACH`, `UND_ERR_CONNECT_TIMEOUT`. Keep HTTP-status based transient retries as they are.
5. **Scheduled claim (S):** `scheduledScanner.ts` (~L51) claims due rows one by one inside one step; a mid-loop error + step retry strands already-claimed rows. Claim atomically in ONE statement that returns the claimed ids (e.g. `$queryRaw` `UPDATE "PostJob" SET status = 'in_progress'::"PostJobStatus", "updatedAt" = now() WHERE id IN (SELECT id FROM "PostJob" WHERE status = 'scheduled' AND "scheduledFor" <= $now ORDER BY "scheduledFor" LIMIT $take FOR UPDATE SKIP LOCKED) RETURNING id`). Verify the SQL against the throwaway DB.
6. **Heartbeat (R):** stale sweep and reconcile key off `PostJob.updatedAt`, but platform steps only write `PostJobResult`. Bump the job's `updatedAt` whenever a result row is finalized (success or failure) so an active-but-slow run is never swept as stalled.
7. **Interrupted runs (R):** both publish functions are `retries: 0`; if a step is killed (300s Vercel limit) remaining platforms are never attempted and the job looks "publishing" for ~2h. Add an Inngest `onFailure` handler to `publishToAllPlatforms` and `retryPlatforms` that marks that job's still-`pending` results `failed` with `errorCode: "PUBLISH_INTERRUPTED"`, `errorMessage: "Publishing was interrupted. Please retry."`, and recomputes the job status. Also bound X media-processing polling (`xClient.ts` ~L319) so a single X step's worst case (download + upload + polling + in-step retries) stays under ~240s; document the arithmetic in a comment.

**Tests:** for each item (pure helpers where possible; mock Prisma/fetch the way existing tests do). For item 5 run the raw SQL against the throwaway DB once and paste the result in your report.

---

### Task 5: Keep publish history when a connection is removed

**Problem (S):** `PostJobResult.socialConnection` is `onDelete: Cascade` (`app/prisma/schema.prisma` ~L315), so "Disconnect" and "Switch account" (`app/src/app/api/connections/[platform]/route.ts` ~L99 `deleteMany`) silently delete every past result for that platform — Activity and Publish health lose history.

**Files:** `app/prisma/schema.prisma`, a new migration, every reader of `PostJobResult.socialConnectionId` / `.socialConnection` (currently: `app/src/app/api/insights/publish-health/route.ts`, `app/src/app/api/posts/route.ts`, `app/src/app/api/posts/[postJobId]/route.ts`, `app/src/lib/postsDto.ts`, `app/src/server/jobs/inngest-functions.ts`, `app/src/server/jobs/posting.ts`, `app/src/server/platforms/googleBusinessProfileClient.ts`, `app/src/server/platforms/types.ts`), plus tests.

**Required behavior:** make `socialConnectionId` nullable with `onDelete: SetNull` (migration: drop NOT NULL, recreate the FK with `ON DELETE SET NULL`). Every reader handles `null`. Retry of a result whose connection is gone uses the workspace's CURRENT connection for that platform if one exists (and repoints the result to it); if none, the retry marks that result failed with a clear "not connected" code/message instead of throwing. Publish health and Activity keep showing historical results after a disconnect. The disconnect confirmation copy stays accurate (check it doesn't promise deletion of history).

**Tests:** retry with null/removed connection (reconnected vs not); DTO/health with null connection ids. Verify the migration with `migrate diff` (empty) and `migrate deploy` on the throwaway DB.

---

### Task 6: Bind platform OAuth callbacks to the signed-in user

**Problem (S):** none of the 7 callbacks (`app/src/app/api/auth/{tiktok,youtube,google_business_profile,instagram,facebook_page,linkedin,x}/callback/route.ts`) reads the session; identity comes only from the HMAC `state` (or X's `OAuthHandshake` row). An attacker can start a connect flow in their own account, send the provider authorize URL to a victim, and the victim's approval connects the victim's social account to the attacker's workspace. Also (R): YouTube's callback makes the token exchange/JSON parse/channel fetch outside any try (network/parse failure → 500), DB errors in every callback → 500, and the YouTube/Instagram/Facebook start routes return a raw JSON 500 when unconfigured while TikTok/GBP redirect.

**Files:** a new shared helper (e.g. `app/src/lib/oauthCallbackGuard.ts` + test), all 7 callback routes, the 3 start routes, `app/src/lib/oauthResult.ts` (user-facing error copy for new codes) + tests.

**Required behavior:**
1. Shared helper: given the user id carried by the verified state (or handshake row), load the current user via `getCurrentUser()` (which enforces `sessionVersion`). No session → redirect to `/login?callbackUrl=%2Fsettings`. Session user ≠ state user → redirect to `/settings?error=oauth_session_mismatch` and DO NOT exchange the code or write anything. Only then proceed. Run this check BEFORE the code exchange in every callback. Existing owner re-checks stay.
2. Add user-facing copy for `oauth_session_mismatch` ("That connection was started from a different account. Sign in to the account you want to connect and try again.") and for any new `<platform>_not_configured` / `<platform>_connect_failed` codes, following `oauthResult.ts` conventions.
3. Every callback: unexpected errors (network, JSON parse, DB, handshake lookup) redirect to `/settings?error=<platform>_connect_failed` instead of a 500, logging via the existing logger (never logging tokens).
4. YouTube/Instagram/Facebook start routes: when unconfigured, redirect to `/settings?error=<platform>_not_configured` like TikTok/GBP.

**Tests:** helper unit tests (no session / mismatch / match); at least one callback route test per pattern (state-based and X handshake) proving a mismatched session never writes a connection.

---

### Task 7: Account security and auth fixes

**Files:** new `app/src/lib/safeRedirect.ts` (+ test), `app/src/app/login/page.tsx`, `app/src/app/register/page.tsx`, any other consumer of `callbackUrl` (grep), `app/src/lib/auth.ts`, `app/src/lib/googleSso.ts` (+ test), `app/prisma/schema.prisma` + migrations, `app/src/lib/accountEmails.ts`, `app/src/server/notifications/email.ts`, `app/src/app/forgot-password/forgot-password-form.tsx`, `app/src/middleware.ts` → `app/src/proxy.ts`, plus tests.

**Required behavior:**
1. **Open redirect (L):** `/login?callbackUrl=/%5Cexample.com` sent the browser to example.com after sign-in (`login/page.tsx` ~L22/L50; same check in `register/page.tsx` ~L22/L65). Add `safeCallbackPath(raw, fallback = "/")`: accept only same-origin relative paths — must start with a single `/`, contain no backslash, no ASCII control characters or whitespace, and `new URL(raw, "http://internal.invalid")` must keep origin `http://internal.invalid`; return `pathname + search + hash`, else `fallback`. Table tests including `/\evil.com`, `/\t/evil.com`, `//evil.com`, `/%5Cevil.com` (raw), `https://evil.com`, `javascript:alert(1)`, `/queue?x=1#y` (allowed), `/join/abc` (allowed). Use it everywhere a callbackUrl is followed client-side.
2. **Register → Log in link (R):** `register/page.tsx` (~L176) drops `callbackUrl`; preserve it (sanitized) so `/join/<token>` → register → "Log in" returns to the join page.
3. **Login hardening (R):** in `auth.ts` `authorize`: (a) when the user is missing or has no password, still run `bcrypt.compare` against a fixed dummy hash so timing doesn't reveal which emails exist; (b) change the per-email limit key to per (email, IP) with the existing 10/15min fail-closed limit, keep the per-IP limit, and add a per-email backstop of 100 attempts/hour (fail-closed) so one IP can no longer lock a victim out.
4. **Google SSO linking (R):** add nullable `User.googleLinkedAt DateTime?` (migration). Rules in a pure function with tests: new user → create with `googleLinkedAt = now`; existing with `googleLinkedAt` → allow; existing without it and no `passwordHash` → allow and set `googleLinkedAt` (and `emailVerifiedAt` if null); existing without it but WITH a `passwordHash` → refuse (return null). Make sure the login page shows "This email already has a password. Sign in with your password instead." for that refusal (find how the current refusal surfaces and map it).
5. **Silent email failures (R):** Resend 6.x returns `{ data, error }` instead of throwing. In `accountEmails.ts` (~L137-144) and `server/notifications/email.ts`, check `error`: log it via the logger (no secrets, no recipient address in plain text beyond what existing logs do) and report failure to the caller where the caller already handles a boolean/result; never throw and never change user-facing anti-enumeration responses.
6. **Forgot password (R):** `forgot-password-form.tsx` ignores the response status. 429 → show "Too many requests. Please wait a few minutes and try again."; other non-2xx → "Something went wrong. Please try again."; 2xx keeps the uniform confirmation.
7. **Legacy mixed-case emails (R):** accounts registered before PR #21 may store `Alice@Example.com`, so normalized login/forgot lookups miss them. Add a data migration that sets `email = lower(trim(email))` only for rows where it differs AND no other row has the same normalized value (so it can never violate the unique index); trim must match JS `String.prototype.trim()` semantics for ordinary whitespace (`regexp_replace(email, '^\s+|\s+$', '', 'g')`). Test the SQL on the throwaway DB with seeded conflicting/non-conflicting rows and paste the result in your report.
8. **Next 16 deprecation:** rename `app/src/middleware.ts` → `app/src/proxy.ts` per Next 16's "proxy" convention (keep the exact auth behavior and matcher). Verify with a production build: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5499/vibesocials_audit NEXTAUTH_SECRET=x npm run build` shows no middleware deprecation warning and the proxy is listed.

**Tests:** as listed per item.

---

### Task 8: API input and data-safety hardening

**Files:** `app/src/app/api/media/[id]/route.ts`, `app/src/app/api/media/route.ts`, `app/src/app/api/posts/route.ts` (blobUrl-path field validation only), `app/src/app/api/posts/[postJobId]/route.ts`, `app/src/app/api/workspaces/switch/route.ts`, `app/src/app/api/workspaces/active/route.ts`, `app/src/app/api/upload/route.ts`, other routes that read `request.json()` then index it, `app/src/app/api/workspaces/members/[userId]/route.ts`, `app/src/components/team-section.tsx`, a small shared JSON helper (e.g. `app/src/lib/http.ts` + test).

**Required behavior:**
1. **Shared blob deletion (R):** `DELETE /api/media/[id]` calls `del(item.storageLocation)` even when other `MediaItem` rows (in any workspace) reference the same URL, so a member can destroy a teammate's file by re-adding its URL elsewhere and deleting it. Only delete the blob when no other non-purged `MediaItem` references the same `storageLocation`; still soft/hard delete this row as today.
2. **Malformed bodies (R):** a JSON body of `null`, an array, or a primitive currently crashes several routes with a TypeError → 500. Add `readJsonObject(request)` (returns a plain object or `null` for invalid/non-object JSON) and use it in every API route that parses JSON and then reads properties; invalid → `400 { error: "Invalid JSON body" }`. `upload/route.ts` (~L36) parses JSON outside its try — fix.
3. **Create-post media fields (R):** `POST /api/posts` passes `sizeBytes`, `mimeType`, `filename` through unchecked (~L570). Validate: `sizeBytes` optional non-negative safe integer (else 400); `mimeType` required to be `image/*` or `video/*` using the same rule `POST /api/media` applies (reuse it); `filename` optional string ≤ 255 chars.
4. **Removed members rejoin (R):** removing a member doesn't invalidate the workspace's invite link (7-day, unlimited use), so they can rejoin immediately. When an owner removes a member, revoke the workspace's active invite links in the same transaction; return `invitesRevoked: number`; `team-section.tsx` clears its displayed invite link when `invitesRevoked > 0` and tells the owner "Invite link reset — create a new one to invite more people."

**Tests:** `readJsonObject` table; media delete with shared/unshared URL; create-post field validation; member removal revokes invites.

---

### Task 9: Frontend fixes

**Files:** `app/src/components/shell/account-menu.tsx`, `app/src/components/activity/post-job-card.tsx`, `app/src/hooks/usePostJobs.ts`, `app/src/components/create-post-form.tsx`, `app/src/lib/composerGate.ts`, `app/src/lib/platformLimits.ts` (+ test), `app/src/app/api/posts/route.ts` and/or `app/src/server/jobs/posting.ts` (server-side media/platform + TikTok privacy validation only), `app/src/components/queue/queue-calendar.tsx` (or wherever the calendar lives), `app/src/components/location-autocomplete.tsx`, files with the 9 current eslint warnings.

**Required behavior:**
1. **Workspace switch (L):** after a successful switch the page kept showing the previous workspace's data and actions 404'd (`account-menu.tsx` ~L114 only calls `router.refresh()`). After a successful switch, do a full navigation to the current path (`window.location.assign(window.location.pathname + window.location.search)`) so every client-fetched view reloads for the new workspace.
2. **Retry spinner (L):** after "Retry <platform>" succeeds, the card stayed "Retrying…" forever although the server finished in ~1s (`post-job-card.tsx` ~L152-163 sets local pending; `usePostJobs.ts` ~L180-186 only polls when fetched data shows work in progress). After a successful retry request, refetch and keep polling until the job is terminal; clear the local pending state from server data. Extract the should-poll decision into a pure function with tests.
3. **Composer re-pick (L):** after a successful post the file input still shows the old filename and the "Uploading… 100%" bar lingers, and choosing the same file again fires no change event ("Please choose a file to upload."). Reset the input via a `key` (as `media-library.tsx` does with `fileInputKey`) and clear upload progress on reset.
4. **Media-type compatibility (R):** the composer pre-selects every connected platform regardless of media type. Add a pure `platformAcceptsMedia(platform, mimeType)` in `lib/platformLimits.ts`, with each platform's rule taken from its client code (e.g. YouTube video-only, TikTok video-only, Facebook Page images-only per `facebookPageClient.ts` ~L66; check Instagram, X, LinkedIn, Google Business Profile in their clients and cite them in comments). Composer: incompatible platforms render disabled with a short reason and are deselected when media is chosen. Server: `POST /api/posts` returns 400 naming any explicitly requested incompatible platform; when no explicit list is sent, incompatible connected platforms are skipped (no result rows).
5. **Connections load failure (R):** when `GET /api/connections` fails the composer shows a form with no platforms and every submit fails with "Select at least one platform". Show an error alert with a Retry button instead (extend the `composerGate.ts` state).
6. **TikTok privacy (R):** the privacy level is only required for "Publish now" (`create-post-form.tsx` ~L655); scheduled/draft TikTok posts silently go out as `SELF_ONLY`. Require an explicit privacy level whenever TikTok is a selected target, for every intent, in the composer AND in `POST /api/posts` (400 when TikTok is targeted without a string `privacyLevel`).
7. **Instagram caption limit (R):** verify the 2,200-character Instagram caption limit is enforced/warned like the other platforms' limits; add it to `platformLimits.ts` if missing.
8. **Calendar drag in Firefox (R):** the draggable chip never calls `dataTransfer.setData`; set `text/plain` to the job id in `dragstart`.
9. **Location dropdown (R):** selecting a suggestion rewrites the field, which triggers a new lookup and reopens the dropdown ~300ms later. Suppress the lookup for the value written by a selection.
10. **Lint warnings:** fix the 9 existing `@typescript-eslint/no-unused-vars` warnings so `npx eslint .` reports 0 problems.

**Tests:** should-poll helper, `platformAcceptsMedia` table, composer gate states, server validation for items 4 and 6.
