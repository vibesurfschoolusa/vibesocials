# Vibe Socials — Feature Roadmap & Implementation Spec

Status: REVIEWED & CORRECTED. Authored 2026-07-10, revised same day after an adversarial
review against the codebase. Follows the completed security/correctness remediation and
UI/UX overhaul.

Detailed, implementation-ready spec for the next feature wave: media management (delete +
reuse), retry-failed-platform, connection health/reconnect warnings, post scheduling + drafts,
per-platform preview, notifications, analytics, and the supporting engineering-health work.
Every data-model, API, and Inngest change references what actually exists today.

**Corrections made by the review are marked `REVISED` inline.** The load-bearing ones: the
connection-health signal was wrong (`expiresAt` ≠ reconnect-needed); scheduling must create
per-platform results at run time, not schedule time; PostJobStatus enum additions are *not*
"safe" at the TypeScript layer; and scheduling should be a DB-backed cron due-scanner, not a
weeks-long `sleepUntil`.

---

## 1. Current architecture (ground truth)

- **Stack:** Next.js 16 (App Router) + TypeScript + Prisma/Postgres (Neon) + Vercel Blob +
  Inngest ^3.48 for background posting. Design system + app shell already exist (tokens,
  primitives, `ConfirmDialog`, `Badge`, `Skeleton`, `EmptyState`, toasts, shell nav). Inngest is
  served at `app/src/app/api/inngest/route.ts` from the `inngestFunctions` array.
- **Data model** (`app/prisma/schema.prisma`): `User`, `SocialConnection` (per-platform tokens,
  `expiresAt`, `metadata`; `@@unique([userId, platform])`), `MediaItem` (`storageLocation`,
  `baseCaption`, `perPlatformOverrides`, `metadata`), `PostJob`
  (`status: pending|in_progress|completed|failed`, `mediaItemId`), `PostJobResult`
  (per-platform `status`, `externalPostId`, `errorCode`, `errorMessage`), `RateLimitEntry`.
- **Posting flow:** `POST /api/posts` (blobUrl JSON) → `createPostJobOnly` (creates a `MediaItem`
  **and** the `PostJob` + `PostJobResult`s, returns `mediaItemId`) → `inngest.send("post/publish.requested")`. The Inngest function `publishToAllPlatforms`
  (`app/src/server/jobs/inngest-functions.ts`) refetches the MediaItem by id, iterates the
  user's **current** connections, and fans out per platform as separate `step.run`s, matching a
  pre-created `PostJobResult` **by platform**. `finalize-job` sets `PostJob.status` and **deletes
  the blob**.
- **Read surface (from the UI overhaul):** `GET /api/posts` (activity, selects
  `mediaItem.baseCaption`), `GET /api/connections` (health), `GET/POST /api/media` (library — no
  DELETE), display-only DTOs (`app/src/lib/postsDto.ts`).

### 1.1 The keystone constraint

`inngest-functions.ts` **deletes the media blob after every job**, success or failure
(`finalize-job`: `del(mediaItem.storageLocation)` "to free storage"). The `MediaItem` **row**
persists; only the blob is removed (inside a swallow-all try/catch). This is why the media
library is a read-only receipt list, media can't be reused, and a failed platform can't be
retried (the source blob is gone). **Media delete, reuse, and retry all depend on changing this
lifecycle** (Phase 1). Removing the `del()` doesn't break immediate posting — the publish/finalize
flow is otherwise untouched and existing thumbnails simply start resolving.

### 1.2 Constraints that bind every feature

- **Security/DTO discipline (non-negotiable — this repo had a token-serialization incident):**
  every new endpoint is auth-gated via `getCurrentUser()`, scoped by `where: { userId }`,
  returns display-only DTOs (never `accessToken`/`refreshToken`/`scopes`/raw `metadata`), and
  validates input.
- **Rate-limiting:** REVISED — `POST /api/posts` is **not** rate-limited today (only the three AI
  routes are). Every new *posting* entry point (reuse, retry, publish-draft, scheduled-create)
  triggers live multi-platform posting — the heaviest external action — so the create/reuse/
  publish family shares a posting bucket via `lib/rateLimit.ts` (`route: "posts/publish"`), and
  **retry gets its own tighter bucket** (abuse = duplicate live posts).
- **CI gates stay green:** `tsc` 0, `eslint` **0 errors** (blocking), `next build` 0, `vitest`.
  No `any`. REVISED — adding `PostJobStatus` enum members is DB-additive but **breaks
  TypeScript**: `app/src/components/activity/post-job-card.tsx` has an exhaustive
  `Record<PostJobStatus, …>` (`JOB_STATUS_META`) that will fail `tsc` (TS2741) until extended.
  Any PR that touches the enum must grep `Record<PostJobStatus` / switches on `.status` and
  extend them in the same change, and widen the `postsDto` status union.
- **New UI reuses the design system:** primitives + tokens (light/dark, WCAG AA, responsive),
  and every new view ships loading (`Skeleton`), empty (`EmptyState`), and error (`Alert`+retry)
  states — same bar as the overhaul.
- **Migrations** are additive and applied via `prisma migrate deploy` by the owner (the
  `RateLimitEntry` precedent).

---

## 2. Phase 1 (FOUNDATION) — Media lifecycle & retention

**Why first:** unblocks media delete, reuse, and retry.

**Change the blob lifecycle.** Stop unconditionally deleting the blob in `finalize-job`. Media
becomes a persistent, user-owned library; storage is bounded by an explicit retention policy.

**Data model (`MediaItem`):** `deletedAt DateTime?` (soft delete), `lastUsedAt DateTime?`.
REVISED — soft-delete is the correct mitigation and the relation must **not** change: deleting a
`MediaItem` cascades to `PostJob` → `PostJobResult` (`onDelete: Cascade`), wiping history, and the
Activity caption lives only on `MediaItem.baseCaption` (so `SetNull` would blank historical
captions and `mediaItemId` is non-null app-wide). Keep the row; delete only the blob; filter
`deletedAt != null` from the library.

**Retention cron** (Inngest `cron` trigger, daily) — REVISED for the races the review found:
- Exclude media referenced by **any non-terminal** `PostJob` — `pending`, `in_progress`,
  `scheduled`, `draft` (the original list omitted `in_progress`, the status an active immediate
  post carries).
- Set `lastUsedAt = now` at **attach/schedule time**, not just at run time (a scheduled reuse
  runs weeks later; run-time-only stamping leaves it stale exactly when the sweep looks).
- Re-check the "no non-terminal referencing job" predicate **inside the same transaction** as the
  `del()` (check-then-act race: reuse can newly reference an >N-day-old item between the sweep's
  decision and the `del`).
- **Never-posted library uploads** (`POST /api/media`) have `lastUsedAt = null` and no PostJob;
  use `lastUsedAt ?? createdAt` for the age gate, and **exempt user-uploaded library items from
  age-based sweeping** (only sweep `deletedAt`-set and truly-orphaned post-media) — otherwise the
  "persistent library" promise is hollow. (Open decision #1 sets N and this exemption.)

**DTO for `GET /api/media`:** REVISED — the media UI renders thumbnails from `storageLocation`
(`media-library.tsx`), so **keep `storageLocation`**; drop only `userId`/raw internal fields.
Note: blobs are `access:"public"`, so persisting them lengthens public-URL exposure — acceptable,
worth one line in the PR.

**Effort:** M/L (once the races are handled). **Owner action:** one migration; decide retention N
+ library exemption (§8 #1).

---

## 3. Media management — delete + reuse (depends on Phase 1)

### 3.1 Delete
- **API:** `DELETE /api/media/[id]` — auth + ownership (`where: { id, userId }`); **409** if the
  item is referenced by any non-terminal (`pending`/`in_progress`/`scheduled`/`draft`) PostJob;
  else `del(blob)` + set `deletedAt`. Returns 200.
- **UI:** delete action per media card → the existing **`ConfirmDialog` (destructive)** →
  `toast.success` + optimistic removal.

### 3.2 Reuse in a new post — REVISED (framing was inaccurate)
The async publisher **already resolves media by id** (`inngest-functions.ts` refetches the
MediaItem and reads `storageLocation`), so **the Inngest function needs zero changes** for reuse.
The real change is a new posting-helper variant, not "re-introducing" the HLT-3-removed branch
(that was the *synchronous execution* path):
- **Helper:** `createPostJobForExistingMedia({ userId, mediaItemId, baseCaption, perPlatformOverrides, ... })`
  that **skips MediaItem creation**, verifies ownership + `deletedAt == null`, and creates only
  the `PostJob` + `PostJobResult`s referencing the existing item, then sends the same
  `post/publish.requested` event.
- **Caption source:** REVISED — the publisher uses the **event payload's** `baseCaption`/
  `perPlatformOverrides` (not the stored `MediaItem.baseCaption`), so the composer must pass
  caption/overrides in the reuse request (prefilled from the item, editable).
- **API:** `POST /api/posts` branches to the helper when `mediaItemId` is present (rate-limited,
  §1.2).
- **UI:** "Use in new post" on media cards → `/posts/new?mediaItemId=X`; the composer loads the
  item (caption/overrides prefilled, preview shown) and skips upload.

**Effort:** S–M.

---

## 4. Retry a failed platform (depends on Phase 1)

- **API:** `POST /api/posts/[postJobId]/retry` — auth + ownership; body `{ platform }` or
  `{ retryAllFailed: true }`; gate on `MediaItem.deletedAt == null` (409 "media no longer
  available"); **rate-limited (tight bucket, §1.2)**.
- **Idempotency — REVISED (double-post gap):** posting is not idempotent, so a double-click or a
  retry while the original run is still uploading would duplicate the live post. Guard
  server-side: flip the target `PostJobResult` to `pending` only via a **conditional update
  (`where: { id, status: "failed" }`)** and **409 if it isn't currently `failed`**; give the retry
  Inngest run a **concurrency/idempotency key per `(postJobId, platform)`**. "Optimistic pending"
  in the UI is not a substitute.
- **Inngest:** a new function `retryPlatforms` on `post/retry.requested` reuses the existing
  `publishToPlatform` helper for the named platforms and recomputes `PostJob.status`.
- **Status recompute — REVISED (must be defined over ALL results, not the retried subset):**
  `pending` if any result is pending/in-flight; `completed` if ≥1 `success` and none pending;
  `failed` only if all terminal and none `success`. Factor this rule + `publishToPlatform` into
  shared helpers so the main publish function and retry use one code path.
- **UI:** Activity view — each `failed` platform result gets a **Retry** button; a
  `RECONNECT_REQUIRED` error (from COR-5) surfaces as "Reconnect {platform} in Settings" (synergy
  with §5).

**Effort:** M/L (with idempotency in scope).

---

## 5. Connection health / reconnect warnings — REVISED (mechanism was wrong)

**Problem:** connections silently break (the live Google Business Profile `invalid_grant`).

**Do NOT use `expiresAt`.** REVISED — `expiresAt` is the **access-token** expiry: ~1h for
Google/YouTube/GBP (auto-refreshed on use), ~24h for TikTok, and **`null` for X** (OAuth 1.0a).
The app already treats "past `expiresAt`" as *"refresh now,"* not *"broken."* A 3-day threshold
would flag every healthy Google connection as "expired" permanently, while the **actual** failure
— a **refresh-token revocation** (7-day Testing-mode) — is never reflected in `expiresAt` at all.

**Add an explicit reconnect signal.** `SocialConnection.needsReconnect Boolean @default(false)`
(optionally `+ lastRefreshErrorCode String? + refreshFailedAt DateTime?`):
- **Set** it when a token refresh returns a terminal auth failure — in `refreshGoogleToken`
  (`GOOGLE_TOKEN_REFRESH_FAILED` / `invalid_grant` / `GOOGLE_NO_REFRESH_TOKEN`) and the equivalent
  per-platform refresh/publish paths (the COR-5 `*_RECONNECT_REQUIRED` codes).
- **Clear** it on a successful reconnect (the OAuth callback that rewrites the connection).
- **Derive** the badge from this flag, not from `expiresAt`; treat `expiresAt: null` as "no
  expiry."
- **API:** extend `GET /api/connections` with `needsReconnect` (+ platform/label) — **no tokens**.
- **UI:** dashboard `ConnectionHealth` + settings show `Connected` (success) vs. `Reconnect`
  (danger, links to reconnect). Optionally feed §7.2 for proactive email.
- **Durable ops fix (§9):** publish the Google OAuth consent screen to Production to end the
  7-day Testing-mode refresh-token expiry.

**Effort:** S/M (the column + set/clear wiring is the work, not the badge).

---

## 6. Scheduling + drafts (flagship) — REVISED architecture

**Problem:** posts fire immediately; the category-defining feature is a schedule/queue. The shell
already reserves room for a Queue route.

### 6.1 Data model
- `PostJobStatus` — add `draft`, `scheduled`, `cancelled` (DB-additive; **update every exhaustive
  `Record<PostJobStatus>` in the same PR**, §1.2 / C3).
- `PostJob` — add `scheduledFor DateTime?` (null = immediate) and `@@index([status, scheduledFor])`.

### 6.2 Architecture — REVISED: DB-source-of-truth + cron due-scanner (not `sleepUntil`)
The first draft proposed `step.sleepUntil(scheduledFor)` inside `publishToAllPlatforms` for the
whole delay. That is durable but the wrong default: (a) **function-versioning hazard** — Inngest
replays steps by position/id, and this roadmap keeps editing that exact function (§4 shared
helpers, §7.2 finalize notification step), so every deploy is a landmine for runs sleeping for
weeks; (b) **cancel/edit race** — keying `cancelOn` on `postJobId` while implementing edit as
cancel+recreate with the same `postJobId` lets a cancel tear down the *new* run; (c) thousands of
runs parked "sleeping" is poor observability when the DB `scheduledFor` is the real source of
truth the Queue reads anyway.

**Design:**
- **Immediate** (today): `POST /api/posts` creates the job and sends `post/publish.requested` now.
- **Scheduled:** `POST /api/posts` with `scheduledFor` creates the `PostJob` with
  `status: scheduled` + `scheduledFor` and **sends no event yet**.
- **Cron due-scanner:** a small Inngest `cron` function (every 1–5 min) atomically claims due jobs
  (`updateMany where status=scheduled AND scheduledFor<=now → in_progress`, returning the claimed
  ids) and sends `post/publish.requested` for each. ≤5-min jitter is fine for a social scheduler.
- **The publish function stays short-lived and freely deployable** (no long sleep in it).
- **Cancel/edit become plain DB updates** — no Inngest run to tear down, no event race:
  `POST /api/posts/[postJobId]/cancel` sets `status: cancelled`; `PATCH /api/posts/[postJobId]`
  edits caption/overrides/`scheduledFor` while `status ∈ {scheduled, draft}`.

### 6.3 Per-platform results created at RUN time — REVISED (Critical correctness fix)
Do **not** pre-create `PostJobResult`s at schedule time. The fan-out iterates the user's
**current** connections and matches results **by platform**; over a weeks-long gap: a **deleted**
connection cascade-deletes its pre-made result (silent vanish — `PostJobResult.socialConnection`
is `onDelete: Cascade`), and a **newly added** connection has no result row and is **never posted
to**. Create the `PostJobResult`s **inside the publish function**, from the connections that exist
at run start (immediate posting can keep creating them up-front since there's no gap, or unify on
run-time creation). §6.5's old "fails at run time / shows RECONNECT_REQUIRED" claim for deleted
connections was false and is removed.

### 6.4 Drafts (`status: draft`)
- `POST /api/posts` with `{ draft: true }` → creates a `PostJob` (status `draft`, **no**
  `PostJobResult`s, **no** event). Composer "Save as draft."
- `POST /api/posts/[postJobId]/publish` promotes a draft (immediate, or with `scheduledFor`,
  scheduled). Draft blobs are never deleted by `finalize-job`, so **Phase 1's retention sweep is
  required** to avoid unbounded abandoned-draft blob growth.

### 6.5 UI
- **Composer:** a "Publish now / Schedule / Save draft" control + a datetime picker. REVISED —
  there is **no datetime primitive**; use native `<input type="datetime-local">` (consistent with
  the browser-local-tz v1 decision, §8 #3), or budget a new primitive. Show the user's tz.
- **New "Queue" route** in the shell nav: upcoming scheduled posts + drafts grouped by day (list
  first; calendar is a fast follow), each with edit/cancel/publish-now/delete. `GET /api/posts`
  extends its DTO with `scheduledFor`/`status` (add `?status=` filter).
- **Recurring/repeating posts are out of scope for v1.**

### 6.6 Edge cases
- Retention (§2) excludes any non-terminal job (covers `scheduled`/`draft`).
- Validate `scheduledFor > now + buffer` (else 400).
- A connection expired/broken by run time fails per-platform at run time (existing isolation) and
  surfaces the reconnect code — retried later via §4.

**Effort:** L/XL (enum+migration, composer, cron, run-time result creation, edit=cancel/recreate,
drafts, Queue UI, DTO). **Route naming — REVISED:** standardize on `[postJobId]` (matches the
existing route); `cancel`/`retry`/`publish` are `[postJobId]/<action>/route.ts`; `PATCH` extends
the existing `[postJobId]/route.ts`.

---

## 7. Additional features

### 7.1 Per-platform live preview (composer) — UI only
Show, per connected platform, how the post renders: caption **with footer** (`buildCaptionWithFooter`),
the media, the platform char-limit + a truncation preview (`truncateGraphemes`), hashtags.
REVISED — **no shared char-limit config exists** (limits are hardcoded inside clients: X 280,
TikTok 2200; absent for YouTube/Instagram/LinkedIn/FB/GBP). Add a `Record<Platform, { charLimit }>`
map and make it the **single source of truth the platform clients also consume**, or preview and
real truncation drift. **Effort:** M.

### 7.2 Notifications — post-outcome alerts — REVISED: move up next to scheduling
A scheduled post firing unattended at 3am with a silent platform failure is the exact scenario
scheduling creates, so notifications should **accompany §6**, not sit last.
- **Data:** `User` prefs (`notifyOnPostComplete Boolean @default(true)` or `notificationPrefs Json`).
- **Infra:** an email provider (Resend/Postmark — new dep + env) or reuse existing push. Inngest
  finalize (and retry finalize) sends `notification.requested` → a `sendNotification` function
  emails the per-platform outcome + a link to Activity.
- **UI:** settings toggle. **Effort:** M. **Open decision:** provider (§8 #4).

### 7.3 Analytics — post performance (largest; phase last, start with YouTube)
- **Data:** `PostMetric { id, postJobResultId, fetchedAt, views, likes, comments, shares, raw Json }`.
- **Infra:** a scheduled Inngest cron pulls metrics per successful `PostJobResult`
  (`externalPostId`); **each platform differs and some are infeasible/paywalled** — REVISED: **X**
  needs paid API tiers; **GBP** has no reliable per-post insight API; **LinkedIn** personal-profile
  shares expose little (org posts differ). Many need **extra OAuth scopes → a reconnect prompt**.
  **Start with YouTube** (mature Analytics API), then evaluate per platform.
- Note: `PostJobResult.socialConnection` is `onDelete: Cascade`, so disconnecting/replacing a
  connection deletes historical results — which will erode analytics. Consider decoupling metrics
  from the connection (store platform + externalPostId on the metric) so history survives a
  reconnect.
- **UI:** metrics on Activity detail + a dashboard summary (dataviz conventions). **Effort:** XL.
  **Open decision:** platform order + scope expansion (§8 #5).

---

## 8. Cross-cutting: engineering health (parallel track, start early)

- **Error monitoring + structured logging (high payoff).** The app is debugged via `console.log`
  in production — exactly why the reviews `invalid_grant` was hard to see. Integrate **Sentry**
  (`@sentry/nextjs`, client+server+Inngest; `SENTRY_DSN` env) + a thin structured logger; capture
  the standardized COR-3 error codes. **Effort:** M.
- **Durable OAuth fix:** publish the Google OAuth consent screen to Production (§5). **Ops.**
- **Dependency majors** (deferred UX-5): Prisma 6→7, Next bump, next-auth, eslint 9→10, TS 5→6 —
  one at a time, CI-gated. **Effort:** M–L.
- **Tests:** Playwright E2E for the core flows; unit coverage for every new endpoint (esp. the
  retry idempotency guard and the cron claim logic). **Effort:** M, ongoing.

### Open decisions for the owner
1. **Media retention** (Phase 1): keep media indefinitely (higher Blob cost) vs. sweep after N
   days (suggest 30). Confirm **user-uploaded library items are exempt** from age-sweeping
   (recommended) so the library isn't self-deleting.
2. **Delete semantics:** soft-delete (recommended — cascade would wipe post history) vs. hard.
3. **Scheduling timezone:** browser-local only (v1) vs. a per-user timezone setting.
4. **Notification channel:** Resend vs. Postmark vs. reuse push.
5. **Analytics:** which platforms (YouTube first), and whether extra-scope reconnects are
   acceptable — noting X/GBP/LinkedIn per-post metrics are limited or paywalled.

---

## 9. Phasing & sequencing (dependency-ordered)

Each phase = one reviewed PR, same delegate-and-review model as the prior programs (Fable
orchestrates + integrates; Opus for the subtle/foundational work — the Phase-1 media lifecycle,
the scheduling cron/run-time-results correctness, analytics — and per-phase adversarial review;
Sonnet for CRUD endpoints + UI; worktree isolation).

| # | Phase | Depends on | Effort (REVISED) | Value |
|---|-------|-----------|--------|-------|
| 1 | Media lifecycle & retention (foundation) | — | M/L | Unblocks 2–4 |
| 2 | Media delete + reuse | 1 | S–M | High (obvious gap) |
| 3 | Retry failed platform | 1 | M/L | High |
| 4 | Connection health / reconnect flag | — | S/M | High (live pain) |
| 5 | Scheduling + drafts (flagship) | **1** (draft blobs need the sweep) | L/XL | Highest differentiator |
| 6 | Notifications | (accompany 5) | M | Medium-high w/ scheduling |
| 7 | Per-platform preview | — | M | Polish |
| 8 | Analytics (start YouTube) | — | XL | Medium, heavy |
| H | Health: Sentry+logging, OAuth publish, deps, E2E | — | M–L | Foundational |

**Recommended order:** Phase 1 → (2, 3, 4 quick-wins batch, mostly parallel) → 5 **+ 6 together**
→ 7 → 8, with **H (Sentry + OAuth publish)** running in parallel from the start.

## 10. Risks & non-goals
- **Storage cost** is the main new cost driver (Phase 1); quantify against Vercel Blob pricing
  before choosing N and the library-exemption policy.
- **Scheduling correctness** hinges on run-time result creation (§6.3) and the cron claim being
  atomic — the two things the first draft got wrong; they are the review targets for that phase.
- **Per-platform analytics** is the biggest unknown (each API + scopes differ, some infeasible);
  scope it as its own initiative.
- **Non-goals (v1):** recurring/repeating posts, team/multi-user accounts, bulk CSV import,
  in-app media editing.
</content>
