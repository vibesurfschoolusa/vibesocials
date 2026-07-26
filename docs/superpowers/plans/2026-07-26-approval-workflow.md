# Approval Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a workspace turns on "require approval", posts created by MEMBERS are held for an OWNER to approve before anything publishes; owners approve or reject from the Queue, and both parties are emailed.

**Architecture:** Additive only — no new `PostJobStatus`. A held post is an ordinary `draft` carrying `submittedForApprovalAt` (plus its intended `scheduledFor`, preserved so approval can honor the member's chosen time). `Workspace.requireApproval` gates it. All decisions are pure rules in `lib/approval.ts` (table-driven tests). Approval reuses the existing promote paths: future `scheduledFor` → `status: scheduled`; otherwise publish now via the same `prepareDeferredPostJobDispatch` + `inngest.send` the publish route uses. Rejection reuses `cancelled`.

**Tech Stack:** Prisma migration, Next route handlers, React client components, Vitest. Emails through the existing fail-safe `sendEmail` with pure builders (the `reconnectEmail.ts` pattern).

## Global Constraints

- **No new `PostJobStatus` enum value.** The schema comment warns that any addition breaks every exhaustive `Record<PostJobStatus, …>` (`JOB_STATUS_META`) and every status set (`MUTABLE_/DELETABLE_/STALE_ELIGIBLE_`). Held posts are `draft` + `submittedForApprovalAt != null`.
- Migrations auto-apply on prod deploy (PR #27). Additive columns only; every new column nullable or defaulted, so a rollback cannot lose data.
- Owner gate is `getWorkspaceContext({ requireRole: "owner" })` / `requireOwnerContext()` — never a hand-rolled role check.
- Route params: `const { x } = await Promise.resolve(context.params);` and route-test fixtures MUST resolve a promise (see the PR #41 lesson).
- `sendEmail` never throws; email failures must never fail an approve/reject/create request.
- Members must NOT be able to approve; owners approving their OWN submission is allowed (a solo owner is unaffected by the flag — the gate only holds MEMBER-created posts).
- Commit style `<type>(scope): summary` + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; one PR per task.

---

### Task 1: Schema + pure approval rules

**Files:**
- Modify: `app/prisma/schema.prisma` (Workspace + PostJob)
- Create: `app/prisma/migrations/<timestamp>_approval_workflow/migration.sql` (generated)
- Create: `app/src/lib/approval.ts`
- Create: `app/src/lib/approval.test.ts`

**Interfaces:**
- Produces:
  - `shouldHoldForApproval(input: { role: "owner" | "member"; requireApproval: boolean; intent: PostJobIntent }): boolean`
  - `type ApprovalState = "none" | "pending" | "approved" | "rejected"`
  - `deriveApprovalState(job: { submittedForApprovalAt: Date | string | null; approvedAt: Date | string | null; status: PostJobStatus }): ApprovalState`
  - `canDecideApproval(input: { role: "owner" | "member"; state: ApprovalState }): boolean`
  - `approvalOutcome(job: { scheduledFor: Date | string | null }, now: Date, bufferMs: number): "schedule" | "publish_now"`
- Schema additions: `Workspace.requireApproval Boolean @default(false)`; `PostJob.submittedForApprovalAt DateTime?`, `PostJob.approvedAt DateTime?`, `PostJob.approvedByUserId String?`.

- [ ] **Step 1: Write the failing tests** — `app/src/lib/approval.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  approvalOutcome,
  canDecideApproval,
  deriveApprovalState,
  shouldHoldForApproval,
} from "./approval";

describe("shouldHoldForApproval", () => {
  it("holds a member's immediate or scheduled post when the flag is on", () => {
    expect(shouldHoldForApproval({ role: "member", requireApproval: true, intent: "immediate" })).toBe(true);
    expect(shouldHoldForApproval({ role: "member", requireApproval: true, intent: "scheduled" })).toBe(true);
  });

  it("never holds a member's own draft — a draft publishes nothing", () => {
    expect(shouldHoldForApproval({ role: "member", requireApproval: true, intent: "draft" })).toBe(false);
  });

  it("never holds an owner's post — owners are the approvers", () => {
    expect(shouldHoldForApproval({ role: "owner", requireApproval: true, intent: "immediate" })).toBe(false);
  });

  it("never holds anything when the workspace hasn't enabled approval", () => {
    expect(shouldHoldForApproval({ role: "member", requireApproval: false, intent: "immediate" })).toBe(false);
  });
});

describe("deriveApprovalState", () => {
  const D = new Date("2026-07-26T10:00:00Z");

  it("is none for a post that was never submitted", () => {
    expect(deriveApprovalState({ submittedForApprovalAt: null, approvedAt: null, status: "draft" })).toBe("none");
  });

  it("is pending while submitted, undecided, and still a draft", () => {
    expect(deriveApprovalState({ submittedForApprovalAt: D, approvedAt: null, status: "draft" })).toBe("pending");
  });

  it("is approved once approvedAt is set", () => {
    expect(deriveApprovalState({ submittedForApprovalAt: D, approvedAt: D, status: "scheduled" })).toBe("approved");
  });

  it("is rejected when a submitted, unapproved post was cancelled", () => {
    expect(deriveApprovalState({ submittedForApprovalAt: D, approvedAt: null, status: "cancelled" })).toBe("rejected");
  });

  it("accepts ISO strings (DTO/step.run serialization)", () => {
    expect(
      deriveApprovalState({
        submittedForApprovalAt: "2026-07-26T10:00:00.000Z",
        approvedAt: null,
        status: "draft",
      }),
    ).toBe("pending");
  });
});

describe("canDecideApproval", () => {
  it("lets an owner decide a pending submission", () => {
    expect(canDecideApproval({ role: "owner", state: "pending" })).toBe(true);
  });

  it("never lets a member decide", () => {
    expect(canDecideApproval({ role: "member", state: "pending" })).toBe(false);
  });

  it("refuses to re-decide something already decided or never submitted", () => {
    expect(canDecideApproval({ role: "owner", state: "approved" })).toBe(false);
    expect(canDecideApproval({ role: "owner", state: "rejected" })).toBe(false);
    expect(canDecideApproval({ role: "owner", state: "none" })).toBe(false);
  });
});

describe("approvalOutcome", () => {
  const NOW = new Date("2026-07-26T12:00:00Z");
  const BUFFER = 60_000;

  it("schedules when the member's chosen time is still comfortably ahead", () => {
    expect(approvalOutcome({ scheduledFor: "2026-07-28T09:00:00Z" }, NOW, BUFFER)).toBe("schedule");
  });

  it("publishes now when the post had no chosen time", () => {
    expect(approvalOutcome({ scheduledFor: null }, NOW, BUFFER)).toBe("publish_now");
  });

  it("publishes now when the chosen time passed while awaiting approval", () => {
    expect(approvalOutcome({ scheduledFor: "2026-07-26T11:00:00Z" }, NOW, BUFFER)).toBe("publish_now");
  });

  it("publishes now when the chosen time is inside the scheduling buffer", () => {
    expect(approvalOutcome({ scheduledFor: "2026-07-26T12:00:30Z" }, NOW, BUFFER)).toBe("publish_now");
  });
});
```

- [ ] **Step 2: Run — must FAIL** (`npx vitest run src/lib/approval.test.ts` in `app/`)

- [ ] **Step 3: Implement `app/src/lib/approval.ts`**

```typescript
import type { PostJobStatus } from "@prisma/client";

import type { PostJobIntent } from "./scheduling";

/**
 * Approval workflow (2026-07-26 plan). A held post is an ordinary `draft`
 * carrying `submittedForApprovalAt` — deliberately NOT a new PostJobStatus,
 * which would break every exhaustive Record<PostJobStatus, …> and status set
 * in the codebase (see the schema comment on PostJobStatus).
 */

/**
 * Should this newly created post be held for owner approval instead of
 * publishing/scheduling? Only a MEMBER's post that would actually go out is
 * held: an owner IS the approver, and a draft publishes nothing on its own.
 */
export function shouldHoldForApproval(input: {
  role: "owner" | "member";
  requireApproval: boolean;
  intent: PostJobIntent;
}): boolean {
  if (!input.requireApproval) return false;
  if (input.role === "owner") return false;
  return input.intent !== "draft";
}

export type ApprovalState = "none" | "pending" | "approved" | "rejected";

/** Approval state derived from the job's own columns (no extra enum). */
export function deriveApprovalState(job: {
  submittedForApprovalAt: Date | string | null;
  approvedAt: Date | string | null;
  status: PostJobStatus;
}): ApprovalState {
  if (!job.submittedForApprovalAt) return "none";
  if (job.approvedAt) return "approved";
  // Submitted, never approved, and cancelled => the owner rejected it.
  if (job.status === "cancelled") return "rejected";
  return "pending";
}

/** Only an owner may decide, and only an undecided submission. */
export function canDecideApproval(input: {
  role: "owner" | "member";
  state: ApprovalState;
}): boolean {
  return input.role === "owner" && input.state === "pending";
}

/**
 * What approving should do: honor the member's chosen time when it is still
 * far enough out, else publish immediately — a post whose slot passed while
 * awaiting approval must not silently never go out.
 */
export function approvalOutcome(
  job: { scheduledFor: Date | string | null },
  now: Date,
  bufferMs: number,
): "schedule" | "publish_now" {
  if (!job.scheduledFor) return "publish_now";
  const target = new Date(job.scheduledFor).getTime();
  if (Number.isNaN(target)) return "publish_now";
  return target >= now.getTime() + bufferMs ? "schedule" : "publish_now";
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Add the schema columns** — in `app/prisma/schema.prisma`:

In `model Workspace`, after `defaultHashtags`:

```prisma
  // Approval workflow (2026-07-26). When true, a MEMBER's post that would
  // publish or schedule is held as a `draft` + `submittedForApprovalAt` until
  // an owner approves it. Owners' own posts are never held (they approve).
  requireApproval Boolean  @default(false)
```

In `model PostJob`, after `publishMetadata`:

```prisma
  // Approval workflow (2026-07-26). Non-null = this draft is (or was) awaiting
  // owner approval; `approvedAt`/`approvedByUserId` record the decision. A
  // submitted-but-unapproved job that ends `cancelled` was REJECTED. Derived
  // by lib/approval.ts deriveApprovalState() — deliberately NOT a new
  // PostJobStatus (see the enum's comment).
  submittedForApprovalAt DateTime?
  approvedAt             DateTime?
  approvedByUserId       String?
```

Then, still inside `model PostJob`, add an index for the owner's pending-approval query:

```prisma
  @@index([workspaceId, submittedForApprovalAt])
```

- [ ] **Step 6: Generate + apply the migration locally**

Run in `app/`:
```bash
npx prisma migrate dev --name approval_workflow --create-only
```
Then inspect the generated SQL — it must be only `ALTER TABLE ... ADD COLUMN` + `CREATE INDEX`, no drops. Apply with `npx prisma migrate dev` (or `npx prisma generate` if no local DB is available — CI's e2e job runs `migrate deploy` against its throwaway Postgres and will fail loudly if the SQL is wrong).

- [ ] **Step 7: Verify** — `npx prisma generate`, `npm test` (all green), `npx tsc --noEmit`, `npx eslint .`

- [ ] **Step 8: Commit + PR** — branch `feat/approval-rules`, `feat(approval): schema + pure approval rules`, CI green (the e2e job proves the migration applies), squash-merge.

---

### Task 2: Hold members' posts + owner toggle

**Files:**
- Modify: `app/src/app/api/posts/route.ts` (hold on create)
- Modify: `app/src/app/api/settings/route.ts` (owner-only `requireApproval` toggle)
- Modify: `app/src/app/api/settings/route.test.ts`
- Modify: `app/src/app/api/posts/route.test.ts`
- Modify: `app/src/app/settings/*` (the settings form — find the workspace-settings section)
- Create: `app/src/server/notifications/approvalEmail.ts`
- Create: `app/src/server/notifications/approvalEmail.test.ts`

**Interfaces:**
- Consumes from Task 1: `shouldHoldForApproval`.
- Produces: `buildApprovalRequestedEmail({ memberName, workspaceName, caption, appBaseUrl })` and `buildApprovalDecisionEmail({ approved, workspaceName, caption, appBaseUrl })`, each `→ { subject, html }`.

- [ ] **Step 1: Read `app/src/app/api/settings/route.ts`** to learn its validation shape and whether it already separates owner-only fields (`companyWebsite`/`defaultHashtags` are workspace-level). Mirror that exact pattern for `requireApproval` (boolean, owner-only via `requireOwnerContext()`).

- [ ] **Step 2: Write the failing settings test** (in `settings/route.test.ts`, matching its existing style): a member PATCHing `requireApproval` gets 403; an owner gets 200 and the workspace update includes `requireApproval: true`. Run — must FAIL.

- [ ] **Step 3: Implement the settings field.** Validate `typeof value === "boolean"`; write to the workspace row inside the existing owner-gated branch.

- [ ] **Step 4: Write the failing create-hold test** in `posts/route.test.ts`: with workspace `requireApproval: true` and context role `member`, `POST /api/posts` with `scheduledFor` in the future creates the job with `status: "draft"`, `submittedForApprovalAt` set, `scheduledFor` PRESERVED, and **no `inngest.send`**; the response says it is awaiting approval (`{ awaitingApproval: true }`). Same call as `owner` → unchanged behavior (scheduled, no `submittedForApprovalAt`). Run — must FAIL.

- [ ] **Step 5: Implement the hold in `posts/route.ts`.** After the intent resolution block (~line 468–482), insert:

```typescript
  // Approval workflow: a member's publish/schedule is held as a draft for an
  // owner to approve. The chosen `scheduledFor` is PRESERVED on the row so
  // approving can honor it (lib/approval.ts approvalOutcome).
  const heldForApproval = shouldHoldForApproval({
    role: context.role,
    requireApproval: context.workspace.requireApproval,
    intent,
  });
  const effectiveIntent: PostJobIntent = heldForApproval ? "draft" : intent;
```

Then use `effectiveIntent` everywhere `intent` was passed to the create helpers, and write `submittedForApprovalAt: new Date()` + the preserved `scheduledFor` on the created job (a small `prisma.postJob.update` right after creation is acceptable and keeps the create helpers untouched — note in a comment that the helper zeroes `scheduledFor` for the draft intent, which is why it is re-applied here). Gate the `inngest.send` on `!heldForApproval && intent === "immediate"`, and extend the response message/flags. NOTE: `context.workspace` must expose `requireApproval` — add it to the projection in `lib/workspace.ts`'s `getWorkspaceContext` return (and its `WorkspaceContext` type) as part of this step.

- [ ] **Step 6: Email builders (TDD).** Write `approvalEmail.test.ts` first, asserting: subject names the workspace for the request mail and the decision word for the decision mail; HTML escapes the caption; `appBaseUrl` null renders no `<a>`; the decision mail differs for approved vs rejected. Run (FAIL), implement `approvalEmail.ts` mirroring `reconnectEmail.ts` exactly (same escaper, same trailing-slash trim), run (PASS).

- [ ] **Step 7: Send on submit** — in `posts/route.ts`, after a held create, fire-and-forget owner notifications: look up `workspaceMember` where `role: "owner"`, `select: { user: { select: { email: true } } }`, and `await sendEmail({ to, ...buildApprovalRequestedEmail(...) })` in a try/catch that swallows (sendEmail already never throws; the try/catch documents that a mail failure must not fail the create).

- [ ] **Step 8: Settings UI** — add an owner-only "Require approval for members' posts" checkbox to the workspace settings form, wired to the same PATCH the other workspace fields use, with helper text: "Members' posts wait for your approval before publishing. Your own posts are unaffected."

- [ ] **Step 9: Verify** — `npm test`, `npx tsc --noEmit`, `npx eslint .`, `npm run build`.

- [ ] **Step 10: Commit + PR** — branch `feat/approval-hold`, `feat(approval): hold members' posts and add the owner toggle`, CI green, squash-merge.

---

### Task 3: Approve / reject API + Queue UI + prod verification

**Files:**
- Create: `app/src/app/api/posts/[postJobId]/approval/route.ts`
- Create: `app/src/app/api/posts/[postJobId]/approval/route.test.ts`
- Modify: `app/src/lib/postsDto.ts` (expose `approvalState` + `submittedForApprovalAt`)
- Modify: `app/src/app/queue/queue-view.tsx` (Awaiting-approval section + actions)

**Interfaces:**
- Consumes: `canDecideApproval`, `deriveApprovalState`, `approvalOutcome` (Task 1); `prepareDeferredPostJobDispatch` from `@/server/jobs/posting`; `inngest` from `@/lib/inngest`; `requireOwnerContext` from `@/lib/workspace`; `buildApprovalDecisionEmail` (Task 2).
- Produces: `POST /api/posts/{id}/approval` with body `{ decision: "approve" | "reject" }` → 200 `{ ok: true, status }`; 403 for members; 409 when not pending; `PostJobDTO.approvalState`.

- [ ] **Step 1: Write the failing route tests** (fixture params MUST be `Promise.resolve({ postJobId })`): member → 403 and no writes; owner approving a pending draft with a future `scheduledFor` → 200, `status: "scheduled"`, `approvedAt`/`approvedByUserId` written, no `inngest.send`; owner approving a pending draft with no/passed `scheduledFor` → 200, dispatch prepared and `inngest.send` called once; owner rejecting → 200 and `status: "cancelled"` with `approvedAt` still null; a non-pending job → 409; a job in another workspace → 404. Run — must FAIL.

- [ ] **Step 2: Implement the route.** Owner gate via `requireOwnerContext()`; read the job (`select: { status, scheduledFor, submittedForApprovalAt, approvedAt, userId }`) scoped to the workspace; derive state and `canDecideApproval` (409 otherwise). Reject → atomic `updateMany` to `cancelled` conditioned on `status: "draft"`. Approve → write `approvedAt`/`approvedByUserId`, then branch on `approvalOutcome`: `schedule` → `updateMany` to `status: "scheduled"`; `publish_now` → `prepareDeferredPostJobDispatch(postJobId)` then `inngest.send({ name: "post/publish.requested", data: result.event })`, mirroring the publish route's handling of its `ok: false` outcomes. Then fire-and-forget the decision email to the submitting member (`job.userId` → user email).

- [ ] **Step 3: Run — PASS**, then extend `postsDto.ts` to project `approvalState` (via `deriveApprovalState`) and add a DTO test asserting a pending job serializes as `approvalState: "pending"` (write that test first, watch it fail).

- [ ] **Step 4: Queue UI.** In `queue-view.tsx`, split the loaded jobs: `pending approval` first (badge "Awaiting approval", and for owners two buttons — Approve / Reject — POSTing the new route, then removing/refreshing the row), the rest as today. A member sees the badge and "Waiting for an owner to approve" with no decision buttons (`workspaceRole` — check whether `PostsResponse` already exposes the caller's role; if not, add it, mirroring `workspaceMemberCount`).

- [ ] **Step 5: Verify** — `npm test`, `npx tsc --noEmit`, `npx eslint .`, `npm run build`; commit + PR `feat(approval): approve/reject API and Queue review UI`, CI green, merge.

- [ ] **Step 6: Prod verification** (probe recipe in memory `world-class-program-2026-07-26`)
  1. Owner enables Require approval in Settings (drive as the real owner account? NO — use a throwaway OWNER of a fresh workspace plus a throwaway MEMBER invited into it, so the real workspace is untouched).
  2. Member schedules a post → assert it lands as Awaiting approval, no publish fired, owner received the request email (check via DB/log if Resend API is unavailable).
  3. Owner approves → assert status becomes `scheduled` with the member's original time preserved.
  4. Member submits another → owner rejects → status `cancelled`, `approvalState: "rejected"`.
  5. Member cannot approve: direct POST returns 403.
  6. Clean up both users, their workspace, jobs, media rows and blobs.

---

## Self-Review (done at planning time)

- Coverage: flag + rules (Task 1), hold-on-create + toggle + request email (Task 2), decide + UI + decision email + prod proof (Task 3).
- Placeholders: none for the pure/logic layers. Tasks 2 and 3 name the exact files, insert points, assertions and patterns to mirror; the two "read the existing file and mirror its shape" steps are deliberate (settings validation style, Queue markup) and each says precisely what to copy.
- Type consistency: `shouldHoldForApproval` / `deriveApprovalState` / `canDecideApproval` / `approvalOutcome` signatures identical across tests, implementation, and both consuming routes; `ApprovalState` is the single vocabulary used by the DTO and the UI.
