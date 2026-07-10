# Vibe Socials — Feature Roadmap & Implementation Spec

Status: DRAFT for review. Authored 2026-07-10. Follows the completed security/correctness
remediation and UI/UX overhaul.

This is a detailed, implementation-ready spec for the next wave of features: media
management (delete + reuse), retry-failed-platform, connection-expiry warnings, post
scheduling + drafts, per-platform preview, notifications, analytics, and the supporting
engineering-health work. It is grounded in the current codebase — every data-model, API,
and Inngest change below references what actually exists today.

---

## 1. Current architecture (the ground truth these features build on)

- **Stack:** Next.js 16 (App Router) + TypeScript + Prisma/Postgres (Neon) + Vercel Blob +
  Inngest for background posting. Design system + app shell already exist (tokens, primitives,
  `ConfirmDialog`, `Badge`, `Skeleton`, `EmptyState`, toasts, shell nav).
- **Data model** (`app/prisma/schema.prisma`): `User`, `SocialConnection`
  (per-platform tokens, `expiresAt`, `metadata`), `MediaItem` (`storageLocation`,
  `baseCaption`, `perPlatformOverrides`, `metadata`), `PostJob`
  (`status: pending|in_progress|completed|failed`, `mediaItemId`), `PostJobResult`
  (per-platform `status: pending|success|failed`, `externalPostId`, `errorCode`,
  `errorMessage`), `RateLimitEntry`.
- **Posting flow:** `POST /api/posts` (blobUrl JSON) → `createPostJobOnly` → `inngest.send({name:"post/publish.requested"})`. The Inngest function `publishToAllPlatforms`
  (`app/src/server/jobs/inngest-functions.ts`) fans out to each connected platform as a
  separate `step.run`, writing per-platform `PostJobResult`s.
- **Read surface (from the UI overhaul):** `GET /api/posts` (activity), `GET /api/connections`
  (health), `GET/POST /api/media` (library — **no DELETE**), display-only DTOs
  (`app/src/lib/postsDto.ts`).

### 1.1 The keystone constraint (read this before anything else)

`inngest-functions.ts` **deletes the media blob after every job**, success or failure
(`finalize-job` step: `del(mediaItem.storageLocation)` "to free storage"). This single line
is why:
- the media library is a read-only receipt list (the blob is gone after the first post),
- media cannot be reused across posts,
- a failed platform cannot be retried (the source media no longer exists).

**Media delete, media reuse, and retry-failed-platform all depend on changing this
lifecycle.** So Phase 1 below is a foundational "media persistence + retention" change that
several features sit on. It trades the current zero-retention model for a managed one, which
introduces a storage-cost decision (§8, open decision #1).

### 1.2 Constraints that bind every feature

- **Security/DTO discipline (non-negotiable — this repo had a token-serialization incident):**
  every new endpoint is auth-gated via `getCurrentUser()`, scoped by `where: { userId }`, and
  returns display-only DTOs — never `accessToken`/`refreshToken`/`scopes`/raw `metadata`.
- **CI gates stay green:** `tsc` 0, `eslint` **0 errors** (blocking), `next build` 0, `vitest`.
  No `any`. New UI uses the existing primitives + tokens (light/dark, WCAG AA, responsive).
- **Migrations** are additive and applied via `prisma migrate deploy` by the owner (like the
  `RateLimitEntry` migration); enum-value additions are additive-safe.
- **Rate-limit** any new heavy/AI/external-fetch route via `app/src/lib/rateLimit.ts`.

---

## 2. Phase 1 (FOUNDATION) — Media lifecycle & retention

**Why first:** unblocks media delete, media reuse, and retry (§3, §4, §5).

**Change the blob lifecycle.** Stop unconditionally deleting the blob in `finalize-job`. Media
becomes a persistent, user-owned library; storage is bounded by an explicit retention policy
instead of delete-after-post.

**Data model (`MediaItem`):**
- `deletedAt DateTime?` — soft delete (user-initiated or retention-swept).
- `lastUsedAt DateTime?` — set when a PostJob referencing it runs (drives retention).
- Keep the row even after the blob is gone so `PostJob` history (which references the
  `MediaItem` for caption/metadata) survives. **Do not** hard-delete `MediaItem` rows —
  `PostJob.mediaItemId` is `onDelete: Cascade`, so deleting a `MediaItem` today wipes post
  history. Soft-delete (blob removed, row kept, filtered from the library) avoids that.

**Retention:** a scheduled Inngest cron (`inngest.createFunction` with a cron trigger, e.g.
daily) sweeps blobs for `MediaItem`s that are (a) `deletedAt` set, or (b) older than N days AND
have **no** pending/scheduled/draft `PostJob` referencing them AND `lastUsedAt` older than N
days. It calls `del(storageLocation)` and sets `deletedAt`. N is configurable (open decision).
This preserves the original "don't let storage grow unbounded" intent without breaking reuse.

**Also:** add a display DTO for `GET /api/media` (currently returns full rows — no secrets in
`MediaItem`, but align with the DTO convention and drop internal fields).

**Effort:** M. **Owner action:** one migration; decide retention window N (§8 #1).

---

## 3. Media management — delete + reuse (depends on Phase 1)

### 3.1 Delete
- **API:** `DELETE /api/media/[id]` — auth + ownership (`where: { id, userId }`); if the item
  is referenced by a `scheduled`/`draft`/`pending` PostJob, **block with 409** + a clear
  message (don't orphan a queued post); otherwise `del(blob)` + set `deletedAt`. Returns 200.
- **UI:** a delete action on each media card → the existing **`ConfirmDialog` (destructive)** →
  `toast.success`; optimistic removal from the grid. Reuses Phase-C/D patterns exactly.

### 3.2 Reuse in a new post
- **API:** re-introduce a `mediaItemId` branch to `POST /api/posts` (JSON) — the HLT-3 cleanup
  removed the old synchronous `mediaItemId` path, but a **reuse** path is now a real use case:
  it creates a `PostJob` referencing an existing (non-deleted) `MediaItem` and sends the same
  `post/publish.requested` event (no re-upload). Validate the item exists, is owned, and its
  blob isn't `deletedAt`.
- **UI:** a "Use in new post" action on media cards → navigates to `/posts/new?mediaItemId=X`;
  the composer detects the param, loads the item (caption/overrides prefilled, preview shown),
  and skips the upload step. Everything else in the composer is unchanged.

**Effort:** S–M. **Depends on:** Phase 1 (persistent blob).

---

## 4. Retry a failed platform (depends on Phase 1)

**Problem:** posts routinely succeed on some platforms and fail on others (expired token,
transient API error). There is no way to re-attempt one platform without re-posting everything
— and today it's impossible anyway because the blob was deleted.

- **API:** `POST /api/posts/[postJobId]/retry` — auth + ownership; body `{ platform }` or
  `{ retryAllFailed: true }`. Validates the `MediaItem` blob still exists (else 409 "media no
  longer available — recreate the post"). Resets the target `PostJobResult`(s) to `pending` and
  sends a new event `post/retry.requested` with `{ postJobId, platforms }`.
- **Inngest:** a new function `retryPlatforms` on `post/retry.requested` that reuses the
  existing `publishToPlatform` helper for just the named platforms, updates those
  `PostJobResult`s, and recomputes the parent `PostJob.status`. (Factor `publishToPlatform` +
  the finalize/status-recompute into shared helpers so both functions use one code path.)
- **UI:** in the **Activity** view, each `failed` platform result gets a **Retry** button →
  calls the endpoint → optimistic `pending` state + toast. A `RECONNECT_REQUIRED` error (from
  the COR-5 work) surfaces as "Reconnect {platform} in Settings" with a link — synergy with §5.

**Effort:** M. **Depends on:** Phase 1.

---

## 5. Connection-expiry warnings (independent, small — high value)

**Problem:** connections silently expire (the live Google Business Profile `invalid_grant`).
`SocialConnection.expiresAt` already exists.

- **API:** extend `GET /api/connections` DTO with `expiresAt` and a derived
  `status: connected | expiring_soon | expired` (compare `expiresAt` to now ± a threshold,
  e.g. 3 days). **No tokens** in the payload.
- **UI:** the dashboard `ConnectionHealth` and the settings connections list render a
  **`Badge`**: `Connected` (success) / `Expires in 3d` (warning) / `Reconnect` (danger, links to
  reconnect). Optionally feed the notification system (§8) for proactive email.
- **Durable fix (ops, §9):** publishing the Google OAuth consent screen to Production stops the
  7-day Testing-mode refresh-token expiry that causes the recurring GBP break.

**Effort:** S. **Depends on:** nothing (can ship early).

---

## 6. Scheduling + drafts (the flagship)

**Problem:** posts fire immediately; the category-defining feature (Buffer/Later/Publer) is a
schedule/queue. The app shell was intentionally designed to accommodate a queue/calendar route.
Inngest natively supports durable delayed execution (`step.sleepUntil`) and cancellation
(`cancelOn`), so the infra is already a fit.

### 6.1 Data model
- `PostJobStatus` enum — add `draft`, `scheduled`, `cancelled` (additive).
- `PostJob` — add `scheduledFor DateTime?` (null = immediate). Index `@@index([userId, status, scheduledFor])`.

### 6.2 Flow
- **Immediate** (today's behavior): unchanged.
- **Scheduled:** composer sends `scheduledFor` (ISO, UTC — UI collects in the browser's local
  tz and converts). `POST /api/posts` creates the `PostJob` with `status: scheduled` +
  `scheduledFor` + its `PostJobResult`s (`pending`), and sends `post/publish.requested`
  immediately. The Inngest function gains a first step: `await step.sleepUntil("await-schedule",
  new Date(scheduledFor))` before the fetch/publish steps — **durable**, survives redeploys.
- **Cancel:** `POST /api/posts/[id]/cancel` sets `status: cancelled` and sends
  `post/cancel.requested`; the Inngest function is registered with
  `cancelOn: [{ event: "post/cancel.requested", if: "event.data.postJobId == async.data.postJobId" }]`, so the sleeping run is torn down.
- **Edit a scheduled post** (before it runs): `PATCH /api/posts/[id]` for caption/time/overrides
  → simplest robust implementation is cancel + recreate the run (keep the same `PostJob` row,
  bump `scheduledFor`, re-send the event after cancelling the old one). Only allowed while
  `status ∈ {scheduled, draft}`.

### 6.3 Drafts (`status: draft`)
- `POST /api/posts` with `{ draft: true }` → creates a `PostJob` (status `draft`, no
  `PostJobResult`s, **no** Inngest event). Composer "Save as draft".
- `POST /api/posts/[id]/publish` promotes a draft → creates results + sends the event (immediate
  or, with `scheduledFor`, scheduled).

### 6.4 UI
- **Composer:** a "Publish now / Schedule / Save draft" control + a datetime picker (with the
  user's tz shown). Reuses the existing primitives.
- **New "Queue" route** in the shell nav (the shell already reserves room): upcoming scheduled
  posts + drafts, grouped by day (list first; a calendar view is a fast follow), each with
  edit/cancel/publish-now/delete. `GET /api/posts` already returns the jobs; extend its DTO with
  `scheduledFor`/`status` and filter client-side (or add a `?status=` query param).

### 6.5 Edge cases
- Retention (§2) must **exclude** media referenced by `scheduled`/`draft` jobs from the sweep.
- A connection deleted/expired between scheduling and run → the platform fails at run time
  (existing per-platform isolation handles it; the result shows `RECONNECT_REQUIRED`).
- Scheduling in the past → validate `scheduledFor > now + small buffer`, else 400.
- **Recurring/repeating posts** are explicitly **out of scope for v1** (future).

**Effort:** L (flagship). **Owner action:** enum + column migration; tz default decision (§8 #3).

---

## 7. Additional features

### 7.1 Per-platform live preview (composer) — UI only
Show, per connected platform, how the post will render: caption **with footer applied**
(reusing `buildCaptionWithFooter`), the media, the platform's character limit + a truncation
preview (reuse the grapheme-safe `truncate` util), and hashtag rendering. Tabs/cards per
platform. No backend. **Effort:** M (design-heavy frontend). **Depends on:** nothing.

### 7.2 Notifications — post outcome alerts
On `finalize-job` (and retry finalize), notify the user of success/failure.
- **Data:** `User` notification prefs (e.g. `notifyOnPostComplete Boolean @default(true)`, or a
  `notificationPrefs Json`).
- **Infra:** an email provider (Resend or Postmark — new dependency + `RESEND_API_KEY` env) or
  reuse existing push infra. Inngest finalize step sends `notification.requested` →
  a `sendNotification` function emails a summary (per-platform outcome, link to Activity).
- **UI:** a settings toggle. **Effort:** M. **Open decision:** email provider (§8 #4).

### 7.3 Analytics — post performance (largest; phase last, start with 1–2 platforms)
- **Data:** `PostMetric { id, postJobResultId, fetchedAt, views, likes, comments, shares,
  raw Json }`, unique-ish per (result, fetch window).
- **Infra:** a scheduled Inngest cron pulls metrics per successful `PostJobResult`
  (`externalPostId`) from each platform's metrics API — **each platform differs**, some need
  **additional OAuth scopes** (→ a reconnect prompt). Respect platform rate limits.
- **Start with YouTube** (well-documented Analytics API) and one other, then expand.
- **UI:** metrics on the Activity detail + a dashboard summary (sparklines via the `dataviz`
  conventions). **Effort:** XL. **Open decision:** platform order + scope expansion (§8 #5).

---

## 8. Cross-cutting: engineering health (parallel track)

- **Error monitoring + structured logging (high operational payoff).** The app is currently
  debugged via `console.log` in production — which is exactly why the reviews `invalid_grant`
  was hard to see (the sanitized message hides the upstream code that lands only in Vercel
  logs). Integrate **Sentry** (`@sentry/nextjs`, client+server+Inngest; `SENTRY_DSN` env) and a
  thin structured logger; capture the standardized COR-3 error codes. **Effort:** M.
- **Durable OAuth fix:** publish the Google OAuth consent screen to Production (§5). **Ops.**
- **Dependency majors** (deferred UX-5): Prisma 6→7, Next bump, next-auth, eslint 9→10, TS 5→6 —
  deliberate, one at a time, gated by CI. **Effort:** M–L.
- **Tests:** Playwright E2E for the core flows (login → compose → activity), unit coverage for
  every new endpoint. **Effort:** M, ongoing.

### Open decisions for the owner
1. **Media retention window N** (Phase 1): keep media indefinitely (higher Blob cost, best UX) vs.
   sweep unused blobs after N days (default suggestion: 30 days, blobs only — rows kept). This
   is the cost/UX tradeoff created by enabling reuse/retry.
2. **Delete semantics:** soft-delete (recommended — preserves post history) vs. hard-delete.
3. **Scheduling timezone:** browser-local only (v1 default) vs. a per-user timezone setting.
4. **Notification channel:** email provider choice (Resend vs. Postmark) vs. reuse push.
5. **Analytics:** which platforms first, and whether requesting extra OAuth scopes (forcing
   reconnects) is acceptable.

---

## 9. Phasing & sequencing (dependency-ordered)

Each phase = one reviewed PR, same delegate-and-review model as the prior two programs
(Fable orchestrates + integrates; Opus for the subtle/foundational work — the Phase-1 media
lifecycle, scheduling's Inngest durability, analytics architecture — and per-phase adversarial
review; Sonnet for CRUD endpoints + UI migration; worktree isolation for disjoint work).

| # | Phase | Depends on | Effort | Value |
|---|-------|-----------|--------|-------|
| 1 | Media lifecycle & retention (foundation) | — | M | Unblocks 2–4 |
| 2 | Media delete + reuse | 1 | S–M | High (obvious gap) |
| 3 | Retry failed platform | 1 | M | High |
| 4 | Connection-expiry warnings | — | S | High (live pain) |
| 5 | Scheduling + drafts (flagship) | — (retention note) | L | Highest differentiator |
| 6 | Per-platform preview | — | M | Polish |
| 7 | Notifications | — | M | Medium |
| 8 | Analytics (start YouTube) | — | XL | Medium, heavy |
| H | Health: Sentry+logging, OAuth publish, deps, E2E | — | M–L | Foundational |

**Recommended order:** Phase 1 → (2, 3, 4 as a "quick wins" batch, mostly parallel) →
5 (flagship) → 6/7 → 8. Run **H (Sentry + OAuth publish)** in parallel early — it makes every
subsequent phase easier to operate and debug.

## 10. Risks & non-goals
- **Storage cost** is the main new cost driver (Phase 1). Mitigated by the retention sweep;
  quantify against Vercel Blob pricing before choosing N.
- **Per-platform analytics** is the biggest unknown (each API + scopes differ); scope it as its
  own initiative, not a single sprint.
- **Non-goals (v1):** recurring/repeating posts, team/multi-user accounts, bulk CSV import,
  in-app media editing — all reasonable *later*, none blocking.
</content>
