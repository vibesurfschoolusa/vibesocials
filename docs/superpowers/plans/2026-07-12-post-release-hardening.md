# Post-Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the fresh-eyes review's follow-ups — member-safe roster, DTO the raw-row echoes, rate-limit unguarded mutations, a11y loading announcements (PR-2), plus E2E platform/blob doubles (PR-3).

**Architecture:** PR-2 = four additive hardening tasks on `feat/workspace-hardening` (branched from `main` @ 5d837e6), no schema changes, all inside existing route/DTO/rate-limit conventions. PR-3 = env-seam test doubles on the existing `chore/e2e-ci-wiring` branch. Spec: `docs/superpowers/specs/2026-07-12-post-release-hardening-design.md`.

**Tech Stack:** Next.js 16 App Router route handlers, Prisma (mocked in route tests), Vitest, Tailwind v4 tokens, Playwright (PR-3 only).

## Global Constraints

- ⚠️ `app/.env.local` points at the PRODUCTION database/blob store. NEVER run `npm run dev`, `next dev`, `npm run start`, `prisma migrate dev/deploy`, `prisma db *`, or any script that imports `src/lib/db.ts`. Never modify `app/.env.local`.
- Safe commands only: `npx vitest run`, `npm run lint`, `npm run build`, `npx tsc --noEmit`, `npx prisma validate/generate`, offline `npx prisma migrate diff` (schema-to-schema).
- Gate at every task boundary (run from `app/`): `npx vitest run` all green (586 baseline, grows), `npm run lint` 0 errors (10 pre-existing warnings allowed), `npm run build` clean, `npx tsc --noEmit` 0.
- SEC-1 DTO discipline: display fields only — never tokens/tokenHash/raw metadata/full emails cross-member.
- Sentence-case UI copy. Vitest globs `src/**/*.test.ts` only (no component tests).
- Route tests mock `@/lib/workspace` + `@/lib/db` via `vi.hoisted` + `vi.mock` BEFORE importing the route (copy `src/app/api/workspaces/members/route.test.ts`).
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Do NOT push, merge, or open PRs from implementer tasks — the orchestrator does that.

---

### Task B: Member-safe roster endpoint + MemberView list

**Files:**
- Create: `app/src/app/api/workspaces/members/roster/route.ts`
- Create: `app/src/app/api/workspaces/members/roster/route.test.ts`
- Modify: `app/src/components/team-section.tsx` (MemberView, ~lines 61-122, and its stale doc comment)

**Interfaces:**
- Consumes: `getWorkspaceContext()` from `@/lib/workspace` (any role; null → 401), `prisma.workspaceMember.findMany` from `@/lib/db`.
- Produces: `GET /api/workspaces/members/roster` → 200 `{ members: Array<{ name: string; role: "owner" | "member" }> }` (ordered joinedAt asc), 401 unauth. Task E consumes MemberView's new loading state.

- [ ] **Step 1: Write the failing route test** — `app/src/app/api/workspaces/members/roster/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// workspaces/members/route.test.ts). route.ts imports `@/lib/db` and
// `@/lib/workspace` at module scope, so both must be mocked before the
// route is imported below.
const { findManyMock, getWorkspaceContextMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  getWorkspaceContextMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { workspaceMember: { findMany: findManyMock } },
}));

vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
}));

import { GET } from "./route";

const MEMBER_CONTEXT = {
  user: { id: "user-2", email: "member@example.com", name: "Member Two" },
  workspace: { id: "ws-1", name: "Acme", companyWebsite: null, defaultHashtags: null },
  role: "member" as const,
  memberCount: 2,
};

beforeEach(() => {
  findManyMock.mockReset();
  getWorkspaceContextMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(MEMBER_CONTEXT);
});

describe("GET /api/workspaces/members/roster", () => {
  it("401s when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("returns names-only roster for a member, ordered by join date", async () => {
    findManyMock.mockResolvedValue([
      { role: "owner", user: { name: "Owner", email: "owner@example.com" } },
      { role: "member", user: { name: null, email: "pat.doe@example.com" } },
    ]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      members: [
        { name: "Owner", role: "owner" },
        { name: "pat.doe", role: "member" }, // email local-part fallback (posts/route.ts rule)
      ],
    });
    expect(findManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    });
  });

  it("never leaks emails or user ids (SEC-1)", async () => {
    findManyMock.mockResolvedValue([
      { role: "member", user: { name: null, email: "secret.person@example.com" } },
    ]);
    const response = await GET();
    const raw = JSON.stringify(await response.json());
    expect(raw).not.toContain("@example.com");
    expect(raw).not.toContain("email");
    expect(raw).not.toContain("userId");
  });

  it("works for owners too (any-member endpoint)", async () => {
    getWorkspaceContextMock.mockResolvedValue({ ...MEMBER_CONTEXT, role: "owner" });
    findManyMock.mockResolvedValue([]);
    const response = await GET();
    expect(response.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it — must FAIL** (`Cannot find module './route'`): `cd app && npx vitest run src/app/api/workspaces/members/roster`

- [ ] **Step 3: Implement** `app/src/app/api/workspaces/members/roster/route.ts`:

```ts
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";

/**
 * GET /api/workspaces/members/roster
 *
 * Member-safe roster (design §7 "member view: names only"): any member of
 * the active workspace gets display names + roles — NEVER emails or user
 * ids (SEC-1; the owner-only GET /api/workspaces/members is the full
 * variant). `name` falls back to the email local-part with the exact
 * post-attribution rule (see GET /api/posts createdBy), so both surfaces
 * show the same label for the same person; the full email never leaves
 * the server on this route.
 */
export async function GET() {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const memberships = await prisma.workspaceMember.findMany({
    where: { workspaceId: context.workspace.id },
    include: { user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    members: memberships.map((membership) => ({
      name: membership.user.name ?? membership.user.email.split("@")[0],
      role: membership.role,
    })),
  });
}
```

- [ ] **Step 4: Run test again — must PASS**; then run the FULL vitest suite (must stay green, count grows by 4).

- [ ] **Step 5: Wire MemberView** (`app/src/components/team-section.tsx`): add a roster fetch + list to `MemberView`, mirroring `OwnerView`'s members effect (cancelled flag, error boolean, loading skeleton). Replace the stale "no member-safe endpoint exists" doc comment (lines ~61-73) — keep its Task-8 leave note. Render between the explanatory line and the Leave block:

```tsx
interface RosterEntry {
  name: string;
  role: WorkspaceRole;
}

// inside MemberView:
const [roster, setRoster] = useState<RosterEntry[] | null>(null);
const [rosterLoading, setRosterLoading] = useState(true);
const [rosterError, setRosterError] = useState(false);

useEffect(() => {
  let cancelled = false;
  (async () => {
    try {
      const response = await fetch("/api/workspaces/members/roster");
      const data = (await response.json().catch(() => null)) as
        | { members: RosterEntry[] }
        | null;
      if (!cancelled) {
        if (response.ok && data) setRoster(data.members);
        else setRosterError(true);
      }
    } catch {
      if (!cancelled) setRosterError(true);
    } finally {
      if (!cancelled) setRosterLoading(false);
    }
  })();
  return () => {
    cancelled = true;
  };
}, []);
```

List markup (names + role badge only — no email line, no Remove):

```tsx
<div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
  <h4 className="text-sm font-medium text-foreground">Members</h4>
  {rosterLoading ? (
    <div className="flex flex-col gap-2" aria-hidden>
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  ) : rosterError ? (
    <p className="text-sm text-muted-foreground">Couldn&apos;t load members. Try reloading the page.</p>
  ) : roster && roster.length > 0 ? (
    <ul className="divide-y divide-border">
      {roster.map((entry, index) => (
        <li key={`${entry.name}-${index}`} className="flex items-center justify-between gap-3 py-2">
          <p className="truncate text-sm text-foreground">{entry.name}</p>
          <Badge variant={entry.role === "owner" ? "default" : "secondary"}>
            {entry.role === "owner" ? "Owner" : "Member"}
          </Badge>
        </li>
      ))}
    </ul>
  ) : null}
</div>
```

- [ ] **Step 6: Full gate** (vitest / lint / build / tsc from `app/`).

- [ ] **Step 7: Commit** `feat(workspace): member-safe roster endpoint + MemberView list`.

---

### Task C: DTO the raw-row echoes

**Files:**
- Modify: `app/src/app/api/media/route.ts:103` (POST response)
- Modify: `app/src/app/api/media/route.test.ts` (POST assertions)
- Modify: `app/src/lib/postsDto.ts` (add detail DTOs + mappers)
- Modify: `app/src/app/api/posts/[postJobId]/route.ts:39-68` (GET)
- Modify: `app/src/app/api/posts/[postJobId]/route.test.ts`
- Modify: `app/src/app/api/posts/route.ts:522-537` (POST create response)
- Modify: `app/src/app/api/posts/route.test.ts`

**Interfaces:**
- Consumes: `toMediaItemDto` (`@/lib/mediaDto`, exists). UI contracts that must keep working: `media-library.tsx` `CreateResponse = { mediaItem: MediaItemDto }`; `create-post-form.tsx` `PostResponse = { postJob: { id, status } }` + top-level `message`. GET `/api/posts/[postJobId]` has zero UI callers.
- Produces (in `postsDto.ts`, exact names for tests/readers):

```ts
/** Display-safe single-job projection for GET /api/posts/[postJobId] and the POST /api/posts echo. */
export interface PostJobDetailDTO {
  id: string;
  status: PostJobStatus;
  createdAt: string;            // ISO
  scheduledFor: string | null;  // ISO
  baseCaption: string | null;
  perPlatformOverrides: Prisma.JsonValue | null;
  mediaItemId: string;
}
export interface PostJobResultSummaryDTO {
  platform: Platform;
  status: PostJobResultStatus;
  externalPostId: string | null;
  errorMessage: string | null;
}
export function toPostJobDetailDto(job: PostJob): PostJobDetailDTO
export function toPostJobResultSummaryDto(result: PostJobResult): PostJobResultSummaryDTO
```

- [ ] **Step 1: Failing tests first.** In `media/route.test.ts`, change the POST success expectation to the DTO shape and add negatives; key assertions:

```ts
const body = await response.json();
expect(body.mediaItem).toMatchObject({ id: "media-1", storageLocation: "https://blob/x" });
const raw = JSON.stringify(body);
expect(raw).not.toContain("userId");
expect(raw).not.toContain("workspaceId");
expect(raw).not.toContain("deletedAt");
```

In `posts/[postJobId]/route.test.ts` + `posts/route.test.ts` (create path), assert the projected shapes and the negatives:

```ts
const raw = JSON.stringify(body);
expect(raw).not.toContain("socialConnectionId");
expect(raw).not.toContain("workspaceId");
expect(raw).not.toContain('"userId"');
expect(raw).not.toContain("publishMetadata");
expect(body.postJob.createdAt).toBe(jobRow.createdAt.toISOString());
```

(Adapt each file's existing mock-row fixtures — give them the full raw-row fields incl. `userId`/`workspaceId`/`socialConnectionId`/`publishMetadata` so the negatives actually bite.) Run: targeted vitest — the new/changed assertions FAIL against the raw echoes.

- [ ] **Step 2: `POST /api/media`** — replace `NextResponse.json({ mediaItem }, { status: 201 })` with:

```ts
// SEC-1 (post-release review Task C): echo the display DTO, not the raw
// row — the raw MediaItem carries userId/workspaceId/metadata/deletedAt,
// none of which the client needs (media-library already types this
// response as MediaItemDto).
return NextResponse.json({ mediaItem: toMediaItemDto(mediaItem) }, { status: 201 });
```

- [ ] **Step 3: Add mappers to `postsDto.ts`** (import `type { Platform, PostJob, PostJobResult, PostJobResultStatus, PostJobStatus, Prisma } from "@prisma/client"`):

```ts
export function toPostJobDetailDto(job: PostJob): PostJobDetailDTO {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt.toISOString(),
    scheduledFor: job.scheduledFor?.toISOString() ?? null,
    baseCaption: job.baseCaption,
    perPlatformOverrides: job.perPlatformOverrides,
    mediaItemId: job.mediaItemId,
  };
}

export function toPostJobResultSummaryDto(result: PostJobResult): PostJobResultSummaryDTO {
  return {
    platform: result.platform,
    status: result.status,
    externalPostId: result.externalPostId,
    errorMessage: result.errorMessage,
  };
}
```

Doc-comment both: dropped fields (`userId`, `workspaceId`, `publishMetadata`, `updatedAt`; results: `id`, `postJobId`, `socialConnectionId`, `errorCode`, timestamps) and why `mediaItemId` stays (reuse handle already public via /api/media + `/posts/new?mediaItemId=`).

- [ ] **Step 4: Apply in both routes.** `[postJobId]/route.ts` GET → `NextResponse.json({ postJob: toPostJobDetailDto(postJob), results: results.map(toPostJobResultSummaryDto) }, { status: 200 })`. `posts/route.ts` POST → `NextResponse.json({ postJob: toPostJobDetailDto(postJob), results: results.map(toPostJobResultSummaryDto), message })` — note `postJob` from `findUnique` may be `null` in theory; keep the existing behavior by guarding: if `!postJob` return the same `{ postJob: null, results: [], message }` envelope (assert what the current code does with tests before changing anything here — today it would serialize `null` fields; preserve envelope keys).

- [ ] **Step 5: Full vitest — green.** Step 6: **Full gate.** Step 7: **Commit** `fix(api): project media/post-job echoes to display DTOs (SEC-1)`.

---

### Task D: Rate-limit the unguarded mutations

**Files:**
- Modify: `app/src/app/api/workspaces/switch/route.ts` (+ its `route.test.ts`)
- Modify: `app/src/app/api/workspaces/leave/route.ts` (+ its `route.test.ts`)
- Modify: `app/src/app/api/invites/[token]/route.ts` (+ its `route.test.ts`)

**Interfaces:**
- Consumes: `checkRateLimit` from `@/lib/rateLimit` (existing).
- Produces: 429 envelope identical to `posts/[postJobId]`'s `enforceMutateRateLimit`: body `{ error: "Too many requests. Please slow down.", retryAfterSeconds }` + header `Retry-After`. Keys/limits: `workspaces/switch` 60/5min, `workspaces/leave` 60/5min, `invites/preview` 60/5min — all per-user.

- [ ] **Step 1: Failing tests.** In each route test file add a mocked `@/lib/rateLimit` (`vi.hoisted` `checkRateLimitMock`), then two tests (adapt per route; switch shown):

```ts
it("429s with Retry-After when the switch rate limit blocks", async () => {
  checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });
  const response = await POST(makeRequest({ workspaceId: "ws-2" }));
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("120");
  await expect(response.json()).resolves.toMatchObject({ retryAfterSeconds: 120 });
  expect(findFirstMock).not.toHaveBeenCalled(); // limited BEFORE any DB read
});

it("checks the per-user switch rate limit with the shared envelope", async () => {
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  await POST(makeRequest({ workspaceId: "ws-1" }));
  expect(checkRateLimitMock).toHaveBeenCalledWith({
    userId: "user-1",
    route: "workspaces/switch",
    limit: 60,
    windowMs: 5 * 60 * 1000,
  });
});
```

For `invites/[token]` the limited-path assertion is `findUniqueMock` (the invite lookup) not called; route key `invites/preview`. For leave: `deleteManyMock` not called; key `workspaces/leave`. IMPORTANT: every EXISTING test in these files must get `checkRateLimitMock.mockResolvedValue({ allowed: true })` in `beforeEach` — add the mock, run, watch the new tests FAIL (429 never returned).

- [ ] **Step 2: Implement.** In each route, right after the auth guard (and for `leave`, BEFORE the owner-role 400 check — the throttle is on the endpoint, not the outcome; for `invites/[token]`, after `getCurrentUser` and before `params`/token hashing):

```ts
const rateLimit = await checkRateLimit({
  userId: context.user.id, // invites route: user.id
  route: "workspaces/switch", // per route: workspaces/leave | invites/preview
  limit: 60,
  windowMs: 5 * 60 * 1000,
});
if (!rateLimit.allowed) {
  return NextResponse.json(
    { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
  );
}
```

Add a one-line comment on each citing the post-release review (Task D) + the posts/mutate precedent.

- [ ] **Step 3: Full vitest green.** Step 4: **Full gate.** Step 5: **Commit** `feat(api): per-user rate limits on workspace switch/leave + invite preview`.

---

### Task E: A11y loading announcements

**Files (7):**
- Modify: `app/src/components/team-section.tsx` (invite block ~line 312, members block ~line 359, MemberView roster from Task B)
- Modify: `app/src/components/shell/account-menu.tsx` (workspace-list skeletons ~lines 130-150)
- Modify: `app/src/components/media-library.tsx` (grid skeleton ~line 424)
- Modify: `app/src/app/activity/activity-view.tsx` (loading skeletons)
- Modify: `app/src/app/queue/queue-view.tsx` (loading skeletons)
- Modify: `app/src/components/dashboard/recent-activity.tsx` (~line 59)
- Modify: `app/src/components/dashboard/connection-health.tsx` (~line 45)

**Interfaces:** none — presentation-only. Pattern (matches ui/spinner.tsx's labeled `role="status"` convention):

- [ ] **Step 1:** For each loading branch that renders `aria-hidden` skeletons, add an adjacent sr-only polite announcement INSIDE the same conditional (rendered only while loading), e.g. team-section members block:

```tsx
{membersLoading ? (
  <>
    <p role="status" className="sr-only">Loading members…</p>
    <div className="flex flex-col gap-2" aria-hidden>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  </>
) : ...}
```

Copy per region (sentence case): "Loading members…" (team-section members + MemberView roster), "Loading invite link…" (invite block), "Loading workspaces…" (account-menu), "Loading media library…" (media-library), "Loading activity…" (activity-view), "Loading queue…" (queue-view), "Loading recent posts…" (recent-activity), "Loading connection health…" (connection-health). Do NOT restructure any markup beyond wrapping the conditional's children in a fragment; do NOT touch non-loading `aria-hidden` uses (icons, avatars).

- [ ] **Step 2:** `npm run lint` + `npm run build` + `npx tsc --noEmit` + full vitest (no component tests exist; suite must simply stay green).

- [ ] **Step 3: Commit** `fix(a11y): announce loading states alongside aria-hidden skeletons`.

**Accepted remainder (log in ledger, do not fix):** `create-post-form.tsx:798` connections skeleton, `join/[token]/join-view.tsx` — outside the brief's surfaces.

---

### Task F (PR-3, branch `chore/e2e-ci-wiring`): light up the gated E2E flows

**Files (expected — implementer confirms against `app/e2e/README.md` parts 3-4 and `core-flows.spec.ts`):**
- Modify: `app/src/server/platforms/*Client.ts` — env-seam ONLY for the base-URL constants of the platforms the e2e flows exercise (e.g. `const TIKTOK_API_BASE = process.env.TIKTOK_API_BASE ?? "https://open.tiktokapis.com"` — default identical, prod behavior byte-for-byte unchanged when env unset)
- Create: `app/e2e/support/mock-platform-server.mjs` (or `.ts`) — tiny node http server standing in for the seamed platform API + the blob upload path per README part 3 option 2 / part 4
- Create: `app/e2e/support/seed.ts` (or extend spec helpers) — seeds the `SocialConnection` on the test user via `@prisma/client` against `E2E_DATABASE_URL`
- Modify: `app/playwright.config.ts` — thread the new env vars into `webServer.env`
- Modify: `.github/workflows/ci.yml` e2e job — start the mock server, set `E2E_STUBS_READY: "1"` + seam env vars ONLY for the flows whose doubles are real
- Modify: `app/e2e/README.md` — document what was built

**Hard rules:** (1) NO fake green — if a double isn't ready for a flow, that flow STAYS skipped and the README says why. (2) Platform-client changes must be inert without the env vars (defaults identical; grep-prove no other behavior change). (3) The blob double: study `src/app/api/upload/route.ts` (`@vercel/blob/client` `handleUpload`) + the composer's `upload()` call first; if a faithful double isn't achievable without hacking product code, leave the upload-dependent flows skipped and say so — that is an acceptable, honest outcome. (4) Local execution only if a throwaway Postgres exists (Docker); otherwise the gate for this task = tsc/lint/build/vitest + Playwright's own `--list` parse, and CI validates the rest after push. (5) Do not touch `next.config`, `src/lib/db.ts`, or auth.

Steps: read README parts 3-4 + `core-flows.spec.ts` stub expectations → seam the client(s) with tests proving default-URL behavior unchanged (unit-test the seam: set env in test, assert the client hits the override; existing platform client tests keep passing) → build the mock server against the exact request sequence the client makes (init/upload/status for TikTok per `tiktokClient.ts`) → seed helper → wire config/CI → full gate → commit(s) on `chore/e2e-ci-wiring`.

---

## Self-review

- Spec coverage: §1→Task B, §2→Task C, §3→Task D, §4→Task E, §5 flagged-not-implemented (no task, by design), §6 gate embedded globally. PR-1 executed separately (already committed as 1adf74f on chore/deps-security).
- No placeholders; exact paths; code blocks for every code step; types in Task C's Interfaces block match its steps.
- Task boundaries: B and E both touch team-section.tsx → B before E, sequential. C and D touch disjoint routes but share posts route-test files? No — D touches switch/leave/invites tests only; C touches media/posts tests only. Disjoint, but run sequentially anyway (shared checkout).
