# Team Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the team-workspaces design at `docs/superpowers/specs/2026-07-12-team-workspaces-design.md` (READ IT FIRST for every task — it is the authoritative design; this plan carries task mechanics).

**Architecture:** Workspace/WorkspaceMember/WorkspaceInvite models; `workspaceId` on SocialConnection/MediaItem/PostJob/PostMetric (userId stays as attribution); httpOnly `vs_active_workspace` cookie + per-request membership validation via `getWorkspaceContext`; owner-gated admin surface; invite links (SHA-256-hashed tokens, 7-day expiry).

**Tech Stack:** Next.js 16 App Router, Prisma (hand-authored migration SQL — the DB is NEVER touched locally), next-auth v4 JWT, Vitest.

## Global Constraints

- **DANGER — production credentials:** `app/.env.local` points at the PRODUCTION database. NEVER run `npm run dev`, `next dev`, `npm run start`, `prisma migrate dev`, `prisma migrate deploy`, `prisma db push/pull/seed`, or any command that opens a DB connection. Allowed: `npx prisma validate`, `npx prisma format`, `npx prisma generate`, `npx prisma migrate diff` (pure schema-to-schema, no DB), `npx vitest run <paths>`, `npm test`, `npm run lint`, `npm run build`. Only Task 8 may run `npx playwright test`.
- Never modify `app/.env.local`. The migration is AUTHORED in this program but APPLIED only later by the controller in an owner-gated release step.
- Commands run from `C:/Users/Klaus/Documents/Github_apps/vibesocials/app` (Windows, bash).
- SEC-1: DTOs stay display-safe. Invite responses never include tokenHash. `createdBy.name` never exposes a full email (local-part fallback).
- UI copy sentence case; reuse `src/components/ui/*` primitives; follow existing route-test mock conventions.
- Baseline at branch start: 423 vitest green, lint 0 errors, build clean. Every task ends with focused vitest + full `npm test` + `npm run lint` green (plus `npm run build` where the task says so) and one commit ending with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Schema + migration SQL (authored, not applied)

**Files:**
- Modify: `app/prisma/schema.prisma` (spec §2 verbatim: enum WorkspaceRole; models Workspace/WorkspaceMember/WorkspaceInvite; `workspaceId` + relations + indexes on SocialConnection/MediaItem/PostJob/PostMetric; SocialConnection unique `[workspaceId, platform]` replacing `[userId, platform]`; PostMetric `@@index([workspaceId])` replacing `@@index([userId])`; User gains `workspaceMemberships WorkspaceMember[]` back-relation; User.companyWebsite/defaultHashtags REMAIN)
- Create: `app/prisma/migrations/20260712000000_team_workspaces/migration.sql`

**Interfaces produced:** Prisma client types `Workspace`, `WorkspaceMember`, `WorkspaceRole`, `WorkspaceInvite`; `workspaceId: string` on the four models.

- [ ] Step 1: Snapshot the old schema: `git show HEAD:prisma/schema.prisma > /tmp-old-schema.prisma` (put it in the repo-ignored `.superpowers/` dir, not /tmp). Edit `schema.prisma` per spec §2. Run `npx prisma format` + `npx prisma validate`.
- [ ] Step 2: Generate the structural SQL WITHOUT a database: `npx prisma migrate diff --from-schema-datamodel <old-snapshot-path> --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/20260712000000_team_workspaces/migration.sql`. Inspect it: it will create the enum/tables and add `workspaceId` columns — as NOT NULL (diff assumes empty tables). REWORK it by hand into the 4-phase prod-safe order from spec §2: (1) enum+tables; (2) `ADD COLUMN "workspaceId" TEXT` (nullable) ×4; (3) backfill block; (4) `SET NOT NULL` ×4 + FKs + indexes + `DROP INDEX "SocialConnection_userId_platform_key"` + `CREATE UNIQUE INDEX "SocialConnection_workspaceId_platform_key"`. Backfill SQL (verbatim intent, adjust quoting to match Prisma's generated style):

```sql
-- One personal workspace per existing user, owner membership, data adoption.
INSERT INTO "Workspace" ("id", "name", "companyWebsite", "defaultHashtags", "createdAt", "updatedAt")
SELECT 'ws_' || u."id", COALESCE(NULLIF(u."name", ''), split_part(u."email", '@', 1)) || '''s workspace',
       u."companyWebsite", u."defaultHashtags", NOW(), NOW()
FROM "User" u;

INSERT INTO "WorkspaceMember" ("id", "workspaceId", "userId", "role", "createdAt")
SELECT 'wm_' || u."id", 'ws_' || u."id", u."id", 'owner', NOW() FROM "User" u;

UPDATE "SocialConnection" SET "workspaceId" = 'ws_' || "userId" WHERE "workspaceId" IS NULL;
UPDATE "MediaItem"        SET "workspaceId" = 'ws_' || "userId" WHERE "workspaceId" IS NULL;
UPDATE "PostJob"          SET "workspaceId" = 'ws_' || "userId" WHERE "workspaceId" IS NULL;
UPDATE "PostMetric"       SET "workspaceId" = 'ws_' || "userId" WHERE "workspaceId" IS NULL;
```

(`'ws_' || userId` guarantees deterministic, collision-free ids without needing cuid() in SQL; cuid format is not enforced by the schema.)
- [ ] Step 3: `npx prisma generate` (offline). Full `npm test` (mocked prisma — must stay 423 green), `npm run lint`, `npm run build`.
- [ ] Step 4: Commit `feat(db): team-workspaces schema + hand-authored backfill migration (not applied)`.

---

### Task 2: Workspace context core + registration provisioning

**Files:**
- Create: `app/src/lib/workspace.ts` + `app/src/lib/workspace.test.ts`
- Modify: `app/src/app/api/auth/register/route.ts` + its `route.test.ts`

**Interfaces produced (verbatim contract for later tasks):**

```ts
// src/lib/workspace.ts
export const ACTIVE_WORKSPACE_COOKIE = "vs_active_workspace";
export interface WorkspaceContext { user: User; workspace: Pick<Workspace, "id"|"name"|"companyWebsite"|"defaultHashtags">; role: WorkspaceRole; memberCount: number; }
export function resolveActiveMembershipId(memberships: Array<{ workspaceId: string; role: WorkspaceRole; createdAt: Date }>, cookieValue: string | undefined): string | null;  // PURE: cookie match wins; else oldest owned; else oldest membership; null if none
export async function provisionPersonalWorkspace(tx: PrismaClientLike, user: { id; name; email; companyWebsite; defaultHashtags }): Promise<{ workspaceId: string }>;  // insert workspace (name rule from spec §2) + owner membership
export async function getWorkspaceContext(opts?: { requireRole?: "owner" }): Promise<WorkspaceContext | null>;  // null = unauthenticated; throws WorkspaceForbiddenError (exported) when requireRole unmet — API routes map it to 403 { error: "Only the workspace owner can do that." }
```

**PLAN AMENDMENT (controller, after Task 1):** Task 1's required `workspaceId` breaks `npm run build` (25 TS errors / 15 files — the compiler's rescoping checklist). Task 2 additionally ships a green-build bridge: export `resolveWorkspaceForUser(userId: string): Promise<string>` from `src/lib/workspace.ts` (personal-workspace lookup with lazy provisioning — the same logic getWorkspaceContext uses) and mechanically fix EVERY build error with it: creates stamp `workspaceId: await resolveWorkspaceForUser(userId)`, `userId_platform` upserts/lookups switch to the `workspaceId_platform` unique. Mark each such site with `// WORKSPACE-BRIDGE: personal-workspace interim — replaced by getWorkspaceContext/job.workspaceId in Tasks 4-6.` Tasks 4/5/6 MUST remove every bridge comment in the files they own (Task 8 greps for leftovers). Task 2's gate includes `npm run build` returning to green.

- [ ] Step 1 (TDD): `workspace.test.ts` — pure `resolveActiveMembershipId` cases: cookie matches a membership → that id; cookie matches nothing → oldest OWNED; no owned → oldest membership; empty list → null. Plus `provisionPersonalWorkspace` name rule (name "Klaus" → "Klaus's workspace"; empty name → email local-part) via a mocked tx.
- [ ] Step 2: Implement. `getWorkspaceContext` reads the session like `getCurrentUser` (reuse it), loads memberships (`include: { workspace: true }`), applies the pure resolver with `cookies()` (from `next/headers`), lazily provisions when the user has zero memberships (spec §2 self-heal — inside `prisma.$transaction`), computes memberCount with one `workspaceMember.count`, enforces `requireRole`.
- [ ] Step 3: Register route: wrap user-create + `provisionPersonalWorkspace` in one `prisma.$transaction`. Extend route tests: happy path asserts workspace + owner membership creation.
- [ ] Step 4: Full gates; commit `feat(workspace): context resolution, lazy provisioning, register transaction`.

---

### Task 3: Workspaces / invites / members APIs

**Files:**
- Create: `app/src/app/api/workspaces/route.ts` (GET list), `app/src/app/api/workspaces/switch/route.ts` (POST), `app/src/app/api/workspaces/active/route.ts` (PATCH rename), `app/src/app/api/workspaces/invites/route.ts` (GET/POST/DELETE), `app/src/app/api/workspaces/members/route.ts` (GET), `app/src/app/api/workspaces/members/[userId]/route.ts` (DELETE), `app/src/app/api/invites/[token]/route.ts` (GET preview), `app/src/app/api/invites/[token]/accept/route.ts` (POST)
- Create: `app/src/lib/inviteToken.ts` + test (`generateInviteToken(): { raw, hash }` — 32 random bytes base64url + sha256 hex; `hashInviteToken(raw)`; `INVITE_TTL_MS = 7*24*60*60*1000`)
- Create: route tests for every route (one test file per route dir, existing conventions)

Behaviors (spec §4 authoritative): switch validates membership then sets the cookie (httpOnly, path /, sameSite lax, secure in prod, maxAge 1y); invite POST revokes prior active invites (single-active policy) and returns `{ url: \`${process.env.NEXTAUTH_URL ?? ""}/join/${raw}\`, expiresAt }`; accept re-validates hash+expiry+revocation, idempotent when already a member, bumps usedCount, sets active cookie, rate-limited via existing `checkRateLimit` (route "invites/accept", limit 10, windowMs 5min); members DELETE blocks self-removal (400 "Transfer ownership before removing yourself." — v1: owner can't remove self at all); preview 404s uniformly for invalid/expired/revoked. All owner-gated routes use `getWorkspaceContext({ requireRole: "owner" })` and map `WorkspaceForbiddenError` → 403.

- [ ] Step 1 (TDD): inviteToken tests (round-trip hash, 43-char raw, uniqueness across calls).
- [ ] Step 2 (TDD): route tests first (403 for member on owner routes; switch 403 non-membership; accept: expired→410? NO — 404 uniformly per spec; already-member idempotent 200; usedCount increment), then implement.
- [ ] Step 3: Full gates + build; commit `feat(workspace): invites, membership, switch APIs`.

---

### Task 4: Rescope posts + media APIs, DTO attribution, shared test helper

**Files:**
- Create: `app/src/lib/testWorkspace.ts`? NO — test helpers live inside test files by convention; instead create `app/src/app/api/__test-helpers__/workspaceContextMock.ts` ONLY if ≥3 test files need it; otherwise inline. (Implementer judgment; report the choice.)
- Modify: `app/src/app/api/posts/route.ts` (+`route.test.ts`, `route.get.test.ts`), `app/src/app/api/posts/[postJobId]/route.ts` + `cancel` + `publish` + `retry` (+tests), `app/src/app/api/media/route.ts` + `[id]/route.ts` (+tests), `app/src/lib/postsDto.ts`, `app/src/lib/mediaDto.ts` (no shape change — verify), `app/src/hooks/usePostJobs.ts` (type only if needed)

Rules: every route swaps `getCurrentUser()` → `getWorkspaceContext()`; all queries filter `workspaceId: ctx.workspace.id`; creation writes BOTH `workspaceId` and `userId: ctx.user.id`; media DELETE requires `item.userId === ctx.user.id || ctx.role === "owner"` (else 403 "Only the uploader or the workspace owner can delete this."); ownership checks in `[postJobId]` routes switch from `job.userId === user.id` to `job.workspaceId === ctx.workspace.id`. `PostJobDTO` gains `createdBy: { name: string } | null` (GET /api/posts selects `user: { select: { name: true, email: true } }`, maps to name ?? email local-part; null if user deleted). Rate limits keep keying by user id.

- [ ] Step 1 (TDD): extend route tests — new field round-trip, member-vs-owner media delete matrix, cross-workspace isolation (a job in workspace B invisible/not-actionable from workspace A's context).
- [ ] Step 2: Implement; update ALL existing mocks in touched test files from getCurrentUser to the workspace context shape.
- [ ] Step 3: Full gates + build; commit `feat(workspace): posts + media APIs are workspace-scoped with attribution`.

---

### Task 5: Server jobs on workspace scope

**Files:**
- Modify: `app/src/server/jobs/posting.ts` (+`posting.test.ts`, `deferredDispatch.test.ts`): create-helpers take `workspaceId` (callers pass ctx), connection fan-out queries `{ workspaceId }` (3 sites incl. `prepareDeferredPostJobDispatch` reading `job.workspaceId`), PostJob create stamps both ids
- Modify: `app/src/server/jobs/inngest-functions.ts`: `publishToAllPlatforms` + retry connection lookups by the job's `workspaceId` (results still bound fan-out)
- Modify: `app/src/server/jobs/metricsScanner.ts` (+test): iterate workspace-scoped youtube connections; `PostMetric` upserts stamp `workspaceId` (+ existing `userId` = connection.userId)
- Verify-only: `postOutcomeEmail.ts` recipient stays `PostJob.userId` (add a test asserting the member-creator gets the email, not the owner)

- [ ] Step 1 (TDD): update/extend the three job test files first (fan-out by workspaceId incl. targeting trio; metrics stamping; creator-recipient email).
- [ ] Step 2: Implement; full gates + build; commit `feat(workspace): publish fan-out, metrics, notifications follow workspace scope`.

---

### Task 6: Connections, settings, reviews, OAuth owner-gating

**Files:**
- Modify: `app/src/lib/oauthState.ts` + `oauthState.test.ts`: `createOAuthState({ userId, workspaceId })`, verify returns `{ valid, userId?, workspaceId? }`; payload without workspaceId → invalid
- Modify: all 7 `app/src/app/api/auth/*/start/route.ts`: `getWorkspaceContext({ requireRole: "owner" })`, embed workspaceId
- Modify: all 7 `app/src/app/api/auth/*/callback/route.ts`: after verify, load membership and require role owner (else redirect `?error=<platform>_not_workspace_owner` — add this code to `describeOAuthResult`'s generic bucket coverage in `oauthResult.test.ts`); connection upsert keys `workspaceId_platform` (new compound unique name from Task 1) stamping both ids
- Modify: `app/src/app/api/connections/route.ts` (member read), `[platform]/route.ts` DELETE (owner), GBP `location`/`locations` routes (owner POST, member GET), `app/src/app/api/tiktok/creator-info/route.ts` (member), reviews routes ×4 (member; workspace-scoped GBP connection lookup)
- Modify: `app/src/app/api/settings/route.ts` (+test): POST owner-only; footer fields write to `workspace`; `notifyOnPostComplete` writes to the calling user regardless of role (split update). `app/src/lib/userSettings.ts` type: footer fields now sourced from workspace (adjust settings page in Task 7).

- [ ] Step 1 (TDD): oauthState tests (new shape, old-shape rejection), settings split-write tests, one callback test updated for owner re-check if a callback test file exists (check; else route-level behavior is covered by start-route tests + code review).
- [ ] Step 2: Implement all; full gates + build; commit `feat(workspace): owner-gated connections/settings/OAuth, member reviews access`.

---

### Task 7: UI — switcher, team section, join page, read-only modes, attribution

**Files:**
- Modify: `app/src/components/shell/account-menu.tsx` (workspace section + switcher; fetch GET /api/workspaces on open; switch → POST + `router.refresh()`)
- Create: `app/src/components/team-section.tsx` (Settings card per spec §7: owner = rename field + invite block Create/Copy/Revoke with expiry + member list with Remove ConfirmDialog exact copy from spec; member = list + explanatory line)
- Modify: `app/src/app/settings/page.tsx` (loads workspace context server-side; passes role; renders TeamSection; footer fields now from workspace; members see captions read-only + connections without action buttons — pass a `readOnly` prop into `SettingsForm`/`ConnectionsSection`)
- Modify: `app/src/components/settings-form.tsx`, `app/src/components/connections-section.tsx` (readOnly prop)
- Create: `app/src/app/join/[token]/page.tsx` (server-gated w/ callbackUrl) + `app/src/app/join/[token]/join-view.tsx` (client: preview fetch → confirm Join → accept POST → toast + `router.push("/")`; invalid/expired → EmptyState "This invite link isn't valid anymore." + "Ask the workspace owner for a new link.")
- Modify: `app/src/components/activity/post-job-card.tsx`, `app/src/app/queue/queue-view.tsx` (show `by {createdBy.name}` next to timestamp when provided AND workspace has >1 member — thread `showAttribution` from a new `memberCount` on... simplest: GET /api/posts adds top-level `workspaceMemberCount: number` to `PostsResponse`; views pass `showAttribution={workspaceMemberCount > 1}` down)

UI-only task: no new unit tests; gate = full suite + lint + build.

- [ ] Step 1: Implement per spec §7 exactly; sentence case; reuse Dialog/ConfirmDialog/EmptyState/Badge/Skeleton primitives.
- [ ] Step 2: Full gates + build; commit `feat(workspace): switcher, team management UI, join flow, attribution`.

---

### Task 8: E2E scaffold, sweep, full gate

**Files:**
- Modify: `app/e2e/core-flows.spec.ts`: add a SKIPPED (same `E2E_DATABASE_URL` gate) "invite → join → member posts with attribution" scenario using the real selectors from Task 7's UI; update any selectors/copy this program changed (settings page structure).
- Sweep: grep for remaining `getCurrentUser()` usages in `src/app/api/**` — every data route must be on `getWorkspaceContext` (auth pages/gates legitimately keep `getCurrentUser`); grep `where: { userId` in `src/app/api` + `src/server/jobs` — remaining hits must each be justified in the report (rate limits, user-pref writes, media-delete uploader check ARE justified).
- Docs: update `docs/PROJECT_OVERVIEW.md` with a short Workspaces section (model + roles, 10 lines).

**PLAN AMENDMENT (controller, after Task 7):** spec §1 grants members "Leave workspace" but no task built it. Task 8 additionally ships: `POST /api/workspaces/leave` (+route test) — any non-owner member deletes their OWN membership in the ACTIVE workspace (owner → 400 "Transfer ownership before removing yourself."; personal-workspace fallback: clear the active-workspace cookie so context falls back), returns `{ left: true }`; and a "Leave workspace" button (ConfirmDialog: title "Leave this workspace?", description "You'll lose access to its accounts and posts. Your own account keeps working.", confirm "Leave") in `team-section.tsx`'s MEMBER view, on success toast + `router.refresh()`.

- [ ] Step 1: Sweep + fixes; e2e edits.
- [ ] Step 2: Full gate IN ORDER: `npm test` → `npm run lint` → `npm run build` → `npx playwright test` (16 passed/4+1-scenario skipped acceptable — the smoke set must stay green).
- [ ] Step 3: Commit `feat(workspace): e2e scaffold, scope sweep, docs`.

---

## Release (controller-executed, NOT a subagent task)

Final whole-branch review (opus) → fixes → PR. Then the OWNER-GATED sequence, exactly like the roadmap release: (1) explicit owner confirmation in chat; (2) `prisma migrate deploy` against prod Neon (controller runs it with the prod URL — never a subagent); (3) merge PR → Vercel deploy; (4) post-deploy checks from spec §9.

## Self-review notes

Spec §1-§7 map: §2→T1, §3→T2, §4→T3+T4+T6, §5→T6, §6→T5, §7→T7, §8→T2-T8 tests + T8 e2e, §9→Release. Deliberate: `GET /api/media/[id]` stays member-accessible (reuse flow); `PATCH /api/workspaces/active` in T3; lazy provisioning in T2 makes deploy-before-migrate survivable but the release still orders migrate-first.
