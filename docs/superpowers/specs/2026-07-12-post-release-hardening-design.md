# Post-release hardening — design (workspace hygiene + a11y)

**Source:** Independent post-release review 2026-07-12 (`.superpowers/sdd/progress.md`, final section).
All items below were surfaced by that review as non-blocking follow-ups; the owner-approved brief
pre-specifies their direction. This brainstorm was run in autonomous mode: each open question was
settled from the brief, the team-workspaces spec (§1 permission matrix), and existing codebase
conventions — alternatives considered are recorded per section. Anything genuinely owner-shaped is
**flagged, not implemented** (see §5).

Scope = PR-2 (`feat/workspace-hardening`). PR-1 (deps bump + index-drop migration) and PR-3 (E2E
stubs, branch `chore/e2e-ci-wiring`) are tracked in the plan but need no product design.

## 1. Task B — member-safe roster endpoint + MemberView list

**Problem.** Spec §7 says members see "the member list (names only)", but the only members endpoint
(`GET /api/workspaces/members`) is owner-only because it returns emails (SEC-1). The Task 7
implementer correctly refused to widen it (API was frozen for that task) and shipped `MemberView`
with no roster — a documented design-vs-API gap.

**Approaches considered.**
1. Role-conditional projection inside the existing `/members` route — rejected: one route serving
   two shapes is a SEC-1 hazard (a refactor away from leaking emails to members) and breaks the
   route's documented owner-only contract.
2. **New additive `GET /api/workspaces/members/roster` (chosen)** — any-member read, names-only by
   construction; the owner route stays byte-identical.
3. Folding a roster into `GET /api/workspaces` (switcher payload) — rejected: that endpoint lists
   the *caller's memberships across workspaces*, not *members of one workspace*; different
   cardinality, and it would fatten a hot path every shell render.

**Contract.**
- `GET /api/workspaces/members/roster` — auth = `getWorkspaceContext()` (any role). 401 unauth.
- 200 `{ members: Array<{ name: string; role: "owner" | "member" }> }`, ordered by membership
  `createdAt` asc (same ordering as `/members`).
- `name` = `user.name ?? email local-part` — the exact post-attribution rule
  (`src/app/api/posts/route.ts:171`), including its `??` semantics (an empty-string name passes
  through, matching attribution display).
- **Not** in the payload: `userId`, `email`, `joinedAt`. Strict "names only" (spec §1/§7); the
  member UI needs nothing else, and a smaller surface is the point of the endpoint.
- Routing note: `members/roster` is a static segment, which Next resolves ahead of the sibling
  dynamic `members/[userId]`; `[userId]` values are cuids, so no collision is possible.
- No rate limit: cheap, tenant-scoped read, consistent with `GET /api/workspaces`.

**UI.** `MemberView` (src/components/team-section.tsx) fetches the roster on mount (same
effect/cancelled pattern as `OwnerView`'s members fetch): skeleton while loading, muted
"Couldn't load members." line on failure, then a list of name + role `Badge` (Owner/Member) rows
styled like `OwnerView`'s list minus email/Remove. The workspace name, "Only the workspace owner
can manage members." line, and Leave button stay as they are.

**Tests.** Route tests (mock `@/lib/workspace` + `@/lib/db`, copied from an existing
`route.test.ts`): 401 unauthenticated; 200 for member role; SEC-1 negative assertion — the
serialized response contains **no `email`/`userId` keys**; local-part fallback when `name` is
null; ordering; owner can also call it. Existing `/members` route tests untouched (owner still
sees emails).

## 2. Task C — DTO the raw-row echoes

Three responses echo raw Prisma rows (accepted-debt from WS Task 4, re-confirmed harmless —
same-tenant, no secrets — but internal-shape): fix = project them.

- **`POST /api/media` 201** → `{ mediaItem: toMediaItemDto(created) }` (`src/lib/mediaDto.ts`).
  The only consumer (`media-library.tsx` `CreateResponse`) already *types* the response as
  `MediaItemDto` — today's raw row leaks `userId`/`workspaceId`/`metadata`/`deletedAt` on the wire.
- **`GET /api/posts/[postJobId]` 200** and **`POST /api/posts` 200** → shared projection helpers
  in `src/lib/postsDto.ts`:
  - postJob → `{ id, status, createdAt: ISO, scheduledFor: ISO|null, baseCaption, perPlatformOverrides, mediaItemId }`.
    **Dropped:** `userId`, `workspaceId`, `publishMetadata` (raw JSON snapshot), `updatedAt`.
    `mediaItemId` is retained deliberately: it is the reuse handle the composer/library already
    trade in URLs (`/posts/new?mediaItemId=…`) and same-tenant-visible via `/api/media` — unlike
    `socialConnectionId`, it is not internal wiring.
  - each result → `{ platform, status, externalPostId, errorMessage }` (the `GET /api/posts` list
    shape minus the metric join, which neither endpoint performs).
    **Dropped:** `id`, `postJobId`, `socialConnectionId`, `errorCode`, `createdAt`, `updatedAt`.
  - `POST /api/posts` keeps its envelope `{ postJob, results, message }`.
- **Consumers verified (this session):** `media-library.tsx` types `CreateResponse` as
  `{ mediaItem: MediaItemDto }`; `create-post-form.tsx`'s `PostResponse` reads only
  `postJob.{id,status}` + top-level `message`/`error`; `GET /api/posts/[postJobId]` has **zero UI
  callers** (queue-view's fetch to that path is the PATCH). Activity/queue ride `GET /api/posts`,
  which is already DTO'd. E2E specs drive the UI, not these response bodies.
- **Tests:** update route tests to the projected shapes + negative assertions (no
  `workspaceId`/`userId`/`socialConnectionId`/`publishMetadata` keys in the JSON).

## 3. Task D — rate-limit the unguarded mutations

`checkRateLimit` (src/lib/rateLimit.ts, DB fixed-window, fails open) added right after auth,
before body parse/DB reads — same placement as `POST /api/posts` and the ledger-ratified
"rate-limit-before-validation" pattern. Per-user keys, mirroring the posts/mutate envelope
(60 req / 5 min; 429 body `{ error: "Too many requests. Please slow down.", retryAfterSeconds }`
+ `Retry-After` header):

| Route | key |
| --- | --- |
| `POST /api/workspaces/switch` | `workspaces/switch` |
| `POST /api/workspaces/leave` | `workspaces/leave` |
| `GET /api/invites/[token]` (preview) | `invites/preview` |

Accept stays at its existing tighter 10/5min. Preview at 60/5min is defense-in-depth + parity —
brute-forcing 256-bit tokens is infeasible regardless (review's own framing).

**Tests:** mock `@/lib/rateLimit` per existing route-test convention; assert blocked → 429 +
`Retry-After`, allowed → normal path, and the exact `{ userId, route, limit, windowMs }` args.

## 4. Task E — a11y loading announcements

`aria-hidden` skeletons (ui/skeleton.tsx is aria-hidden by design) leave screen-reader users with
silence during loads. Minimal app-consistent fix, matching the Spinner primitive's labeled
`role="status"` convention: alongside each skeleton block, render **while loading only**:

```tsx
<p role="status" className="sr-only">Loading members…</p>
```

(`role="status"` implies `aria-live="polite"`; appearing with the skeletons is announced politely.)

**Sites (7 files):** `team-section.tsx` (invite block, members block, + Task B's new MemberView
roster), `shell/account-menu.tsx` (workspace list), `media-library.tsx` (grid),
`app/activity/activity-view.tsx`, `app/queue/queue-view.tsx`, `dashboard/recent-activity.tsx`,
`dashboard/connection-health.tsx`. Copy is sentence case and specific per region ("Loading
members…", "Loading workspaces…", "Loading media library…", "Loading activity…", "Loading
queue…", "Loading recent posts…", "Loading connection health…", "Loading invite link…").

**Accepted remainder (logged, not fixed here):** `create-post-form.tsx` connections skeleton and
`join/[token]/join-view.tsx` — outside the brief's named surfaces; same pattern applies if the
owner wants a follow-up sweep.

No new tests (vitest globs `src/**/*.test.ts` only — no component harness in this repo);
verified by lint/build/tsc + adversarial review of the rendered structure.

## 5. Flagged for owner — NOT implemented

**Invite token in the URL path** (`/join/<raw-token>`; review Minor). Raw tokens ride request
paths into server/CDN access logs. Already mitigated: 256-bit entropy, SHA-256 at rest, 7-day
expiry, revoke + single-active policy, accept rate-limited (and preview rate-limited after Task
D). Owner option if wanted later: move the token to the URL **fragment** (`/join#<token>` — links
stay shareable, fragments never reach server logs) with the join page reading `location.hash` and
POSTing the token in the body for preview + accept. Cost: join page becomes client-resolved, both
invite route signatures + tests + copy change. Decide separately; nothing here blocks it.

## 6. Gate

Every task boundary: `npx vitest run` all green (count grows), `npm run lint` 0 errors,
`npm run build` clean, `npx tsc --noEmit` 0. TDD for B/C/D (route tests written RED first).
Task E has no test surface (see §4) — reviewed instead.
