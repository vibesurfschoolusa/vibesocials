# Scale Readiness, Phase 3 (Large Uploads, Multi-Step Publishing, Publish Health and Carried Fixes), Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the scale-readiness pass for the publish pipeline. That means:
- a 512 MB video publishes to YouTube, X, TikTok and LinkedIn with at most about 64 MB per request in memory, across as many steps as it needs;
- Instagram waits for its container the way Meta recommends (a check a minute, up to 5 minutes) without holding a step;
- publish-health costs one index range per dashboard load and counts exactly;
- the carried phase 2 rulings (R15, R22, R24, R30, R31) and the selected deferred minors are closed.

**Architecture:**
- **Continuation steps.** A platform step may end with `continue` instead of a final outcome. The run then calls the same platform again in a new step, `publish-to-<p>-c<n>`, optionally after a durable `step.sleepUntil`. Between steps the result is `pending`, holds **no claim**, and keeps its progress in a new nullable `PostJobResult.uploadState` JSON column. Capability URLs in it are sealed with `sealSecret`. Only the step that sends the commit call holds the claim across it.
- **Streamed large uploads.** Above 50 MiB, the four buffering clients read the blob with one open-ended `Range` request per step and send it in chunks:
  - YouTube: the resumable protocol.
  - TikTok: FILE_UPLOAD chunks.
  - X: the v1.1 chunked APPEND the code already uses.
  - LinkedIn: Assets API `MULTIPART_UPLOAD`.
- **Smaller files.** Below the threshold, files keep today's path.
- **Publish health.** `PostJobResult.workspaceId` is denormalized, backfilled and indexed. Publish-health becomes a `groupBy` on `(workspaceId, updatedAt)`.
- **Migrations.** Three additive migrations; one of them is the backfill.

**Tech Stack:** Next.js 16, Prisma 6 / Postgres (Neon), Inngest SDK 3.54.2, Vercel Blob (`@vercel/blob` 2.8.2), Resend SDK 6.17.2, Vitest 4 (node environment).

**Spec:** the scale-audit reports. They live outside the repo, in the session scratchpad. Read only the section a task cites.
- `C:\Users\Klaus\AppData\Local\Temp\claude\D--Github-apps-vibesocials\16b837d3-1900-4523-b5f8-78ef6e348c80\scratchpad\audit2\jobs-review.md`: B3, M3, L5, "Per-platform limits".
- `...\audit2\db-review.md`: M5, M9.
- `...\audit2\web-review.md`: W7, W16.
- `...\audit2\correctness-review.md`: L1. L4 is already fixed: phase 2 F10 added the recompute at `app/src/app/api/posts/[postJobId]/retry/route.ts:316`.
- Rulings and deferred minors: `...\audit2\phase2-ledger.md` (R15, R22, R24, R30, R31; Task 5, 8, 9 and 11 minors) and `...\audit2\phase1-ledger.md` (Task 9 whole-branch minor).

Out of scope, by decision:
- jobs H7 (the X URL footer);
- jobs M8 (X v1.1 → v2): the large X path keeps `upload.twitter.com/1.1/media/upload.json`;
- the LinkedIn Videos API / Posts API migration: the large LinkedIn path keeps the `/v2/assets` + `/v2/ugcPosts` pair the code uses today;
- the region pin, the pooled DB URL and the YouTube quota extension, which are user-owned vendor settings;
- R18 (the zombie-attempt race), accepted as is;
- a `vercel.json` memory override.

## Global Constraints

- **Env files.** Never open `app/.env.local` or any `.env*` except `app/.env.example`. The worktree has no `.env.local`; keep it that way.
- **Databases.** Never connect to production. All database work uses the throwaway docker container `vibesocials-scale-pg` on `127.0.0.1:5499` (user `postgres`, password `postgres`).
  - Create your own fresh database in it and drop it when done.
  - Never touch the `vibesocials_scale` database or the other containers (`vibe-gc-test`, `lightning-postgres`).
- **Branch.** Commit on branch `fix/scale-phase3` only, in worktree `D:\Github_apps\vibesocials\.claude\worktrees\scale-phase3`. Never push.
- **Gates.** Run these in `app/` after every task. They must stay green:
  - `npx tsc --noEmit`: 0 errors;
  - `npx eslint .`: 0 problems;
  - `npx vitest run`: all pass.
- **Error JSON.** Error JSON keeps the existing `{ error: string, code?: string }` shape. New codes are listed per task.
- **Comments.** New code comments cite the audit the way phases 1 and 2 did, e.g. `// 2026-11-01 scale audit (jobs B3): ...`. Rulings are not cited by number in code (phase 2 minor).
- **Vendor values.**
  - Every vendor limit lives in a named constant with its source URL in a comment. The sources are in the Vendor facts table below.
  - A value marked *unconfirmed* in that table gets the word "unconfirmed" in its comment.
- **Tests.**
  - Vitest node environment only: `src/**/*.test.ts`. There is no jsdom, so UI logic is tested through pure helpers.
  - Mock `fetch` / `@/lib/fetchWithTimeout`, `@/lib/db` and the Inngest step tools, following the patterns in `inngest-functions.test.ts` (`fakeStep`, `handlerOf`), `platformSteps.test.ts` and the platform client tests.
  - Never call a real platform API, Vercel Blob, Resend, Inngest or a database.
  - Large-file tests use lazily generated `ReadableStream`s. Never allocate a real 512 MB buffer.
- **Inngest ids are a contract with in-flight runs.**
  - Never rename a function id.
  - Never rename an existing step id. That includes `fetch-data`, `publish-to-<p>`, `retry-<p>`, `<id>-rl<n>`, `<id>-wait-rl<n>`, `finalize-job`, `finalize-retry`, `notify-outcome`, `fetch-retry-data`, `fail-media-unavailable`, `mark-failed-no-connections`, `claim-due-jobs`, `reconcile-stuck-in-progress`, `materialize-dispatch-batch-<i>`, `notify-noconn-batch-<i>`, `fail-stale-post-jobs`, `sweep-batch-<i>`, `sync-page-<i>`, `start`, `page-<i>`, `fan-out-<i>`, `refresh`, `notify-owners` and `deliver-notification`.
  - New step ids are additive and deterministic: no timestamps or random values. The new ids are `<id>-c<n>`, `<id>-wait-c<n>`, `heal-result-workspace` and `notify-day`.
- **Secrets.**
  - Step outputs never contain OAuth tokens, email addresses or **capability URLs**: the YouTube session URI, the TikTok `upload_url`, LinkedIn part URLs and the multipart `metadata`.
  - Capability URLs are not logged either. They are stored only sealed (`sealSecret`, `app/src/lib/tokenCrypto.ts`).
- **Memory.** No platform request in flight holds more than about 64 MB of media plus its encoding.
- **Migrations.**
  - **Additive only:** nullable columns, new indexes, and an idempotent backfill.
  - **Index names:** Prisma default naming (`<Model>_<cols>_idx`), so `prisma migrate diff` shows no drift.
  - **Header:** each `migration.sql` starts with a comment and `SET lock_timeout = '5s';` (db-review M9, ruling R14).
  - **Names:** `20261103HHMMSS_<name>`, which sort after phase 2's `20261102130000`.
  - **Where they run:** in the Vercel production build, through `scripts/migrate-on-vercel-prod.mjs` (via `DIRECT_URL`), while the old deployment is still serving traffic. So they must work with the old code.
  - **`updatedAt`:** no migration or runtime backfill may move `PostJobResult.updatedAt` of a finished row. Publish-health reads it as the finish time (ruling R26). Backfills are raw SQL that never sets it.
- **Throwaway-DB check ("TDB check <db>").** Run in `app/` (Git Bash):
  1. `docker start vibesocials-scale-pg`
  2. `docker exec vibesocials-scale-pg createdb -U postgres <db>`
  3. `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5499/<db> npx prisma migrate deploy`. Expected: every migration applies, including the new one.
  4. `npx prisma migrate diff --from-url postgresql://postgres:postgres@127.0.0.1:5499/<db> --to-schema-datamodel prisma/schema.prisma --exit-code`. Expected: `No difference detected.`, exit 0.
  5. The task's own `psql` check: `docker exec vibesocials-scale-pg psql -U postgres -d <db> -c '<sql>'`.
  6. `docker exec vibesocials-scale-pg dropdb -U postgres <db>`
- **New env vars** go in `app/.env.example` with a one-line comment. Code reads them through a parser that falls back to the default on a missing or invalid value.

## Vendor facts (checked 2026-11-02)

V1–V20 are phase 2's table (`docs/superpowers/plans/2026-11-01-scale-phase2.md`) and keep their numbers. V3 (`sleepUntil` frees the concurrency slot), V7 (1,000 steps/run, 4 MiB step output) and V8 (step retries, memoized steps) are relied on again here.

| # | Fact the plan relies on | Source |
|---|---|---|
| V21 | **YouTube resumable upload.** Start with `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=…` with `Authorization`, `Content-Type: application/json; charset=UTF-8`, `X-Upload-Content-Length` and `X-Upload-Content-Type`, and the video resource as the body. The answer is 200 with the session URI in `Location`. Chunks are PUT with `Content-Range: bytes FIRST-LAST/TOTAL`. "The chunk size must be a multiple of 256 KB", except the last chunk. A non-final chunk answers 308 with `Range: 0-N`; the header is absent when nothing was received. The final chunk answers 201 with the created video resource. **Status:** an empty PUT with `Content-Range: bytes */TOTAL` answers 308 (incomplete, see `Range`), 200/201 (complete, the same response as at completion) or 404 (session expired: start over). Resume after 500/502/503/504 or a lost connection; other 4xx/5xx are permanent. `Authorization` is required on the PUTs. A session URI "has a finite lifetime" (no number given). | https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol |
| V22 | **TikTok FILE_UPLOAD.** Each chunk is 5–64 MB. The final chunk may be up to 128 MB. `total_chunk_count` = floor(size / chunk_size), from 1 to 1,000. "File chunks must be uploaded sequentially." PUT headers: `Content-Type`, `Content-Length`, `Content-Range: bytes FIRST-LAST/TOTAL`. Answers: 206 (more chunks remain); 201 ("all parts uploaded", TikTok starts posting); 403 (`upload_url` expired); 404 (no upload task); 416 (the range does not match progress; the answer carries `Content-Range: bytes 0-{UPLOADED_BYTES}/{TOTAL}`); 5xx ("retry submitting this chunk"). | https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide |
| V23 | TikTok: "The upload_url is valid for one hour after issuance." `video/init` is limited to 6 requests/min per user token. | https://developers.tiktok.com/doc/content-posting-api-reference-direct-post |
| V24 | **X chunked media (current docs, v2 paths).** Segments of at most 5 MB are recommended; the server maximum is 8 MB. Segments are indexed from 0. "Failed chunks can be retried individually." INIT and FINALIZE examples return `expires_after_secs: 86400`. `processing_info.state` is `pending`, `in_progress`, `succeeded` or `failed`, with `check_after_secs`. | https://docs.x.com/x-api/media/quickstart/media-upload-chunked |
| V25 | **LinkedIn Assets API, multipart.** Register with `supportedUploadMechanism: ["MULTIPART_UPLOAD"]` and `fileSize`. Over 200 MB multipart is required; under it either mechanism is allowed ("either SINGLE_REQUEST_UPLOAD or MULTIPART_UPLOAD otherwise"). The answer is `uploadMechanism["com.linkedin.digitalmedia.uploading.MultipartUpload"].partUploadRequests[]`, each `{ url, byteRange: { firstByte, lastByte }, headers, urlExpiresAt }`, plus `metadata`, `asset` and `mediaArtifact`. The example parts are 4 MiB. A video upload PUT "shouldn't include an OAuth token". Each part's answer carries an `ETag` header. Complete with `assets?action=completeMultiPartUpload`, body `{ completeMultipartUploadRequest: { mediaArtifact, metadata, partUploadResponses: [{ headers: { ETag }, httpStatusCode }] } }`. Check status with `GET assets/{id}`: `recipes[].status` is one of NEW, PROCESSING, AVAILABLE, WAITING_UPLOAD, CLIENT_ERROR, SERVER_ERROR, INCOMPLETE. The page documents `/rest/assets` with `Linkedin-Version`, and states that the Videos API replaces the Assets API for videos. | https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/vector-asset-api |
| V26 | LinkedIn `POST /v2/ugcPosts`: "The UGC Post is created with a 201 Created response and the response header x-restli-id contains the ugcPost ID." | https://learn.microsoft.com/en-us/linkedin/compliance/integrations/shares/ugc-post-api |
| V27 | Instagram container `status_code`: EXPIRED ("not published within 24 hours"), ERROR, FINISHED, IN_PROGRESS, PUBLISHED. "We recommend querying a container's status once per minute, for no more than 5 minutes." | https://developers.facebook.com/docs/instagram-platform/content-publishing |
| V28 | Resend 429 types: `rate_limit_exceeded` (per second); `daily_quota_exceeded`, which "reset[s] at midnight UTC"; `monthly_quota_exceeded`, whose fix is a larger plan. | https://resend.com/docs/api-reference/errors |
| V29 | `@vercel/blob` 2.8.2: `del(urlOrPathname, options?: DeleteCommandOptions)`, where `BlobCommandOptions.abortSignal` is an "`AbortSignal` to cancel the running request". | `app/node_modules/@vercel/blob/dist/create-folder-BM6BTlko.d.ts:22-25`, `.../dist/index.d.ts:62,78` |
| V30 | Vercel Blob public blobs are served from the CDN and stored on S3. Range support is not stated (see U8). Functions default to 2 GB / 1 vCPU, and Fluid compute shares an instance between invocations (as cited by jobs B3). | https://vercel.com/docs/vercel-blob, https://vercel.com/docs/functions/limitations, https://vercel.com/docs/fluid-compute |

**Unconfirmed.** Each design below fails safe if the guess is wrong.
- **U8:** whether Vercel Blob honors `Range` with 206. The chunk stream accepts a 206 whose `Content-Range` starts at the requested offset, or a 200, in which case it reads and discards the prefix. Anything else fails before any upload. There is one request per step either way.
- **U9:** the YouTube session URI lifetime, and whether quota is charged at session start or at completion. A 404 on the status query restarts the session. Our daily counter is spent once per session; Google's own 403 is still classified (V10).
- **U10:** the X **v1.1** APPEND details. developer.x.com answers HTTP 402 to fetches, so the v1.1 limits can't be confirmed: ≤ 5 MB per segment, `segment_index` 0–999, a segment may be re-sent, and `expires_after_secs` on INIT. The design keeps today's 5 MB base64 segments, which work in production. It re-INITs when the media is about to expire (3,600 s when the field is absent) and retries a failed segment once in the next step before failing `X_VIDEO_APPEND_FAILED`. Nothing is tweeted before the tweet call.
- **U11:** whether `/v2/assets?action=completeMultiPartUpload` and `GET /v2/assets/{id}` behave like the documented `/rest/assets` calls, and whether `MULTIPART_UPLOAD` is accepted for 50–200 MB. A failure there fails `LINKEDIN_VIDEO_UPLOAD_FAILED` before any post, and `LARGE_UPLOAD_PLATFORMS` (Task 9) turns the path off per platform.
- **U12:** what `media_publish` does on a container that is already PUBLISHED. A PUBLISHED status seen before our own publish call is reported as `PUBLISH_UNCONFIRMED`.
- **U13:** whether TikTok's 416 `UPLOADED_BYTES` is a count or a last-byte index. The resync accepts either reading only when it lands on a chunk boundary. Otherwise it fails `TIKTOK_UPLOAD_FAILED`, before the final chunk.
- **U14:** whether Prisma runs a migration file inside one transaction (db-review "Unconfirmed items"). The backfill is its own idempotent file, so a failed backfill leaves the column migration applied and is safe to re-run.

## Review Focus

1. **Claims across continuation steps.**
   - A claim is held only inside one step. Every `continue` releases it in the same write that bumps the heartbeat.
   - The commit call and the work after it (TikTok's status poll, the result write) run in one claimed step. They never cross a step boundary.
   - A continuation step that finds its own claim still treats it as `held_by_this_run` → `PUBLISH_UNCONFIRMED`, unchanged. This is conservative, but nothing was posted.

   Pinned in Task 7 and in each upload task.
2. **No capability URL leaks.** The YouTube session URI, TikTok `upload_url`, LinkedIn part URLs and `metadata` never appear in step outputs, logs, events or unsealed columns. Pinned in Tasks 7, 10, 11 and 13.
3. **One YouTube quota slot per upload session.** Continuation and rate-limit steps of the same session spend nothing. Pinned in Tasks 7 and 10.
4. **Ambiguous final chunks.**
   - YouTube resolves a 5xx or a timeout on the final chunk through the status query (V21): 201 → success, 308 → resend, anything else → `PUBLISH_UNCONFIRMED`.
   - TikTok's final chunk stays `PUBLISH_UNCONFIRMED` on 5xx.
   - The X and LinkedIn commit calls are unchanged.

   Pinned in Tasks 10 and 11.
5. **The publish-health window.** Neither the backfill nor the hourly heal moves `updatedAt`. Rows the old code writes during the build window are healed within an hour. Pinned in Task 6.
6. **The deploy straddle.**
   - Runs in flight replay their old step ids.
   - `-c<n>` / `-wait-c<n>` are additive.
   - The old code ignores `uploadState` and `workspaceId`.
   - A rollback while a run is mid-continuation leaves the row `pending` for the reconciler (runbook).

   Pinned in Task 7 and the Task 1/9 runbook.

---

### Task 1: Carried runbook and email fixes (R31)

**Files:**
- Modify: `docs/STAGING_SETUP.md` ("Releasing pipeline changes (Inngest)")
- Modify: `app/src/server/notifications/email.ts`
- Test: `app/src/server/notifications/email.test.ts`

**Decisions:**
- **Step 1 of the runbook** gains phase 3: deploy phase 3 (the `20261103*` migrations) only after phase 2 is deployed and verified, and on its own.
- **Step 2 (pause the scanner).** After pausing `scheduled-post-scanner`, open its runs list and confirm that **no run is Running or Paused** before promoting. If one is, wait for it to end.
- **Step 3 (verify the sync).** The text currently says the config can be read "from the response of `PUT …/api/inngest`". Replace that: the PUT only returns `{ message, modified }`, so function config can be verified **only in the Inngest dashboard**. The PUT is still how to force a resync.
- **Step 4 (rollback).** Pause the scanner before rolling back and resume it at least 5 minutes after the resync, the same as step 2.
- **`email.ts`.** In the "Resend rejected email" log, `withoutRecipient(error.message, to)` becomes `withoutRecipient(String(error.message ?? ""), to)`. A Resend error whose `message` is missing or not a string must not throw out of `sendEmail`.

- [ ] **Step 1: Write the failing test.** `email.test.ts`: the Resend mock resolves `{ error: { statusCode: 422, name: "validation_error", message: undefined } }`, and then `message: 42`. Each `sendEmail` resolves (no throw), and the logged message is `""` / `"42"`. No logger call contains the recipient address.
- [ ] **Step 2: Confirm it fails.** Run `npx vitest run src/server/notifications/email.test.ts`. Expected: FAIL (a `TypeError` from `toLowerCase`).
- [ ] **Step 3: Implement** the guard and the four runbook edits. Keep the numbered structure, and name the real function ids (`scheduled-post-scanner`, `publish-to-all-platforms`).
- [ ] **Step 4: Verify.** Run the test, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `docs(release): verify scanner runs and config in the dashboard, pause around rollbacks; guard non-string Resend messages`

### Task 2: Caption-length caps at the API (R22)

**Files:**
- Create: `app/src/lib/captionLimits.ts`
- Test: `app/src/lib/captionLimits.test.ts`
- Modify: `app/src/app/api/posts/route.ts` (POST), `app/src/app/api/posts/[postJobId]/route.ts` (PATCH), `app/src/app/api/media/route.ts` (POST)
- Modify: `app/src/components/create-post-form.tsx` (caption textarea ~1032, submit guards ~624 and ~686), `app/src/app/queue/queue-view.tsx` (edit dialog ~397), `app/src/components/media-library.tsx` (caption field)
- Test: `app/src/app/api/posts/route.test.ts` (or the existing POST test file), `app/src/app/api/posts/[postJobId]/route.test.ts`, `app/src/app/api/media/route.test.ts`

**Decisions:**
- **The cap.** `MAX_CAPTION_CHARS = 10_000`, counted as `string.length` (UTF-16 code units).
  - That is the unit the browser's textarea counts in, so the composer and the API agree.
  - The value is above every platform's own limit except Facebook's (63,206).
  - Applied to the value as stored. POST `/api/media` trims first; the other routes store the raw value.
- **Override keys.** `perPlatformOverrides` keys that are not a `Platform` are **dropped** before validation and storage.
  - Today any key is accepted, but only platform keys are ever published (`overrides?.[platform]`).
  - Dropping them is what bounds the event: 1 base + 7 overrides × 10,000 = 80,000 characters. That is about 80 KB for ASCII and ≤ 240 KB as UTF-8. It sits under the 3 MiB Pro event cap (V7) and the scanner's 1 MiB dispatch sub-batch.
  - Rejecting the keys instead would block reuse of a legacy media item that carries one.
- **Over the cap** returns 400 `{ code: "CAPTION_TOO_LONG", error: "<field> is too long (max 10,000 characters)." }`. `<field>` is `baseCaption` or `perPlatformOverrides.<platform>`, matching the field-named messages these routes already return. It is checked right after each field's existing type check.
- **UI.**
  - Every caption textarea shows a muted counter `"1,234 / 10,000"`. It turns destructive over the cap, and the form's submit is disabled with the inline message "Caption is too long (max 10,000 characters).".
  - No `maxLength` attribute: it would silently truncate a paste.
  - An over-long *saved* override is left for the server's 400. The composer can't edit overrides; it only replays a reused item's.

**Interfaces:**
- Produces, in `captionLimits.ts`:
  - `MAX_CAPTION_CHARS = 10_000`, `CAPTION_TOO_LONG_CODE = "CAPTION_TOO_LONG"`.
  - `captionTooLongMessage(field: string): string`
  - `pickPlatformOverrides(value: Record<string, string>): Partial<Record<Platform, string>>`
  - `findOverlongCaption(input: { baseCaption?: string | null; perPlatformOverrides?: Partial<Record<Platform, string>> | null }): string | null`. It returns the first over-long field name, or null.
  - `captionCounter(text: string): { length: number; max: number; over: boolean; label: string }`. The label uses `toLocaleString("en-US")`.

- [ ] **Step 1: Write the failing tests.**
  - `captionLimits.test.ts`:
    - 10,000 `"a"` → not over; 10,001 → over;
    - `captionCounter("😀".repeat(5_000))` → `length: 10_000`, not over (surrogate pairs count 2);
    - `pickPlatformOverrides({ x: "a", foo: "b", linkedin: "c" })` → `{ x: "a", linkedin: "c" }`;
    - `findOverlongCaption({ baseCaption: "ok", perPlatformOverrides: { linkedin: "a".repeat(10_001) } })` → `"perPlatformOverrides.linkedin"`;
    - `captionCounter("a".repeat(1234)).label === "1,234 / 10,000"`.
  - Route tests, each asserting status 400, the body `{ code: "CAPTION_TOO_LONG", error: "baseCaption is too long (max 10,000 characters)." }` and that no `prisma.*.create` / `update` / `inngest.send` ran:
    - POST `/api/posts` with a 10,001-character `baseCaption`;
    - the same with a 10,001-character `perPlatformOverrides.x` (error names `perPlatformOverrides.x`);
    - PATCH with each of the two;
    - POST `/api/media` with a 10,001-character `baseCaption` (after trim).
  - **Override keys.** POST `/api/posts` with `perPlatformOverrides: { x: "hi", foo: "bar" }` → the job create receives `perPlatformOverrides: { x: "hi" }`.
  - **At the cap.** Exactly 10,000 characters → accepted.
- [ ] **Step 2: Confirm the tests fail.** Run `npx vitest run src/lib/captionLimits.test.ts src/app/api/posts src/app/api/media`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, the route checks and the three UI counters. Each UI's submit guard calls `captionCounter(text).over`.
- [ ] **Step 4: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `fix(api): cap captions at 10,000 characters and drop non-platform override keys`

### Task 3: Client hardening: guarded 401 flags (R24) and id-less 2xx commits (R30)

**Files:**
- Modify: `app/src/server/platforms/connectionHealth.ts`, `app/src/server/platforms/commitCall.ts`
- Modify (R24 flag sites):
  - `tiktokClient.ts`: `throwTikTokReconnect` and its callers at creator_info, `video/init` HTTP 401, `video/init` body `access_token_invalid`, and the status poll;
  - `linkedinClient.ts`: the image register, video register and `ugcPosts` 401s;
  - `instagramClient.ts`: the status poll, container and `media_publish` 401/190, plus the two expiry-guard flags;
  - `facebookPageClient.ts`: the `/photos` 401/190.
- Modify (R30 commit reads): `xClient.ts` (v1.1 `id_str`, v2 `data.id`), `youtubeClient.ts` (`id`), `instagramClient.ts` (`id`), `linkedinClient.ts` (`x-restli-id` header, then body `id`), `facebookPageClient.ts` (`id`, then `post_id`), `googleBusinessProfileClient.ts` (`name`)
- Test: `connectionHealth.test.ts`, `commitCall.test.ts`, and each client's test file

**Decisions:**
- **R24.** Every flag site that follows a platform rejection passes the tokens the rejected call used: `expected: { accessToken, refreshToken }` of the connection row the client is using.
  - **Superseded.** If `markConnectionNeedsReconnect` returns `"superseded"` (another process refreshed, or the user reconnected), nothing is flagged and the client throws `CONNECTION_TOKEN_CHANGED`. That is a plain, retryable failure: the call was rejected, so nothing was posted.
  - **Otherwise** the platform's `*_RECONNECT_REQUIRED` error is thrown as today.
  - **`instagramClient.refreshToken`** is a refresher, called by the health sweep through `refreshConnectionToken`. Its expiry flag uses the existing `flagTerminalRefreshFailure`, which throws `TOKEN_REFRESH_SUPERSEDED`, so the helper returns the stored row. It does not use `CONNECTION_TOKEN_CHANGED`.
  - **Invariant:** after this task, no `src/server/platforms/*Client.ts` calls `markConnectionNeedsReconnect` directly. Every flag goes through `flagRejectedToken` or `flagTerminalRefreshFailure`, both of which pass `expected`. Check it with a grep.
- **TikTok's status-poll 401 comes after the commit.** The final chunk already went up, and TikTok may be posting. It still flags (guarded), but always throws `publishUnconfirmedError("tiktok", cause)` instead of `TIKTOK_RECONNECT_REQUIRED`. Today a reconnect-and-retry there can double-post. This is the same family as Review Focus 5 of phase 2.
- **R30.** A 2xx commit body that parsed but lacks the id the code returns as `externalPostId` is `PUBLISH_UNCONFIRMED`: the platform said "created".
  - **LinkedIn** reads `x-restli-id` first (V26). It reads the body only when the header is absent, so a 201 with an empty body and the header is a success.
  - **Facebook** uses `id ?? post_id`.
  - **YouTube**'s `YOUTUBE_NO_VIDEO_ID` code is removed.

**Interfaces:**
- Produces, in `connectionHealth.ts`:
  - `CONNECTION_TOKEN_CHANGED_CODE = "CONNECTION_TOKEN_CHANGED"`
  - `connectionTokenChangedError(): Error & { code: string }`, with the message "This connection was refreshed or reconnected while publishing. Please retry."
  - `type TokenSnapshot = { id: string; accessToken: string; refreshToken: string | null }`
  - `flagRejectedToken(connection: TokenSnapshot, code: string): Promise<"flagged" | "superseded" | "error">`
- Produces, in `commitCall.ts`: `requireCommitId(platform: Platform, value: unknown, field: string): string`. It returns a non-empty string, else throws `publishUnconfirmedError(platform, new Error(\`2xx commit body without ${field}\`))`.
- Changes signatures:
  - `pollTikTokPublishStatus` options: `connectionId` → `connection: TokenSnapshot`;
  - `waitForInstagramContainer` options: `connectionId` → `connection: TokenSnapshot`;
  - LinkedIn `uploadImage` / `uploadVideo` / `createPost`: `connectionId` → `connection: TokenSnapshot`.

- [ ] **Step 1: Write the failing tests.**
  - `connectionHealth.test.ts`: `flagRejectedToken` with stored tokens equal → `update` with the three flag fields, `"flagged"`; different → no `update`, `"superseded"`.
  - `commitCall.test.ts`, `requireCommitId`:
    - `"abc"` → `"abc"`;
    - `undefined`, `""` and `42` → `PUBLISH_UNCONFIRMED` with a `cause` naming the field.
  - Client tests, R24. For each of these sites (TikTok creator_info, `video/init` 401, `access_token_invalid`; LinkedIn image register, video register, `ugcPosts`; Instagram container, `media_publish`, status poll; Facebook photos): with the guard's re-read returning **different** tokens → throws `CONNECTION_TOKEN_CHANGED` and no `socialConnection.update`; with **equal** tokens → the flag `update` and the platform's `*_RECONNECT_REQUIRED`.
  - TikTok, status poll answers 401 after the final chunk → throws `PUBLISH_UNCONFIRMED` in both guard outcomes, and flags only when the tokens are equal.
  - Client tests, R30: each commit answering 2xx with a body lacking the id gives `PUBLISH_UNCONFIRMED`:
    - X v1.1 `{}`; X v2 `{ data: {} }`;
    - YouTube `{}`;
    - Instagram `{}`;
    - Facebook `{}`; Facebook `{ post_id: "p1" }` → success `"p1"`;
    - GBP `{}`.
  - LinkedIn: 201 with header `x-restli-id: urn:li:share:1` and an empty body → `externalPostId: "urn:li:share:1"`; 201 with no header and `{}` → `PUBLISH_UNCONFIRMED`.
- [ ] **Step 2: Confirm the tests fail.** Run `npx vitest run src/server/platforms`. Expected: FAIL.
- [ ] **Step 3: Implement.** Then run `grep -n "markConnectionNeedsReconnect(" src/server/platforms/*Client.ts`. Expected: no hits; every site goes through `flagRejectedToken`.
- [ ] **Step 4: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `fix(platforms): guard 401 reconnect flags with the rejected tokens; treat id-less 2xx commits as unconfirmed`

### Task 4: Results whose connection was removed after dispatch (correctness L1, R15)

**Files:**
- Modify: `app/src/server/jobs/inngest-functions.ts` (`publishToAllPlatforms` plan building and `mark-failed-no-connections`)
- Modify: `app/src/server/jobs/failPendingResults.ts` (a new failure constant)
- Test: `app/src/server/jobs/inngest-functions.test.ts`

**Decisions:**
- **Plans come from the result rows.** The run plans one step per **result row**, not per current connection. Each result publishes through the workspace's current connection for its platform (one per platform: `@@unique([workspaceId, platform])`).
  - A result whose platform has no connection still gets its `publish-to-<p>` step. That step claims it and finalizes it failed with `CONNECTION_GONE_FAILURE`, instead of leaving it `pending` until the sweeps.
  - A result whose connection was replaced is repointed (`repointResultConnection`), as the retry path already does.
- **Order is deterministic from the memoized `fetch-data` output.** Results that have a connection come first, in today's connection order; then results without one, in result order. Runs in flight replay the same ids. Their memoized output already has both `socialConnections` and `resultRecords`.
- **No connections at all.** `mark-failed-no-connections` calls `failPendingPostJobResults(postJobId, CONNECTION_GONE_FAILURE)` instead of the bare status write.
  - Unclaimed pending results are failed. A claimed one becomes `PUBLISH_UNCONFIRMED`.
  - The job is recomputed: `failed`, also for zero results (`postStatus.ts:24`).
  - It still sends no email, as today.
- **L4** is already fixed (`retry/route.ts:316`). Nothing to do.

**Interfaces:**
- Produces, in `failPendingResults.ts`: `CONNECTION_GONE_FAILURE = { errorCode: "CONNECTION_GONE", errorMessage: "This platform connection was removed. Reconnect and retry." } as const satisfies PendingResultFailure`. That is the same code and copy `publishToPlatform` already writes.

- [ ] **Step 1: Write the failing tests** in `inngest-functions.test.ts`:
  - **One connection removed.** `fetch-data` yields connections `[x]` and results `[x, linkedin]`.
    - The step ids are `publish-to-x` then `publish-to-linkedin`.
    - LinkedIn's step claims, makes no `publishVideo` call, and finalizes `{ status: "failed", errorCode: "CONNECTION_GONE" }`.
    - `finalize-job` recomputes to `completed`, and `notify-outcome` is sent once.
  - **All connections removed (the L1 variant).** Connections `[]`, results `[x, linkedin]` → the step `mark-failed-no-connections` calls `failPendingPostJobResults("job-1", CONNECTION_GONE_FAILURE)`, and no `postJob.update` with `{ status: "failed" }` alone.
  - **Repoint.** A result whose `socialConnectionId` is null and whose platform has a current connection is repointed before publishing.
  - **Replay.** An old-shape `fetch-data` output (connections `[x, linkedin]`, results `[x, linkedin]`) gives the same step-id order as today.
- [ ] **Step 2: Confirm the tests fail.** Run `npx vitest run src/server/jobs/inngest-functions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `fix(jobs): fail results whose connection was removed after dispatch instead of stranding them pending`

### Task 5: Selected deferred minors (T5, T8, T9, T11, phase 1 T9)

**Files:**
- Modify: `app/src/server/platforms/connectionRefresh.ts` (T8)
- Test: `app/src/server/platforms/connectionRefresh.test.ts`
- Modify: `app/src/server/jobs/inngest-functions.ts` (`refreshConnection` and `notifyOwnersToReconnect`, T11)
- Test: `app/src/server/jobs/connectionHealthJobs.test.ts`
- Modify: `app/src/server/notifications/email.ts` (T11)
- Test: `email.test.ts`
- Modify: `app/src/server/jobs/mediaBlob.ts` (T9)
- Test: `mediaBlob.test.ts`
- Test: `app/src/server/jobs/platformSteps.test.ts` (T5: replay test, no production change)
- Modify: `app/src/app/api/media/route.ts`, `app/src/app/media/page.tsx`, `app/src/components/media-library.tsx`, `app/src/lib/mediaDto.ts` (phase 1 T9)
- Test: `app/src/app/api/media/route.test.ts`, `app/src/lib/mediaDto.test.ts`

**Decisions:**
- **T8, semaphore wait.** The wait is clamped to the caller's budget: `waitMs = min(REFRESH_LOCK_WAIT_MS, remainingMs(deadline) - MIN_REQUEST_WINDOW_MS)`.
  - `waitMs <= 0` → `PUBLISH_TIME_BUDGET_EXCEEDED` with no wait.
  - A timer that fires because of the 20 s bound → `CONNECTION_REFRESH_BUSY`, as today. One that fires because of the budget → `PUBLISH_TIME_BUDGET_EXCEEDED`.
- **T8, single-flight followers.** A follower waits on the leader's flight for at most its **own** `remainingMs(deadline) - MIN_REQUEST_WINDOW_MS`, then rejects `PUBLISH_TIME_BUDGET_EXCEEDED`. The leader is not cancelled.
  - If the leader rejects with `PUBLISH_TIME_BUDGET_EXCEEDED`, a follower with budget left starts its own flight once, after the leader's entry is cleared.
  - Any other leader error is shared, as today.
- **T11, UTC day.** The reconnect idempotency key's day comes from a memoized step `notify-day` (`new Date().toISOString().slice(0, 10)`), run before `notify-owners`. `notifyOwnersToReconnect(id, day)` takes it as an argument, so a retry across UTC midnight reuses the key.
- **T11, quota errors.** A Resend 429 named `daily_quota_exceeded` or `monthly_quota_exceeded` (V28) is classified `quota_exceeded`. It is logged at error level (no recipient) and dropped, even under `throwOnRetryable`. Retrying cannot help before midnight UTC or a plan change.
- **T9.** `del(key, { abortSignal: AbortSignal.timeout(BLOB_DELETE_TIMEOUT_MS) })` with `BLOB_DELETE_TIMEOUT_MS = 10_000` (V29).
  - The guard semantics are unchanged: an abort throws, so the caller's transaction rolls back and the row stays live, exactly as a failed `del` does today.
  - The "one 15 s item" bound in `mediaRetentionBatch.ts` then holds.
- **T5.** This is a test only. A replaying fake step memoizes by id and re-invokes the orchestrator from the start, the way Inngest re-enters a function.
- **Phase 1 T9 (POST `/api/media` workspace guard).** It uses the same contract as POST `/api/posts`, as the first check after the body is read:
  - absent `workspaceId` → today's behavior;
  - a non-string → 400 `INVALID_WORKSPACE_ID`;
  - a mismatch → 409 `WORKSPACE_CHANGED` with `WORKSPACE_CHANGED_MESSAGE`.

  `app/media/page.tsx` switches to `getWorkspaceContext()` and passes `workspaceId={context.workspace.id}` (a required prop). The library sends it. On 409 it shows the server's message, as it already does for errors.

**Interfaces:**
- Produces, in `connectionRefresh.ts`: `acquireSlot(state, cap, waitMs: number, onTimeout: () => Error)` (internal), and an internal `followFlight(flight, deadline)`.
- Produces, in `inngest-functions.ts`: `notifyOwnersToReconnect(socialConnectionId: string, utcDay: string)`.
- Produces, in `mediaBlob.ts`: `BLOB_DELETE_TIMEOUT_MS = 10_000`.
- Produces, in `mediaDto.ts`: `buildMediaCreateBody(input: { blobUrl: string; filename: string; mimeType: string; sizeBytes: number; baseCaption: string; workspaceId: string }): Record<string, unknown>`. The library posts it as is.

- [ ] **Step 1: Write the failing tests.**
  - `connectionRefresh.test.ts` (fake timers):
    - cap 2 held, deadline 12 s away → rejects `PUBLISH_TIME_BUDGET_EXCEEDED` at about 7 s;
    - no deadline → `CONNECTION_REFRESH_BUSY` at 20 s;
    - deadline 4 s away → rejects immediately, with no timer;
    - a follower with a deadline 8 s away and a leader that never settles → the follower rejects `PUBLISH_TIME_BUDGET_EXCEEDED` by 3 s, and the leader keeps running;
    - the leader rejects `PUBLISH_TIME_BUDGET_EXCEEDED` while a follower has 60 s left → `refresh` is called a second time (the follower's own flight), and the follower resolves its row.
  - `connectionHealthJobs.test.ts`: the `notify-owners` step receives the day from `notify-day`. A test that changes the clock to the next UTC day between the two steps (memoized `notify-day` output `"2026-11-01"`) still sends key `reconnect/conn-1/2026-11-01/<owner>`.
  - `email.test.ts`: with `throwOnRetryable: true`, 429 `daily_quota_exceeded` → resolves, with one error log; the same for `monthly_quota_exceeded`. 429 `rate_limit_exceeded` still rejects with `RetryAfterError`.
  - `mediaBlob.test.ts`: `del` is called with `(key, { abortSignal: expect.any(AbortSignal) })`, and `AbortSignal.timeout` is spied with `10_000`. A `del` that rejects with an `AbortError` makes `deleteBlobUnlessShared` reject (the caller rolls back).
  - `platformSteps.test.ts`, replay:
    - Plans x (success) and youtube (deferred, then success). Run the orchestrator once with a memoizing fake step, then **again from scratch** against the same memo.
    - The second pass calls no `plan.run` and no new `sleepUntil`, issues the identical id sequence, and returns deep-equal outcomes.
  - `media/route.test.ts`: `workspaceId: "ws-other"` → 409 `WORKSPACE_CHANGED`, and no `mediaItem.create`; `workspaceId: 7` → 400 `INVALID_WORKSPACE_ID`; absent → 201.
  - `mediaDto.test.ts`: `buildMediaCreateBody(...)` includes `workspaceId`.
- [ ] **Step 2: Confirm the tests fail.** Run the named files. Expected: FAIL. The replay test may already pass; that is fine, since it pins behavior Task 7 extends.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `fix(hardening): budget-bound refresh waits, memoized reconnect day, drop Resend quota errors, timed blob deletes, media workspace guard`

### Task 6: Publish-health on a workspace-scoped results index (db-review M5, web-review W16)

**Files:**
- Modify: `app/prisma/schema.prisma` (PostJobResult)
- Create: `app/prisma/migrations/20261103100000_post_job_result_workspace_id/migration.sql`
- Create: `app/prisma/migrations/20261103100100_backfill_post_job_result_workspace_id/migration.sql`
- Modify: `app/src/server/jobs/posting.ts` (the two `tx.postJobResult.create` sites, ~259 and ~491, and `prepareDeferredPostJobDispatch`'s `createMany`, ~762)
- Modify: `app/src/app/api/insights/publish-health/route.ts`, `app/src/lib/publishHealth.ts`
- Modify: `app/src/server/jobs/inngest-functions.ts` (`stalePostJobSweep`: a new step)
- Create: `app/src/server/jobs/resultWorkspaceHeal.ts`
- Test: `app/src/server/jobs/resultWorkspaceHeal.test.ts`; extend `posting.test.ts`, `deferredDispatch.test.ts`, `publish-health/route.test.ts`, `publishHealth.test.ts`, `stalePostJobs.test.ts` or `inngest-functions.test.ts` (the sweep)

**Decisions:**
- **Column.** `workspaceId String?`, with **no** relation or FK.
  - Results already die with their job (PostJob cascade).
  - An FK would validate the whole table under SHARE ROW EXCLUSIVE locks on both tables during the build (db-review M9).
  - Nullable, so the old code's inserts keep working.
- **Index.** `@@index([workspaceId, updatedAt])`, a plain `CREATE INDEX` on today's small table (as phase 2 T10 did).
- **Backfill.** A separate migration, idempotent and raw SQL, so `updatedAt` never moves (R26):

  ```sql
  UPDATE "PostJobResult" r SET "workspaceId" = j."workspaceId"
  FROM "PostJob" j WHERE r."postJobId" = j."id" AND r."workspaceId" IS NULL;
  ```

  - **Why it is bounded.** One statement over today's production table, which is small (thousands of rows). The TDB step measures it on the audit's 3.6M-row seed as an upper bound. The time is recorded in the commit body.
  - **If it times out.** `lock_timeout = '5s'` makes a backfill that queues behind a long transaction fail the build safely (P3009 recovery is in the runbook). It is re-runnable.
  - **Rows the old code writes in between.** Rows written between this migration and the promotion carry NULL. So does a rollback window. The hourly heal fixes them.
- **Heal.** `stalePostJobSweep` gets a step `heal-result-workspace`, after `fail-stale-post-jobs`. It runs the same `UPDATE`, restricted to `"id" IN (SELECT "id" FROM "PostJobResult" WHERE "workspaceId" IS NULL LIMIT 1000)`. The NULLs are found through the new index. It returns `{ healed }`. Remove it in a later phase, once no NULL rows have been seen for a release.
- **Writes.** Every result-creating write sets `workspaceId`: the immediate create, the reuse create and the deferred `createMany`.
- **Read.**

  ```ts
  prisma.postJobResult.groupBy({
    by: ["platform", "status"],
    where: { workspaceId, status: { in: ["success", "failed"] }, updatedAt: { gte: since } },
    _count: { _all: true },
  })
  ```

  - Counts are exact, so `MAX_ROWS = 2000` goes, along with W16's "wrong for heavy tenants".
  - It still reads `updatedAt` as the finish time (R26).
  - SEC-1 holds: only platform and status are grouped.
  - Caching (W16's second half) is not added.

**Interfaces:**
- Produces, in `publishHealth.ts`: `summarizePublishHealthCounts(rows: Array<{ platform: string; status: string; count: number }>): PublishHealthSummary`. `summarizePublishHealth` is re-expressed through it, and its tests stay green.
- Produces, in `resultWorkspaceHeal.ts`: `RESULT_WORKSPACE_HEAL_BATCH = 1000`, `healResultWorkspaceIds(): Promise<{ healed: number }>` (raw `$executeRaw`).

- [ ] **Step 1: Write the failing tests.**
  - `posting.test.ts` and `deferredDispatch.test.ts`: each result create, and each `createMany` row, has `workspaceId: "ws-1"`.
  - `route.test.ts` (publish-health):
    - `groupBy` is called with exactly the `where` above, with no `postJob` relation filter and no `take`;
    - counts `[{ platform: "x", status: "success", _count: { _all: 3 } }, { platform: "x", status: "failed", _count: { _all: 1 } }]` → `x` has `successRate: 75`;
    - a 401 without a context.
  - `publishHealth.test.ts`: `summarizePublishHealthCounts` gives the same output as `summarizePublishHealth` for an equivalent row set.
  - `resultWorkspaceHeal.test.ts`: `$executeRaw` is called once. Its SQL text contains `"workspaceId" IS NULL` and `LIMIT`, and does **not** contain `updatedAt`. No `updateMany` is called.
  - Sweep test: the step ids are `fail-stale-post-jobs` then `heal-result-workspace`, and a heal error is logged without failing the sweep.
- [ ] **Step 2: Confirm the tests fail.** Run the named files. Expected: FAIL.
- [ ] **Step 3: Add the schema and migrations.**
  - Schema: `workspaceId String?` and `@@index([workspaceId, updatedAt])`, with one comment block covering the denormalization, the absent FK, the backfill and heal, and R26.
  - Migration `…100000`: the header, `SET lock_timeout = '5s';`, `ALTER TABLE "PostJobResult" ADD COLUMN "workspaceId" TEXT;`, then `CREATE INDEX "PostJobResult_workspaceId_updatedAt_idx" ON "PostJobResult"("workspaceId", "updatedAt");`.
  - Migration `…100100`: a header explaining idempotency and the `updatedAt` rule, `SET lock_timeout = '5s';`, then the `UPDATE` above.
- [ ] **Step 4: Implement** the writes, the read, the helper and the sweep step.
- [ ] **Step 5: Run the TDB check `vs_p3_t6`, with the measurement.** After steps 1–4 of the procedure:
  1. **Seed.** `docker exec -i vibesocials-scale-pg psql -U postgres -d vs_p3_t6 -v ON_ERROR_STOP=1 < "C:/Users/Klaus/AppData/Local/Temp/claude/D--Github-apps-vibesocials/16b837d3-1900-4523-b5f8-78ef6e348c80/scratchpad/audit2/seed-scale.sql"`. Read the file, don't edit it. This is the audit's seed, about 3.6M results with NULL `workspaceId`. If it names a column that no longer exists, stop and report.
  2. **Backfill.** Run `\timing on` and the backfill migration's SQL. Record the time. Then `SELECT count(*) FROM "PostJobResult" WHERE "workspaceId" IS NULL` → 0. Re-run the backfill → `UPDATE 0` (idempotent).
  3. **Before.** Measure the way the audit did (`run-hot.sh`): run each statement twice and report the warm pass. Run audit query #5 (`hot-queries.sql` lines 133–146, with `w1` and now − 30 days) under `EXPLAIN (ANALYZE, BUFFERS)`.
  4. **After.** Run `EXPLAIN (ANALYZE, BUFFERS) SELECT "platform","status",count(*) FROM "PostJobResult" WHERE "workspaceId"='w1' AND "status" IN ('success','failed') AND "updatedAt" >= '<now-30d>' GROUP BY 1,2;`. Expected: it uses `PostJobResult_workspaceId_updatedAt_idx`, with no `Seq Scan on "PostJobResult"`.
  5. **Record.** Put both execution times and the backfill time in the commit body.

  Never use or modify `vibesocials_scale`. Then drop `vs_p3_t6`.
- [ ] **Step 6: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 7: Commit.** `perf(insights): count publish health from a workspace-scoped results index; denormalize and backfill PostJobResult.workspaceId`

### Task 7: Continuation steps and persisted upload state

**Files:**
- Modify: `app/prisma/schema.prisma` (`PostJobResult.uploadState`)
- Create: `app/prisma/migrations/20261103110000_post_job_result_upload_state/migration.sql`
- Modify: `app/src/server/jobs/platformSteps.ts`
- Modify: `app/src/server/jobs/resultClaim.ts`
- Create: `app/src/server/jobs/uploadState.ts`
- Test: `app/src/server/jobs/uploadState.test.ts`
- Modify: `app/src/server/platforms/types.ts`
- Modify: `app/src/server/jobs/inngest-functions.ts` (`claimOrSkip`, `publishToPlatform`, both functions' plans)
- Modify: `app/src/app/api/posts/[postJobId]/retry/route.ts` (the re-queue clears `uploadState`)
- Test: `platformSteps.test.ts`, `resultClaim.test.ts`, `inngest-functions.test.ts`, `retry/route.test.ts`

**Decisions:**
- **What `continue` means.** A platform client returns `PublishResult.continuation` when it made progress but has more to do: chunks left, processing not done, or too little step time left for the commit. It must have saved its state first.
- **What `publishToPlatform` does with it.**
  1. It releases the claim with `releaseClaimForContinuation`: one write that clears the claim and bumps the job heartbeat. It does **not** set `deferredUntil` or `errorCode`, so the Activity card shows no rate-limit copy.
  2. It reports `{ status: "continue", resumeAt, sleep }`.
  3. Then the run calls the platform again in `<stepId>-c<n>`, after `step.sleepUntil(<stepId>-wait-c<n>)` only when `sleep` is true.
  - A sleeping or queued continuation holds no claim, the same as a rate-limit deferral (V3: no slot is held either).
- **Determinism.**
  - `resumeAt` is computed **inside** the step and memoized. An immediate continuation carries the step's end time and `sleep: false`.
  - The queue orders deferred and continuing platforms together by that memoized instant (plan order breaks a tie). The platforms interleave, and no clock is read outside a step.
  - The counters for `-rl<n>` and `-c<n>` are independent and monotonic, so ids never repeat.
- **Bounds.**
  - **Per result.** `MAX_CONTINUATIONS_PER_RESULT = 40` per result per run.
    - Worst case: X at 0.25 MB/s, 103 segments, about 20 steps; LinkedIn, 128 parts plus processing, about 23 steps.
    - The 41st is finalized failed `UPLOAD_INCOMPLETE`: "The upload didn't finish in time. Nothing was posted — please retry."
    - The orchestrator also throws `NonRetriableError` past the cap, as it does for deferrals.
  - **Per run.** 7 platforms × (40 + 40 sleeps + 6 rate-limit steps) stays under 1,000 steps (V7).
- **Upload state.**
  - **Shape.** `PostJobResult.uploadState Json?` holds `{ v: 1, runId, platform, kind, savedAt, data, secret? }`.
  - **Secrets.** `secret` is `sealSecret(JSON.stringify(...))`: capability URLs and LinkedIn `metadata` go there, never in `data`.
  - **Load.** `load` returns null unless `v`, `runId`, `platform` and `kind` match. State from another run is ignored, so a retry starts fresh.
  - **Save.** `save` is claim-scoped: `updateMany where { id, claimRunId: runId, status: "pending" }`. A count of 0 throws `RESULT_CLAIM_LOST`.
  - **Size cap.** `MAX_UPLOAD_STATE_BYTES = 524_288`; a larger state throws `UPLOAD_STATE_TOO_LARGE`. Both errors are pre-commit failures.
  - **Cleared** by `finalizeClaimedResult` (both outcomes) and by the retry route's re-queue. It is **kept** by `releaseClaimForDeferral` and `releaseClaimForContinuation`.
  - The `updateMany` bumps `updatedAt` only on `pending` rows, which publish-health does not read (R26).
- **Claims.**
  - Each `-c<n>` step starts with `claimOrSkip`, exactly like attempt 0, so a resumed upload re-takes the claim.
  - The heartbeat is refreshed before the claim when `attempt > 0 || continuation > 0`.
  - `held_by_this_run` stays `PUBLISH_UNCONFIRMED` (Review Focus 1): conservative, and never a double post.
- **YouTube quota.** `publishToPlatform` spends `consumeYouTubeUploadSlot()` only when the store holds **no** state for this run. A continuation or a rate-limit retry of a running session spends nothing (Review Focus 3).
- **Store availability.** `PublishContext.uploadState` is always set by `publishToPlatform`. Clients treat an absent store (direct callers, tests) as "use today's in-step path".

**Interfaces:**
- Produces, in `platformSteps.ts`:
  - `MAX_CONTINUATIONS_PER_RESULT = 40`.
  - `PlatformStepOutcome` gains `| { platform: Platform; status: "continue"; resumeAt: string; sleep: boolean }`.
  - `PlatformStepPlan.run: (attempt: number, continuation: number) => Promise<PlatformStepOutcome>`.
  - Step ids: attempt 0 is `stepId`; `${stepId}-rl${n}` / `${stepId}-wait-rl${n}` as before; `${stepId}-c${m}` / `${stepId}-wait-c${m}`.
- Produces, in `resultClaim.ts`: `releaseClaimForContinuation(resultId: string, runId: string): Promise<boolean>`, where `{ id, claimRunId: runId, status: "pending" }`, data `{ claimRunId: null, claimedAt: null, postJob: { update: { updatedAt } } }`. A P2025 → false and a warning.
- Produces, in `uploadState.ts`:
  - `UPLOAD_STATE_VERSION = 1`, `MAX_UPLOAD_STATE_BYTES = 524_288`, `RESULT_CLAIM_LOST_CODE = "RESULT_CLAIM_LOST"`, `UPLOAD_INCOMPLETE: PendingResultFailure`.
  - `interface UploadSnapshot<D, S = never> { data: D; secret?: S }`
  - `interface UploadStateStore { load<D, S = never>(kind: string): Promise<UploadSnapshot<D, S> | null>; save<D, S = never>(kind: string, snapshot: UploadSnapshot<D, S>): Promise<void>; clear(): Promise<void> }`
  - `createUploadStateStore(args: { resultId: string; runId: string; platform: Platform }): UploadStateStore`
- Produces, in `types.ts`:
  - `PublishContext.uploadState?: UploadStateStore`
  - `PublishContext.continuation?: number`
  - `PublishResult.continuation?: { resumeAt: number | null }`. `null` means "call again now".

- [ ] **Step 1: Write the failing tests.**
  - `platformSteps.test.ts`:
    - **Sequence.** Plans x `[continue(sleep: false, at T+1s), success]` and youtube `[continue(sleep: true, at T+60s), success]`. The order is `run:publish-to-x`, `run:publish-to-youtube`, `run:publish-to-x-c1`, `sleep:publish-to-youtube-wait-c1`, `run:publish-to-youtube-c1`.
    - **Arguments.** `x-c1` is run with `(0, 1)`.
    - **Mixed counters.** The script `continue`, `deferred`, `continue`, `success` → ids `-c1`, `-wait-rl1` + `-rl1`, `-c2`. The `-rl1` attempt is run with `(1, 1)`.
    - **Cap.** A plan that continues 41 times → `NonRetriableError` before a 41st `-c` step.
    - **Replay** (extending Task 5's): the continuation sequence replays with no new `run`/`sleepUntil` calls.
  - `resultClaim.test.ts`:
    - `releaseClaimForContinuation` issues the `where`/`data` above; P2025 → false.
    - `finalizeClaimedResult` data includes `uploadState: Prisma.DbNull` for both outcomes.
    - `releaseClaimForDeferral` data has no `uploadState` key.
  - `uploadState.test.ts`:
    - **Save.** `save("youtube_resumable", { data: { confirmed: 5 }, secret: { sessionUri: "https://up/x" } })` → one `updateMany` with the claim `where`. The stored JSON's `secret` is not the plaintext URL (with `TOKEN_ENCRYPTION_KEY` set in the test env, the same way `tokenCrypto.test.ts` does).
    - **Load.** `load` round-trips; another `runId` → null; another `kind` → null; an undecryptable secret → null and a warning.
    - **Errors.** Count 0 → `RESULT_CLAIM_LOST`; a 600 KB state → `UPLOAD_STATE_TOO_LARGE`.
  - `inngest-functions.test.ts`, with a fake client that returns `{ continuation: { resumeAt: null } }` once and then success:
    - **Outcome.** Step `publish-to-x` outputs `{ status: "continue", sleep: false }`; `releaseClaimForContinuation` is called; no finalize happens.
    - **Next step.** `publish-to-x-c1` claims again, calls `publishVideo` with `ctx.continuation === 1` and the same store identity, and finalizes success with `uploadState` cleared.
    - **Cap.** The 41st continuation → finalized `UPLOAD_INCOMPLETE`.
    - **YouTube slot.** It is spent on `publish-to-youtube` (no state), and **not** on `-c1` or `-rl1` (the store mock returns state). The counter is called once.
    - **Own claim.** `held_by_this_run` on a `-c` step → `PUBLISH_UNCONFIRMED`, and no `publishVideo`.
    - **Secrets.** Concatenate `JSON.stringify(step.outputs)` across the run; it does not contain `"https://"`.
  - `retry/route.test.ts`: the re-queue data includes `uploadState: Prisma.DbNull`.
- [ ] **Step 2: Confirm the tests fail.** Run the named files. Expected: FAIL.
- [ ] **Step 3: Add the schema and migration.**
  - Schema: `uploadState Json?`, with a comment covering what it holds, the sealed `secret`, the claim-scoped writes, who clears it, and that the old code ignores it.
  - `migration.sql`: the header, `SET lock_timeout = '5s';`, then `ALTER TABLE "PostJobResult" ADD COLUMN "uploadState" JSONB;`.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run the TDB check `vs_p3_t7`.** The task's check is `\d "PostJobResult"`. Expected: `uploadState | jsonb`, nullable.
- [ ] **Step 6: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 7: Commit.** `feat(jobs): let a platform step continue in a later step with claim-scoped, sealed upload state`

### Task 8: Instagram container polling across steps (jobs L5)

**Files:**
- Modify: `app/src/server/platforms/instagramClient.ts`
- Test: `app/src/server/platforms/instagramClient.test.ts`; extend `inngest-functions.test.ts` (one end-to-end run)

**Decisions:**
- **Constants.** `INSTAGRAM_STATUS_CHECK_INTERVAL_MS = 60_000` and `INSTAGRAM_STATUS_MAX_CHECKS = 5` (V27). The in-step `waitForInstagramContainer` path is kept only for an absent store.
- **State.** `kind: "instagram_container"`, `data: { containerId, createdAt, checks }`. Nothing is secret: the token is never stored.
- **Flow for a REELS video with a store:**
  1. **No state.** Create the container (as today), save `checks: 0`, return `continuation: { resumeAt: now + 60 s }`. The step ends with no claim held; nothing is published.
  2. **State present.** One status check:
     - FINISHED → `media_publish`, the commit, in this claimed step. Then success, with Task 3's id rule.
     - IN_PROGRESS → `checks + 1`. At 5 checks → `INSTAGRAM_VIDEO_TIMEOUT` (nothing published; safe to retry). Else save and continue in 60 s.
     - ERROR → `INSTAGRAM_VIDEO_PROCESSING_ERROR`.
     - EXPIRED → `INSTAGRAM_CONTAINER_EXPIRED`, a new code.
     - PUBLISHED, before our publish call → `PUBLISH_UNCONFIRMED` (U12).
     - A Meta throttle → `RATE_LIMITED` (a deferral); the state is kept and the next attempt resumes with a check.
     - 401/190 → Task 3's guarded flag.
     - Any other non-OK answer or a network error counts as a check and continues.
  3. **Lost acks.** A re-run of a step finds the state and never creates a second container.
- **Images** keep today's in-step 3 s wait and publish.
- **How it composes.**
  - The steps are `publish-to-instagram` → `publish-to-instagram-wait-c1` → `publish-to-instagram-c1` → … up to `-c5`. Between them the result is `pending` and unclaimed.
  - A throttle during a check switches to the `-rl<n>` ids for that platform only. Other platforms run in between, ordered by `resumeAt`.
  - A run that dies while sleeping leaves an unclaimed row, which `onFailure` marks `PUBLISH_INTERRUPTED`. That is correct: no post exists.
  - The total wait is 1–5 minutes, far inside the 2 h reconciler window, and the heartbeat is refreshed at each wake.

- [ ] **Step 1: Write the failing tests.**
  - Client, with a fake store:
    - **No state.** The container POST is called once, the result is `continuation.resumeAt === now + 60_000`, and the saved state is `{ checks: 0 }`.
    - **FINISHED.** `media_publish` once, then success.
    - **IN_PROGRESS on the 5th check** → `INSTAGRAM_VIDEO_TIMEOUT`, with no `media_publish`.
    - **Single statuses.** EXPIRED → `INSTAGRAM_CONTAINER_EXPIRED`; PUBLISHED → `PUBLISH_UNCONFIRMED`.
    - **Throttle.** A status throttle (code 80002) → `RATE_LIMITED`, and the state is still saved.
    - **Lost ack.** With a state present, no container POST is made.
  - `inngest-functions.test.ts`, end to end through `runPlatformStepsWithDeferrals`: the status goes IN_PROGRESS, IN_PROGRESS, FINISHED.
    - The order is `run:publish-to-instagram`, `sleepUntil:publish-to-instagram-wait-c1`, `run:publish-to-instagram-c1`, `sleepUntil:…-wait-c2`, `run:…-c2`, `sleepUntil:…-wait-c3`, `run:…-c3`, `run:finalize-job`.
    - `claimResult` is called 4 times; `releaseClaimForContinuation` 3 times; `media_publish` once.
- [ ] **Step 2: Confirm the tests fail.** Run `npx vitest run src/server/platforms/instagramClient.test.ts src/server/jobs/inngest-functions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Update the header comment (it currently defers this to "phase 3").
- [ ] **Step 4: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(instagram): poll the container once a minute across steps instead of inside one`

### Task 9: Large-upload primitives: the blob chunk stream, the threshold and the kill switch (jobs B3)

**Files:**
- Create: `app/src/server/platforms/largeUpload.ts`
- Test: `app/src/server/platforms/largeUpload.test.ts`
- Modify: `app/.env.example` (adds `LARGE_UPLOAD_PLATFORMS`)
- Modify: `docs/STAGING_SETUP.md` (phase 3 release: smoke test and kill switch)

**Decisions:**
- **Threshold.** `LARGE_VIDEO_THRESHOLD_BYTES = 52_428_800` (50 MiB). The new path is used when `sizeBytes > threshold`.
  - **Memory.** At the threshold, today's path peaks at ≤ 100 MB per step (YouTube's 2× copy) instead of ~1 GB at 512 MB, and the new path at ≤ 64 MB.
  - **Time.** 50 MB fits today's 120 s request timeouts at ≥ 0.42 MB/s, and X needs only 10 APPENDs.
  - **Proven path.** It keeps the proven path for the large majority of posts.
- **One request per step.** `openBlobChunkStream` sends a single `GET` with `Range: bytes=<offset>-` and an `AbortSignal.timeout` of the step's remaining budget. It hands out exact-size reads.
  - **206.** It requires `Content-Range: bytes <offset>-<total-1>/<total>`.
  - **200 (U8).** It requires `Content-Length === total` and discards `offset` bytes, logging `range_ignored` once per process.
  - **Size mismatch.** `total !== sizeBytes` → `MEDIA_SIZE_MISMATCH` (nothing uploaded).
  - **Other statuses** → `BLOB_READ_FAILED` with `status`.
  - **Memory.** It pulls the body reader lazily and buffers at most the requested read plus one reader chunk.
- **The chunk window.** A non-commit chunk starts only with ≥ `LARGE_UPLOAD_CHUNK_WINDOW_MS = 60_000` left in the step. Each request's timeout is `budgetedTimeout(120_000, deadline)`.
- **Kill switch.** `LARGE_UPLOAD_PLATFORMS`, a comma list.
  - The default is `youtube,x,tiktok,linkedin`. `none` disables every platform.
  - An invalid or empty value → the default. Unknown names are ignored.
  - A platform not listed uses today's buffered path. A result that already has saved state for this run stays on the new path, so a flip never strands an upload.
  - It takes effect at the next deploy.
- **Runbook.** The phase 3 release adds:
  - after promotion, publish one ~100 MB video to each of YouTube, TikTok, X and LinkedIn on the sandbox/test accounts (`docs/STAGING_SETUP.md` "Sandbox platform apps");
  - on a failure, set `LARGE_UPLOAD_PLATFORMS` without that platform and redeploy;
  - a rollback mid-upload leaves those results to the 2 h reconciler.

**Interfaces:**
- Produces, in `largeUpload.ts`:
  - `LARGE_VIDEO_THRESHOLD_BYTES`, `LARGE_UPLOAD_CHUNK_WINDOW_MS = 60_000`, `LARGE_UPLOAD_REQUEST_TIMEOUT_MS = 120_000`, `DEFAULT_LARGE_UPLOAD_PLATFORMS`.
  - `LARGE_UPLOAD_MAX_PART_BYTES = 67_108_864` (64 MiB). This is the memory bound. A vendor-chosen part (LinkedIn) larger than it is refused before any upload.
  - `MEDIA_SIZE_MISMATCH_CODE`, `BLOB_READ_FAILED_CODE`.
  - `largeUploadPlatforms(env?: Record<string, string | undefined>): ReadonlySet<Platform>`
  - `usesLargeUploadPath(args: { platform: Platform; mimeType: string; sizeBytes: number; hasState: boolean; hasStore: boolean; env? }): boolean`
  - `interface BlobChunkStream { read(bytes: number): Promise<Buffer>; readonly position: number; close(): Promise<void> }`. `read` returns fewer bytes only at the end.
  - `openBlobChunkStream(url: string, opts: { offset: number; totalBytes: number; deadline?: number }): Promise<BlobChunkStream>`

- [ ] **Step 1: Write the failing tests** (with a lazily generated 300 MB source stream):
  - **206.** It sends `Range: bytes=104857600-`. Its reads of 16 MiB return the right bytes at the right offsets. After the first `read`, the source has been pulled at most 16 MiB plus one source chunk.
  - **200.** It discards the first 100 MiB and returns the same bytes as the 206 case.
  - **Mismatched `Content-Range` total** → `MEDIA_SIZE_MISMATCH`; a 404 → `BLOB_READ_FAILED` with `status: 404`.
  - **Deadline.** The abort signal's timeout is `<= remainingMs(deadline)`, and with 4 s left it throws `PUBLISH_TIME_BUDGET_EXCEEDED` before fetching.
  - **`usesLargeUploadPath`:**
    - 50 MiB → false; 50 MiB + 1 → true;
    - an image → false; no store → false;
    - `LARGE_UPLOAD_PLATFORMS="youtube"` with x → false, but true with `hasState: true`;
    - `"none"` → false; `""` → the default set.
- [ ] **Step 2: Confirm the tests fail.** Run `npx vitest run src/server/platforms/largeUpload.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, plus the env line and the runbook paragraph.
- [ ] **Step 4: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(platforms): stream blobs in bounded chunks for uploads above 50 MiB, with a per-platform kill switch`

### Task 10: YouTube resumable upload (jobs B3)

**Files:**
- Modify: `app/src/server/platforms/youtubeClient.ts`
- Test: `app/src/server/platforms/youtubeClient.test.ts`

**Decisions:**
- **Protocol (V21).**
  - Chunks are `YOUTUBE_RESUMABLE_CHUNK_BYTES = 16_777_216` (16 MiB = 64 × 256 KiB). That keeps memory at one 16 MiB buffer and gives ~64 s per chunk at 0.25 MB/s.
  - `YOUTUBE_STATUS_TIMEOUT_MS = 15_000`.
  - `YOUTUBE_FINAL_CHUNK_MIN_WINDOW_MS = 90_000`: the final chunk starts only with time left for it **and** a status query.
- **State.** `kind: "youtube_resumable"`, `data: { totalBytes, confirmedBytes }`, `secret: { sessionUri }`.
- **Each step:**
  1. **No state.** Initiate with the same video resource as today, extracted into `buildYouTubeVideoResource(ctx)`, and `X-Upload-Content-Length` / `X-Upload-Content-Type`. Run `classifyRateLimit` first (quota → `RATE_LIMITED`, as today). A 2xx with no `Location` → `YOUTUBE_UPLOAD_FAILED`. Save.
  2. **State present.** Status query first (`Content-Range: bytes */TOTAL`):
     - 308 → set `confirmedBytes` from `Range` (0 when absent);
     - 200/201 → done (success, with Task 3's id rule);
     - 404 → `store.clear()` and start over from (1) in this step. That restart is an untracked insert (U9).
  3. **Chunks.** Open the blob stream at `confirmedBytes` and send chunks while the window allows, with `Authorization`.
     - **Non-final, 308** → advance by `Range`. If it confirms less than was sent, resend the remainder from the same buffer.
     - **Non-final, 5xx / timeout / network** → status query, then resume. At most 2 per step; then save and continue.
     - **Final chunk** → 201 is success. A 5xx, timeout or network error → status query: 200/201 → success with its `id`; 308 → resend the rest (the upload is incomplete, so nothing was committed); a 404, an error or no time left → `PUBLISH_UNCONFIRMED`. Another 4xx → classify the rate limit, else `YOUTUBE_UPLOAD_FAILED`: it was rejected, not committed.
     - **429 / quota on a chunk** → save, then throw the `RateLimitedError`. The deferral resumes from the saved offset.
  4. **Out of window** → save `confirmedBytes` and return `continuation: { resumeAt: null }`.
- **Secrets.** The session URI is never logged. Logs carry `confirmedBytes` and `totalBytes` only.
- **Small files (≤ threshold or no store)** keep today's multipart path byte for byte.

- [ ] **Step 1: Write the failing tests** (a 40 MiB-plus-threshold file built from a lazy stream; fake store; `fetch` mock with a script per URL):
  - **Initiation.** The headers are `X-Upload-Content-Length: <total>` and `X-Upload-Content-Type: video/mp4`. The body is the same resource as the multipart path for the same ctx.
  - **Chunks.** Each PUT's `Content-Range` is `bytes a-b/total`. Every non-final body length is `16_777_216`, a multiple of `262_144`. No body exceeds 16 MiB.
  - **Two steps.** The deadline lets 2 chunks fit → continuation, with `confirmedBytes` saved. The next call starts with a status query and resumes at the 308 `Range`, with no second initiation.
  - **Partial 308.** `Range: 0-<sent-1MiB>` → the remainder is resent from the buffer.
  - **Final chunk, ambiguous.** 503, then status 201 `{ id: "v1" }` → `externalPostId: "v1"`, not unconfirmed. 503, then a status query timeout → `PUBLISH_UNCONFIRMED`.
  - **Expired session.** A status 404 → `clear()` and a new initiation.
  - **Rate limit.** A 429 on chunk 2 → `save` with chunk 1 confirmed, then `RATE_LIMITED` thrown.
  - **Final window.** With 80 s left before the final chunk → continuation, and the final PUT is not sent.
  - **Logs.** No `console.*` / `logger.*` argument contains the session URI.
  - **Small path.** At ≤ 50 MiB there is exactly one `uploadType=multipart` request (unchanged).
- [ ] **Step 2: Confirm the tests fail.** Run `npx vitest run src/server/platforms/youtubeClient.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(youtube): resumable chunked upload for videos above 50 MiB, resumable across steps`

### Task 11: TikTok streamed FILE_UPLOAD chunks (jobs B3)

**Files:**
- Modify: `app/src/server/platforms/tiktokClient.ts`
- Test: `app/src/server/platforms/tiktokClient.test.ts`

**Decisions:**
- **Chunk plan.** `computeChunkPlan` is unchanged: 10 MiB chunks, the final one absorbs the remainder (< 20 MiB), at most 1,000 chunks (V22). Each range is read from the blob stream with `read(end - start)`.
- **Constants.**
  - `TIKTOK_UPLOAD_URL_TTL_MS = 3_600_000` (V23).
  - `TIKTOK_UPLOAD_URL_SAFETY_MS = 600_000`: re-init when less is left and the final chunk has not been sent.
  - `TIKTOK_FINAL_CHUNK_MIN_WINDOW_MS = 150_000`: the final chunk (the commit) and the in-step status poll after it need a fresh step's worth of time. Post-commit work never crosses a step (Review Focus 1).
- **State.** `kind: "tiktok_file_upload"`, `data: { publishId, initAt, size, chunkSize, totalChunks, nextChunk }`, `secret: { uploadUrl }`.
- **Flow.**
  - **First step.** `creator_info` and `video/init` run once, in the first step, then the state is saved. Continuation steps skip both, which keeps `init` under 6/min (V23).
  - **Non-final PUTs.** 206 advances. 416 → resync `nextChunk` from the answer's `Content-Range` when it lands on a chunk boundary (U13), else `TIKTOK_UPLOAD_FAILED`. 403 (URL expired) → re-init and restart at chunk 0. 5xx / network → save and continue; the same chunk is retried next step.
  - **The final PUT** is unchanged: it goes through `commitRequest` (5xx/timeout → `PUBLISH_UNCONFIRMED`). Then `pollTikTokPublishStatus` runs in step, as today.
  - **A 429** → save, then throw `RATE_LIMITED`.
- **Small files** keep today's single-download path.

- [ ] **Step 1: Write the failing tests:**
  - **Init once.** A 6-chunk file over 2 steps: `creator_info` and `init` are each called once across both calls. The PUT `Content-Range`s are contiguous, and the final one ends at `size - 1`. No PUT body exceeds 20 MiB.
  - **416.** `Content-Range: bytes 0-20971519/<size>` resyncs to chunk 2.
  - **Expired URL.** 403 → a second `init`, and the PUTs restart at `bytes 0-`.
  - **Final window.** With 140 s left before the final chunk → continuation, with no final PUT.
  - **Final 503** → `PUBLISH_UNCONFIRMED`; final 201 → poll → success.
  - **Secrets.** The `uploadUrl` string appears in no `save` `data`, no log, and no returned value.
- [ ] **Step 2: Confirm the tests fail.** Run `npx vitest run src/server/platforms/tiktokClient.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(tiktok): stream FILE_UPLOAD chunks from storage for videos above 50 MiB, across steps`

### Task 12: X streamed chunked upload and cross-step processing (jobs B3, M3)

**Files:**
- Modify: `app/src/server/platforms/xClient.ts`
- Test: `app/src/server/platforms/xClient.test.ts`

**Decisions:**
- **Endpoint.** It keeps the endpoint and encoding the code uses: v1.1 `upload.twitter.com/1.1/media/upload.json`, `media_data` base64 in a form body, OAuth 1.0a. M8 is out of scope.
  - Segments stay at `X_APPEND_SEGMENT_BYTES = 5_242_880` (V24, U10).
  - Per request that is about 5 MB raw + 6.7 MB base64 + the signed form strings, about 30 MB in total.
- **Constants.** `X_LARGE_PROCESSING_MAX_MS = 1_200_000` (20 min from FINALIZE), `X_MEDIA_EXPIRY_SAFETY_MS = 600_000`, `X_DEFAULT_MEDIA_EXPIRES_SECS = 3_600` (unconfirmed, U10).
- **State.** `kind: "x_chunked"`, `data: { mediaId, totalBytes, nextSegment, phase: "append" | "processing" | "ready", expiresAt, finalizedAt?, failedSegmentRetries }`. Nothing is secret: each request is signed afresh.
- **Flow.**
  - **INIT once.** It records `expiresAt` from `expires_after_secs`.
  - **APPEND.** Segments are streamed while the window allows. `segment_index` continues across steps. A failed segment (5xx / network) is retried once in the next step; a second failure → `X_VIDEO_APPEND_FAILED`.
  - **FINALIZE once.** Then STATUS is polled **in step** while the remaining budget leaves room for a wait, a check and `X_TWEET_RESERVE_MS`. If processing is still running when the step ends → save and return `continuation: { resumeAt: now + clamp(check_after_secs, 5 s, 60 s) }`.
  - **Over 20 minutes since FINALIZE** → `X_VIDEO_PROCESSING_TIMEOUT` (no tweet).
  - **The tweet**, the commit, uses today's v1.1-then-v2 logic, extracted into `postTweet(...)` and shared with the small path. It is sent only with ≥ `X_TWEET_RESERVE_MS + 10_000` left, else an immediate continuation.
  - **Media about to expire** before the tweet → `clear()` and restart from INIT. Nothing was tweeted.
  - **A 429** anywhere → save, then throw `RATE_LIMITED`.
- **Small files** keep today's in-step path (including its 120 s processing cap).

- [ ] **Step 1: Write the failing tests:**
  - **Segments.** A 12-segment file over 2 steps: INIT once; `segment_index` runs 0–11 with no gap or repeat; every decoded `media_data` is ≤ 5,242,880 bytes; FINALIZE once.
  - **Processing.** STATUS `in_progress` until the step budget is out → `continuation.resumeAt` = now + the clamped `check_after_secs`. The next call polls without APPEND or FINALIZE, then `succeeded` → the tweet is sent once.
  - **Timeout.** Processing still `in_progress` 20 minutes after FINALIZE → `X_VIDEO_PROCESSING_TIMEOUT`, with no tweet request.
  - **Expiry.** `expiresAt` within 10 minutes before the tweet → a new INIT, and APPEND restarts at index 0.
  - **Segment retry.** A segment 503 → continuation with `failedSegmentRetries: 1`; a second 503 → `X_VIDEO_APPEND_FAILED`.
  - **Small path.** At ≤ 50 MiB, the request sequence is unchanged (an existing test still passes).
- [ ] **Step 2: Confirm the tests fail.** Run `npx vitest run src/server/platforms/xClient.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(x): stream chunked APPENDs and wait for processing across steps for videos above 50 MiB`

### Task 13: LinkedIn multipart video upload (jobs B3)

**Files:**
- Modify: `app/src/server/platforms/linkedinClient.ts`
- Test: `app/src/server/platforms/linkedinClient.test.ts`

**Decisions:**
- **Endpoints.** It keeps `/v2/assets` and `/v2/ugcPosts`; the Videos API migration is out of scope.
  - Above the threshold it registers `supportedUploadMechanism: ["MULTIPART_UPLOAD"]` with `fileSize` (V25, U11).
  - It uploads exactly the `byteRange`s LinkedIn returns (about 4 MiB each), with each part's own `headers` and **no** `Authorization` (V25).
- **Constants.** `LINKEDIN_URL_EXPIRY_SAFETY_MS = 300_000`, `LINKEDIN_ASSET_POLL_INTERVAL_MS = 60_000`, `LINKEDIN_ASSET_MAX_WAIT_MS = 600_000`.
- **State.** `kind: "linkedin_multipart"`, `data: { asset, mediaArtifact, totalBytes, partCount, nextPart, etags, phase: "upload" | "processing", completedAt?, urlsExpireAt }`, `secret: { parts: [{ url, firstByte, lastByte, headers }], metadata }`. 128 parts come to about 250 KB sealed, under the 512 KB cap.
- **Parts.** Each part PUT must answer 2xx with an `ETag`; a missing ETag → `LINKEDIN_VIDEO_UPLOAD_FAILED`. 5xx / network → save and continue, and the part is retried next step. 429 → `RATE_LIMITED`. A registered part larger than `LARGE_UPLOAD_MAX_PART_BYTES` → `LINKEDIN_VIDEO_UPLOAD_FAILED` before the first PUT (the memory bound).
- **URL expiry.** When the earliest `urlExpiresAt` is within 5 minutes and parts remain → re-register and restart. Nothing was posted.
- **Complete.** `POST /v2/assets?action=completeMultiPartUpload` with the ETags in part order and `httpStatusCode: 200`. A 401 goes through Task 3's guarded flag. A 2xx → phase `processing`.
- **Asset status.** `GET /v2/assets/{id}`, one check per step, a minute apart (continuation with `resumeAt`).
  - The `feedshare-video` recipe AVAILABLE → `createPost` (the commit, with Task 3's id rule).
  - CLIENT_ERROR / SERVER_ERROR / INCOMPLETE → `LINKEDIN_VIDEO_PROCESSING_FAILED` (nothing posted).
  - Still processing after 10 minutes, or an unreadable / 404 status answer → post anyway, which is today's behavior (it posts right after the upload), with a warning.
- **Logs.** The existing small-path log of the full register response (`linkedinClient.ts:462`) contains a capability URL. It shrinks to the asset URN. The new path logs only the asset URN and the part count.

- [ ] **Step 1: Write the failing tests** (the register answer has 3 parts with `urlExpiresAt` far ahead):
  - **Register.** The body has `supportedUploadMechanism: ["MULTIPART_UPLOAD"]` and `fileSize: <size>`.
  - **Parts.** The PUTs carry exactly each part's `byteRange` bytes and headers, with no `Authorization` header.
  - **Two steps.** 2 parts in step 1 → continuation; the third part in step 2, then complete.
  - **Complete body.** It is `{ completeMultipartUploadRequest: { mediaArtifact, metadata, partUploadResponses: [{ headers: { ETag: "e1" }, httpStatusCode: 200 }, …] } }`, in order.
  - **Status.** PROCESSING → continuation (`resumeAt` = now + 60 s); then AVAILABLE → `ugcPosts` once. CLIENT_ERROR → `LINKEDIN_VIDEO_PROCESSING_FAILED` with no `ugcPosts`.
  - **Expiry.** `urlExpiresAt` within 5 minutes with parts left → re-register.
  - **Secrets.** No part URL or `metadata` string appears in `save` `data`, logs or returned values.
  - **Small path.** It no longer logs the register response's upload URL.
- [ ] **Step 2: Confirm the tests fail.** Run `npx vitest run src/server/platforms/linkedinClient.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run the tests, then the gates. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(linkedin): multipart video upload across steps for videos above 50 MiB, posting once the asset is available`
