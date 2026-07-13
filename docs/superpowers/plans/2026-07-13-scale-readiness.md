# Scale Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Password reset + email verification, a dev-against-prod tripwire, activity/queue pagination, and full co-owner workspaces — four independent PR groups per `docs/superpowers/specs/2026-07-13-scale-readiness-design.md`.

**Architecture:** All four groups branch from `main` @ `f5dd5ae`. PR-A adds one authored-only migration (AccountToken + User.emailVerifiedAt) and env-gated Resend flows mirroring the notifications pattern. PR-B is a zero-dep script + docs. PR-C is additive keyset pagination on `GET /api/posts`. PR-D changes the permission matrix per the owner-approved spec §D with advisory-lock race guards.

**Tech Stack:** Next.js 16 App Router, Prisma/Postgres, next-auth v4 (JWT), Resend, Vitest, Tailwind v4 tokens.

## Global Constraints

- ⚠️ `app/.env.local` points at PRODUCTION. NEVER run `npm run dev`, `next dev`, `npm run start`, `prisma migrate dev/deploy`, `prisma db *`, or any script importing `src/lib/db.ts`. Never modify `app/.env.local`. Offline `npx prisma migrate diff` (schema-to-schema) is allowed; so are vitest/lint/build/tsc/`prisma validate|generate|format`.
- Gate at every task boundary (from `app/`): `npx vitest run` all green (600 baseline, grows), `npm run lint` 0 errors (10 pre-existing warnings allowed), `npm run build` clean, `npx tsc --noEmit` 0.
- Migrations are AUTHORED ONLY — never applied. Verify offline: schema-to-schema `prisma migrate diff --script` must emit exactly the authored DDL (temp pre-change schema in the scratchpad, NOT committed).
- SEC-1: display fields only in responses; no user-existence oracles on anonymous auth routes (uniform bodies/status for exists vs not); tokens stored ONLY as sha256 hex; raw tokens appear once, in emailed links' URL FRAGMENTS.
- Rate limiting via existing `checkRateLimit` (`src/lib/rateLimit.ts`); 429 envelope byte-identical to the posts pattern: body `{ error: "Too many requests. Please slow down.", retryAfterSeconds }` + `Retry-After: String(retryAfterSeconds ?? 1)` header.
- Route tests mock `@/lib/db` + `@/lib/workspace` (+ `@/lib/rateLimit` where used) via `vi.hoisted`/`vi.mock` BEFORE importing the route (copy `src/app/api/workspaces/members/route.test.ts`). TDD: failing tests first, RED evidence, then GREEN.
- Sentence-case UI copy. Vitest globs `src/**/*.test.ts` only. Email sending is env-gated on `RESEND_API_KEY` and must NEVER throw into callers (mirror `src/server/notifications/postOutcomeEmail.ts` + its delivery wrapper — read both before Task A1).
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Implementers do NOT push or open PRs.

---

### Task A1: AccountToken schema + token lib + email builders (branch `feat/auth-account-lifecycle`)

**Files:**
- Modify: `app/prisma/schema.prisma` (enum `AccountTokenType`, model `AccountToken`, `User.emailVerifiedAt DateTime?` + back-relation `accountTokens AccountToken[]`)
- Create: `app/prisma/migrations/20260713090000_account_tokens/migration.sql` (authored only)
- Create: `app/src/lib/accountToken.ts` + `app/src/lib/accountToken.test.ts`
- Create: `app/src/lib/accountEmails.ts` + `app/src/lib/accountEmails.test.ts`

**Interfaces (later tasks rely on these exact names):**

```ts
// accountToken.ts
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;        // 60 min
export const EMAIL_VERIFY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export function hashAccountToken(raw: string): string;       // sha256 hex
export function generateAccountToken(): { raw: string; hash: string }; // 32B base64url (43 chars)
/** Deletes prior unused tokens of `type`, inserts a fresh one, returns the raw token. */
export function issueAccountToken(tx: PrismaClientLike2, userId: string, type: AccountTokenType, now?: Date): Promise<string>;
// where PrismaClientLike2 = { accountToken: { deleteMany: ..., create: ... } } (structural, mirrors lib/workspace.ts PrismaClientLike)

// accountEmails.ts
export function buildPasswordResetEmail(opts: { to: string; rawToken: string; baseUrl: string }): { subject: string; html: string; text: string };
export function buildVerifyEmail(opts: { to: string; rawToken: string; baseUrl: string }): { subject: string; html: string; text: string };
/** Fail-safe: returns false without touching anything when RESEND_API_KEY unset; never throws. */
export function deliverAccountEmail(to: string, email: { subject: string; html: string; text: string }): Promise<boolean>;
```

- [ ] **Step 1: Failing lib tests.** `accountToken.test.ts`: raw is 43-char base64url; hash is 64-hex of sha256 (assert against `crypto.createHash("sha256").update(raw).digest("hex")`); `issueAccountToken` calls `deleteMany({ where: { userId, type, usedAt: null } })` then `create` with `expiresAt = now + TTL` per type (mock tx object, assert args). `accountEmails.test.ts`: builders — subject sentence case ("Reset your Vibe Socials password" / "Verify your email address"); html AND text contain `${baseUrl}/reset-password#${rawToken}` (fragment, NOT `?token=`); no other occurrence of the raw token; `deliverAccountEmail` returns false immediately when `RESEND_API_KEY` is unset (use `vi.stubEnv`), and never throws when the Resend client rejects (mock the `resend` module). Run: `npx vitest run src/lib/accountToken src/lib/accountEmails` → FAIL (modules missing).
- [ ] **Step 2: Schema + migration.** Add to `schema.prisma` exactly the spec §A model block + `emailVerifiedAt DateTime?` on User + back-relation. `npx prisma format && npx prisma validate && npx prisma generate`. Author the migration by hand:

```sql
-- Account lifecycle (scale-readiness spec §A). OWNER APPLIES via prisma migrate deploy.
-- CreateEnum
CREATE TYPE "AccountTokenType" AS ENUM ('password_reset', 'email_verify');
-- AlterTable
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
-- CreateTable
CREATE TABLE "AccountToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "AccountTokenType" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccountToken_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "AccountToken_tokenHash_key" ON "AccountToken"("tokenHash");
CREATE INDEX "AccountToken_userId_type_idx" ON "AccountToken"("userId", "type");
-- AddForeignKey
ALTER TABLE "AccountToken" ADD CONSTRAINT "AccountToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Backfill: existing users predate verification — grandfather them as verified.
UPDATE "User" SET "emailVerifiedAt" = CURRENT_TIMESTAMP WHERE "emailVerifiedAt" IS NULL;
```

Verify offline: copy the PRE-change schema to the scratchpad, `npx prisma migrate diff --from-schema-datamodel <scratch>/schema-pre-A.prisma --to-schema-datamodel prisma/schema.prisma --script` — output must match the authored DDL except the hand-added backfill UPDATE (document that delta in the migration header comment). Do NOT commit the scratch copy.
- [ ] **Step 3: Implement libs** (mirror `inviteToken.ts` for the token pair; mirror `postOutcomeEmail.ts` + its delivery wrapper for Resend usage, `NOTIFICATIONS_FROM` fallback and all). Run lib tests → PASS.
- [ ] **Step 4: Full gate.** Step 5: **Commit** `feat(auth): AccountToken model (authored migration) + token/email libs`.

### Task A2: Forgot/reset password — routes + pages

**Files:**
- Create: `app/src/app/api/auth/forgot-password/route.ts` + `route.test.ts`
- Create: `app/src/app/api/auth/reset-password/route.ts` + `route.test.ts`
- Create: `app/src/app/forgot-password/page.tsx` (+ client form component in the same folder)
- Create: `app/src/app/reset-password/page.tsx` (+ client component reading `location.hash`)
- Modify: `app/src/app/login/page.tsx` (add "Forgot password?" link near the password field)
- Modify: `app/src/components/shell/nav.ts:34-39` (add `"/forgot-password"`, `"/reset-password"` to `PUBLIC_ROUTE_PREFIXES`)

**Interfaces:** Consumes A1's `issueAccountToken`, `hashAccountToken`, `buildPasswordResetEmail`, `deliverAccountEmail`, `PASSWORD_RESET_TTL_MS`. Produces nothing later tasks need.

- [ ] **Step 1: Failing route tests.** forgot-password: 200 `{ ok: true }` for UNKNOWN email AND for known email, byte-identical bodies (no oracle); rate limits checked FIRST — `checkRateLimit` called with `{ userId: "email:user@x.com", route: "auth/forgot", limit: 3, windowMs: 900000 }` AND `{ userId: expect.stringMatching(/^ip:/), route: "auth/forgot-ip", limit: 10, windowMs: 900000 }`, blocked → 429 + Retry-After and NO db read; when user exists: token issued + email delivered (mock libs, assert `deliverAccountEmail` called with builder output); when user missing: NO token, NO email, still 200; invalid email body → 400. reset-password: happy path — `hashAccountToken(token)` looked up, conditional `updateMany({ where: { tokenHash, type: "password_reset", usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } })` returning count 1, then `bcrypt.hash(password, 10)` (mock `bcryptjs`), `user.update` with new hash + `emailVerifiedAt` set when null, other active reset tokens deleted; count 0 → uniform 400 `{ error: "This link is invalid or has expired." }`; password shorter than 8 → 400 "Password must be at least 8 characters." (byte-match the register rule); rate limit `{ route: "auth/reset", limit: 10, windowMs: 900000 }` keyed `ip:`. RED run.
- [ ] **Step 2: Implement routes.** IP key: `const ip = (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim() || "unknown";`. forgot-password never distinguishes outcomes in timing-relevant DB work beyond the user lookup (acceptable; document). reset-password performs the token update INSIDE `prisma.$transaction` together with the password update + sibling-token cleanup. GREEN run.
- [ ] **Step 3: Pages.** Follow `app/src/app/login/page.tsx` + register page structure (Card, Label/Input/Button, sentence case). `/forgot-password`: single email field; after submit ALWAYS render "If an account exists for that address, we sent a reset link." `/reset-password`: `"use client"` component; `useEffect` reads `window.location.hash.slice(1)`; empty → error card with link to `/forgot-password`; else password + confirm fields (client-side match check), POST `{ token, password }`; on 400 show the server error; on success card + "Log in" link. Add the login-page link and the two `PUBLIC_ROUTE_PREFIXES` entries.
- [ ] **Step 4: Full gate** (build proves pages compile + prerender). Step 5: **Commit** `feat(auth): password reset flow (fragment-token links, no-oracle)`.

### Task A3: Email verification — register hook, verify/resend/status routes, page, banner

**Files:**
- Modify: `app/src/app/api/auth/register/route.ts:37-56` (post-transaction fire-and-forget verify email)
- Create: `app/src/app/api/auth/verify-email/route.ts` + `route.test.ts`
- Create: `app/src/app/api/auth/resend-verification/route.ts` + `route.test.ts`
- Create: `app/src/app/api/auth/account-status/route.ts` + `route.test.ts`
- Create: `app/src/app/verify-email/page.tsx` (+ client component)
- Create: `app/src/components/shell/verify-email-banner.tsx`
- Modify: `app/src/components/shell/app-shell.tsx` (mount banner inside the authed chrome, above page content)
- Modify: `app/src/components/shell/nav.ts` (add `"/verify-email"` to `PUBLIC_ROUTE_PREFIXES`)

**Interfaces:** Consumes A1 libs + A2's uniform-400 message. Produces `GET /api/auth/account-status` → `{ emailVerified: boolean, verificationAvailable: boolean }`.

- [ ] **Step 1: Failing tests.** verify-email: valid token → conditional updateMany (type `email_verify`) + `user.update({ emailVerifiedAt })` → 200 `{ ok: true }`; invalid/expired/used → uniform 400 (same string as reset); rate limit `auth/verify` 10/15min `ip:` key. resend-verification: 401 anonymous; 400 `{ error: "Your email is already verified." }` when verified; 503 `{ error: "Email sending is not configured." }` when `RESEND_API_KEY` unset (stubEnv); happy path issues+sends; rate limit `auth/resend-verify` 3/15min per user id. account-status: 401 anonymous; `{ emailVerified: true|false, verificationAvailable }` from `user.emailVerifiedAt` + env. register: mock `deliverAccountEmail` to REJECT and assert registration still 201 (fire-and-forget try/catch); assert no email attempted when `RESEND_API_KEY` unset (the issue call is inside the guard). RED.
- [ ] **Step 2: Implement.** register hook AFTER the `$transaction` returns, wrapped: `try { if (process.env.RESEND_API_KEY) { const raw = await issueAccountToken(prisma, user.id, "email_verify"); await deliverAccountEmail(user.email, buildVerifyEmail({ to: user.email, rawToken: raw, baseUrl })); } } catch (error) { logger.warn("[register] verification email failed", { error }); }` (use existing `logger`). account-status uses `getCurrentUser` (not workspace context — user-level fact). GREEN.
- [ ] **Step 3: Page + banner.** `/verify-email` client page: reads hash, POSTs once on mount (`useRef` guard), spinner → success ("Email verified — you're all set.") or error card ("This link is invalid or has expired. Log in and use the resend button to get a fresh one."). Banner component: on mount fetch `/api/auth/account-status`; render nothing unless `{ emailVerified: false, verificationAvailable: true }`; slim `Alert` variant with "Verify your email — check your inbox." + `Button` size sm "Resend email" (POST resend-verification; toast success "Verification email sent." / error from body); after a `/verify-email` success elsewhere the next mount refetches (no live sync needed — document). Mount in app-shell only for authenticated, non-public routes.
- [ ] **Step 4: Full gate.** Step 5: **Commit** `feat(auth): email verification (soft banner, env-gated)`.

### Task B1: Env-safety tripwire + `.env.example` + staging runbook (branch `chore/env-safety`)

**Files:**
- Create: `app/scripts/dev-db-guard.mjs`
- Modify: `app/package.json:5-15` (add `"predev": "node scripts/dev-db-guard.mjs"`)
- Create: `app/.env.example`
- Create: `docs/STAGING_SETUP.md`

**Interfaces:** none.

- [ ] **Step 1: Script** (zero deps, ~60 lines): read `--env-file` arg (default `.env.local` relative to cwd); missing file or no `DATABASE_URL` line → exit 0 silently. Parse host via `new URL(value).hostname` (strip quotes; on parse failure warn + exit 0 — never block on a malformed line). Allow `localhost`/`127.0.0.1`/`::1` → exit 0. Otherwise: if `process.env.DEV_DB_OK === "1"` → print one-line acknowledgment, exit 0; else print a bordered banner: `DATABASE_URL points at remote host "<host>".` / `Refusing to start next dev against a possibly-production database.` / `If this is intentional (e.g. a staging DB), re-run with DEV_DB_OK=1.` → exit 1.
- [ ] **Step 2: Manual verification** (no vitest — outside `src/` glob, deliberately trivial): create three fixture files in the SCRATCHPAD (never in-repo), run `node scripts/dev-db-guard.mjs --env-file <fixture>` for: localhost URL → exit 0; remote URL → exit 1 + banner; remote + `DEV_DB_OK=1` → exit 0. Paste all three outputs in the report. Also `node scripts/dev-db-guard.mjs --env-file does-not-exist` → exit 0.
- [ ] **Step 3: `.env.example`** — grep `process.env.` across `app/src` + `next.config.*` + `playwright.config.ts` + `.github/workflows/ci.yml` for the authoritative var list; group (Database / Auth / Blob / Email / Sentry / Inngest / Platform OAuth / E2E-only) with one comment line each; values are empty or descriptive placeholders, NEVER real.
- [ ] **Step 4: `docs/STAGING_SETUP.md`** — sections: why (dev-points-at-prod risk + the new guard), creating a Neon branch as staging, Vercel env scoping (production vs preview), sandbox platform apps note, pointing `.env.local` at staging, `DEV_DB_OK=1` escape hatch, E2E env vars recap (link `app/e2e/README.md`).
- [ ] **Step 5: Full gate** (lint must not flag the script — if eslint's config covers `scripts/`, conform; if not, note it). **Commit** `chore(env): dev-db guard, .env.example, staging runbook`.

### Task C1: Keyset cursor on GET /api/posts (branch `feat/activity-pagination`, worktree)

**Files:**
- Modify: `app/src/lib/postsDto.ts` (add `nextCursor: string | null` to `PostsResponse`; add + export `encodePostsCursor(createdAt: Date, id: string): string` and `decodePostsCursor(cursor: string): { createdAt: Date; id: string } | null`)
- Modify: `app/src/app/api/posts/route.ts:24-91` (GET only)
- Modify: `app/src/app/api/posts/route.test.ts`

**Interfaces:** Produces for C2: `PostsResponse.nextCursor`; query param `?cursor=`; cursor helpers above. `POSTS_PAGE_SIZE` stays 50.

- [ ] **Step 1: Failing tests.** Cursor helpers (pure, in a new `describe` in the route test file or `postsDto.test.ts` — implementer's call, name it in the report): round-trip encode/decode; decode returns null for garbage/invalid-date/missing separator. Route: no cursor → `findMany` called WITHOUT keyset where + `take: 51` (PAGE+1), 51 rows mocked → response has 50 jobs + `nextCursor === encodePostsCursor(row50.createdAt, row50.id)`; 50 rows mocked → `nextCursor: null`; with `?cursor=` → `findMany` where includes `OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }]` AND `orderBy: [{ createdAt: "desc" }, { id: "desc" }]`; garbage cursor → 400 `{ error: "Invalid cursor." }` with NO db call; `?status=` composes with cursor (both in where). RED.
- [ ] **Step 2: Implement.** Cursor: `Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url")`; decode splits on the FIRST `|`, `new Date(part)` must be valid. Keep the existing metric join + DTO mapping untouched — only the query window and the response envelope change. GREEN + full suite.
- [ ] **Step 3: Full gate.** Step 4: **Commit** `feat(posts): keyset cursor pagination on GET /api/posts (additive)`.

### Task C2: Load more in activity + queue

**Files:**
- Modify: `app/src/hooks/usePostJobs.ts` (add `loadMore`, `hasMore`, `loadingMore`; poll merges by id)
- Modify: `app/src/app/activity/activity-view.tsx` (Load more button)
- Modify: `app/src/app/queue/queue-view.tsx:280-300` area (its own fetch gains cursor + Load more)

**Interfaces:** Consumes C1's `nextCursor` + `?cursor=`. READ `usePostJobs.ts` fully first — it has poll re-arm logic from the UX-fixes program; preserve its behavior for page 1.

- [ ] **Step 1: Hook.** State adds `nextCursor` + `loadingMore`. `loadMore()`: guard (`!nextCursor || loadingMore`), fetch `/api/posts?cursor=…`, APPEND jobs deduped by id (a poll may have prepended rows that also appear in the page — drop duplicates keeping the FIRST occurrence), set new `nextCursor`. Poll refresh (existing interval): fetches page 1, then `setJobs(prev => merge(pageOne, prev))` where merge = pageOne order first, then every prev row not in pageOne (preserves the appended tail; page-1 statuses stay fresh). Document the accepted deep-tail staleness in a comment (spec §C).
- [ ] **Step 2: UI.** Both views: below the list, when `hasMore`: `<Button variant="outline" size="sm" loading={loadingMore} onClick={loadMore}>Load more</Button>` (sentence case); keep each view's existing empty/error states untouched. Queue: replicate the same cursor/append/dedup logic in its local fetch (it filters `?status=scheduled,draft` — cursor composes per C1).
- [ ] **Step 3: Full gate** (no component tests by repo convention; suite must stay green). Step 4: **Commit** `feat(activity): load more via cursor pagination (activity + queue)`.

### Task D1: Role management API + owner-leave (branch `feat/workspace-multi-owner`, worktree)

**Files:**
- Modify: `app/src/app/api/workspaces/members/[userId]/route.ts` (ADD `PATCH`; DELETE untouched)
- Create/extend: `app/src/app/api/workspaces/members/[userId]/route.test.ts`
- Modify: `app/src/app/api/workspaces/leave/route.ts` + `route.test.ts`
- Modify: `app/src/lib/workspace.test.ts` (add the promoted-member `resolveActiveMembershipId` table case: personal owned membership older than a shared owned membership → personal still wins)

**Interfaces:** Produces `PATCH /api/workspaces/members/[userId]` `{ role: "owner" | "member" }` → 200 `{ ok: true, role }`; used by D2.

- [ ] **Step 1: Failing tests.** PATCH: 401/403 via `requireOwnerContext` mock (gate response passthrough, members-route precedent); rate limit `{ route: "workspaces/members", limit: 60, windowMs: 300000 }` per user, blocked → 429 before ANY db work; body validation (`role` not in the enum → 400); target not a member of the active workspace → 404; no-op (already that role) → 200 idempotent, NO write; promote member→owner → `updateMany({ where: { workspaceId, userId: target, role: "member" }, data: { role: "owner" } })` count 1 → 200; demote inside `$transaction`: `$executeRaw` advisory lock `ws-owners:<workspaceId>` asserted FIRST, then owner-count re-read INSIDE, count 1 (target is last owner) → 400 `{ error: "Promote another owner first." }` and no write; count ≥2 → conditional updateMany → 200; self-demote follows the same path (allowed when another owner exists). leave: member fast path byte-unchanged (existing tests keep passing); owner + no other owner → 400 "Transfer ownership before removing yourself." (existing string); owner + another owner exists → transaction with the SAME advisory lock, other-owner count re-read inside, own row deleted by id, cookie cleared → 200 `{ left: true }`. Mock `$transaction` as callback-invoker + `$executeRaw` spy (posting.test.ts precedent). RED.
- [ ] **Step 2: Implement.** Lock exactly: `` tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-owners:${workspaceId}`}))` `` (string interpolation INSIDE the tagged template arg, `ensurePersonalWorkspace` precedent at `src/lib/workspace.ts:157`). Demote-vs-remove invariant comment: removal still requires demote-first (DELETE route untouched — update ONLY its stale doc comment lines 20-26 to note multi-owner now exists and demotion is the explicit flow it anticipated). GREEN + full suite.
- [ ] **Step 3: Full gate.** Step 4: **Commit** `feat(workspace): co-owner role management + owner leave (advisory-locked last-owner guard)`.

### Task D2: Team UI for co-owners

**Files:**
- Modify: `app/src/components/team-section.tsx` (OwnerView member rows: role actions; OwnerView gains Leave block; MemberView untouched)

**Interfaces:** Consumes D1's PATCH endpoint. The members list (`GET /api/workspaces/members`) already returns `role` — client derives `ownerCount = members.filter(m => m.role === "owner").length`.

- [ ] **Step 1: Implement.** Member rows (role "member"): add ghost Button "Make owner" → ConfirmDialog (non-destructive) title `Make ${name} an owner?`, description "They'll be able to manage members, connections, and settings.", confirm → PATCH `{ role: "owner" }`, update local state + toast "Role updated." Owner rows: ghost Button "Make member" (destructive styling) → ConfirmDialog title `Make ${name} a member?`, description "They'll no longer manage members, connections, or settings."; DISABLED with `title="Promote another owner first."` when that row is the only owner. Keep Remove exactly as-is (member rows only). New Leave block at the card bottom (mirrors MemberView's markup + ConfirmDialog copy verbatim): Button disabled with visible helper text "You're the only owner — promote someone first." when `ownerCount < 2`. All copy sentence case.
- [ ] **Step 2: Full gate** (no component tests; suite green + lint + build + tsc). Step 3: **Commit** `feat(workspace): team UI for promote/demote + owner leave`.

---

## Self-review

- Spec coverage: §A→A1-A3 (model/libs/reset/verify/banner/register hook/public prefixes), §B→B1 (guard/predev/example/runbook), §C→C1-C2 (cursor/envelope/hook/both views), §D→D1-D2 (PATCH/leave/lock/UI/doc-comment update + resolveActiveMembershipId case). Accepted debts carried into task text (JWT survival documented in A2 route comment; deep-tail staleness in C2 comment).
- No placeholders; every code step shows code or byte-exact strings; interface names consistent across tasks (issueAccountToken/deliverAccountEmail/encodePostsCursor/nextCursor).
- Right-sizing: each task independently gateable; D1 carries the concurrency risk and is isolated from UI.
- Cross-group file overlap: none (verified against the spec's isolation section).
