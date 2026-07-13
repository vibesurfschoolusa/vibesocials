# Scale readiness — design (auth lifecycle · env safety · pagination · multi-owner)

**Owner-approved 2026-07-13** (three pivotal choices made interactively: email verification = **soft banner only**;
multi-owner = **full co-owners**; reset/verify links = **fragment tokens**). Everything else below was settled from
codebase conventions with alternatives recorded. Four independent PR groups, all branched from `main` @ `f5dd5ae`.

Shared constraints: SEC-1 DTO discipline; sentence-case copy; route tests mock `@/lib/workspace`/`@/lib/db`/`@/lib/rateLimit`;
gate at every task boundary (vitest all green — 600 baseline, lint 0 errors, build clean, tsc 0); migrations AUTHORED ONLY
(offline `prisma migrate diff` verification; applied at the gated release step); TDD for all server/lib work.

---

## A. Auth account lifecycle — `feat/auth-account-lifecycle`

**Why:** real customers need self-service recovery; verification makes reset emails trustworthy and is the
foundation for later anti-abuse gates. Everything is **env-gated on `RESEND_API_KEY`** (mirror
`deliverPostOutcomeNotification`'s fail-safe: return before any work when unset) so the app is byte-identical
in behavior until the owner configures email.

### Data model (one migration, authored only)

```prisma
enum AccountTokenType { password_reset email_verify }

model AccountToken {
  id        String           @id @default(cuid())
  userId    String
  type      AccountTokenType
  tokenHash String           @unique   // sha256 hex of the raw token — raw never stored (invite precedent)
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime         @default(now())
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, type])
}
```

`User` gains `emailVerifiedAt DateTime?`. Migration backfills `emailVerifiedAt = now()` for ALL existing users
(grandfathered — they predate verification; blocking them retroactively would be hostile).
Rejected alternative: two separate token models — one model + type enum keeps the single-active policy and
sweep logic in one place. Rejected: reusing WorkspaceInvite's table — different lifecycle/cardinality.

### Token + email libs

- `src/lib/accountToken.ts`: `createAccountToken()` (32-byte base64url raw) + `hashAccountToken()` (sha256 hex) —
  mirrors `inviteToken.ts` deliberately WITHOUT extracting a shared abstraction (security-critical 10-liners;
  blast radius over DRY). Expiries: password_reset **60 min**, email_verify **7 days**. Single-active policy:
  issuing a token deletes the user's prior unused tokens of the same type.
- `src/lib/accountEmails.ts`: pure builders `buildPasswordResetEmail` / `buildVerifyEmail`
  (subject + html + text, links below) + `deliverAccountEmail` (Resend, `NOTIFICATIONS_FROM`, `NEXTAUTH_URL`
  base with trailing-slash trim — all mirroring `postOutcomeEmail.ts`). Builders are pure and unit-tested;
  delivery is fail-safe and never throws into a caller.

### Links (owner decision: fragment)

`{NEXTAUTH_URL}/reset-password#<raw-token>` and `{NEXTAUTH_URL}/verify-email#<raw-token>`.
Fragments never reach server/CDN access logs; the pages read `location.hash` client-side and POST the token
in the body. Consistent with the invite-token concern already on file (2026-07-12 spec §5).

### Routes (all JSON; route tests each; no user-existence oracle anywhere)

| Route | Auth | Rate limit (per `checkRateLimit`) | Behavior |
| --- | --- | --- | --- |
| `POST /api/auth/forgot-password` `{ email }` | anonymous | `auth/forgot` 3/15min keyed `email:<lowercased>` AND `auth/forgot-ip` 10/15min keyed `ip:<x-forwarded-for first hop, else "unknown">` | Always `200 { ok: true }`. If the user exists AND email is configured: issue token + send. |
| `POST /api/auth/reset-password` `{ token, password }` | anonymous | `auth/reset` 10/15min keyed `ip:<…>` | Validate password with the register route's exact rules; hash token → active row (type, unused, unexpired) → **conditional `updateMany` marks used** (TOCTOU-safe, invite-accept precedent) → bcrypt cost 10 → update `passwordHash`; delete other active reset tokens; set `emailVerifiedAt` if null (a completed reset proves mailbox ownership). Uniform `400 { error: "This link is invalid or has expired." }` for every failure shape. |
| `POST /api/auth/verify-email` `{ token }` | anonymous (token is the credential) | `auth/verify` 10/15min keyed `ip:<…>` | Hash → active email_verify row → mark used + set `emailVerifiedAt`. Uniform 400 as above. 200 `{ ok: true }`. |
| `POST /api/auth/resend-verification` | session required | `auth/resend-verify` 3/15min per user id | 400 if already verified; 503 `{ error: "Email sending is not configured." }` when `RESEND_API_KEY` unset; else issue + send. |
| `GET /api/auth/account-status` | session required | none (cheap read) | `{ emailVerified: boolean, verificationAvailable: boolean }` (`verificationAvailable = Boolean(RESEND_API_KEY)`). Exists because the JWT session carries no verification flag and must not (stale-until-relogin problem); the banner fetches this instead. |

Register route change: after the existing user+workspace transaction commits, fire-and-forget issue+send of the
verification email inside try/catch — it must NEVER fail or delay registration (notification-hook B1 lesson).

### Pages / UI (public prefixes updated in `shell/nav.ts`)

- `/forgot-password`: email form → always the same success copy ("If an account exists for that address, we
  sent a reset link."). Linked from the login page ("Forgot password?").
- `/reset-password`: client page; reads `location.hash`; no token → error card linking to `/forgot-password`;
  else new-password + confirm form → POST → success card linking to `/login`.
- `/verify-email`: client page; reads hash, auto-POSTs once on mount; success/error cards (error copy points at
  the in-app resend banner).
- **Banner (soft, owner decision):** in the authed app shell, when `account-status` says
  `{ emailVerified: false, verificationAvailable: true }` → slim `Alert` with "Verify your email — check your
  inbox." + "Resend email" button. Nothing is blocked. No banner when email isn't configured (nothing the user
  could do about it).

**Accepted debt (documented):** outstanding JWT sessions survive a password reset (next-auth v4 JWT strategy has
no server-side revocation; 30-day token maxAge bounds it). Recorded for a future session-version claim.

## B. Env safety — `chore/env-safety`

**Why:** `app/.env.local` points local dev at PRODUCTION. One typo'd `npm run dev` is a prod incident.

- `app/scripts/dev-db-guard.mjs` (zero-dep Node, ~60 lines, `--env-file` flag for testing): parses `.env.local`,
  extracts `DATABASE_URL` host. Allows: no file / no var / `localhost` / `127.0.0.1`. Otherwise prints a loud
  banner naming the remote host and **exits 1** unless `DEV_DB_OK=1`. Wired as `"predev"` in `app/package.json`
  (hooks only `npm run dev`; build/start/Vercel untouched).
- `app/.env.example`: every env var the app reads (implementer greps `process.env.` across `src/` + config for
  the authoritative list), grouped + commented, no real values.
- `docs/STAGING_SETUP.md`: runbook — Neon branch as staging DB, Vercel env scoping (preview vs production),
  sandbox platform apps, pointing `.env.local` at staging, the `DEV_DB_OK` escape hatch, E2E env recap.
- Verification: no vitest (script is outside `src/` glob and deliberately trivial); the plan's gate step runs the
  script against three fixture env files (localhost → pass, remote → exit 1, remote+DEV_DB_OK → pass) and the
  standard build/lint/tsc gate.

## C. Activity/queue pagination — `feat/activity-pagination`

**Why:** `GET /api/posts` hard-caps at 50; real usage scrolls past it.

- **Keyset cursor** (rejected: offset — skips/dupes under concurrent inserts; rejected: Prisma `cursor` option —
  needs the row to still exist; keyset is deletion-proof). Total order `ORDER BY createdAt DESC, id DESC`.
  Cursor = `base64url("<createdAt ISO>|<id>")`, issued by the server only. `?cursor=` invalid → `400
  { error: "Invalid cursor." }`.
- Page mechanics: fetch `POSTS_PAGE_SIZE + 1`, slice, `nextCursor` from the last returned row or `null`.
  `PostsResponse` gains `nextCursor: string | null` (additive; existing consumers unaffected). Metric join stays
  per-page. `?status=` filter composes with the cursor unchanged.
- `usePostJobs`: adds `loadMore()`, `hasMore`, `loadingMore`. Poll refresh keeps fetching page 1 and **merges by
  id** (updates statuses of any loaded row it sees, prepends genuinely new rows, never truncates the appended
  tail). Accepted: a deep-tail row's status can go stale until reload — pending/retrying jobs live near the head
  by recency, so the poll's purpose is preserved; documented in the hook.
- UI: "Load more" `Button` (outline, loading state) under the activity list and the queue list when `hasMore`;
  queue's own fetch gains the same cursor handling. Dashboard recent-activity (first page slice) unchanged.

## D. Workspace multi-owner — `feat/workspace-multi-owner` ⚠️ permission-matrix change (owner-approved 2026-07-13)

Matrix deltas vs the team-workspaces spec §1 ("full co-owners" option):

| Action | Before | After |
| --- | --- | --- |
| Promote member → owner | — (impossible) | owner ✅ |
| Demote owner → member | — | owner ✅, **never the last owner** (incl. self-demote when another owner exists) |
| Leave workspace | member only; sole owner blocked | member ✅; **owner ✅ when another owner remains** |
| Remove member (DELETE) | owner, non-owner targets only | unchanged — demote first, then remove (single invariant) |

- **`PATCH /api/workspaces/members/[userId]` `{ role: "owner" | "member" }`** — `requireOwnerContext`; rate
  limit `workspaces/members` 60/5min per user; 404 for non-members of the active workspace (no oracle); no-op
  role → 200 idempotent. **Demote path runs inside a transaction holding
  `pg_advisory_xact_lock(hashtext('ws-owners:<workspaceId>'))`** and re-counts owners INSIDE the lock — two
  concurrent demotes/leaves cannot race the workspace to zero owners (`ensurePersonalWorkspace` / single-active
  invite precedent). Sole-owner demote → `400 { error: "Promote another owner first." }`.
- **`POST /api/workspaces/leave` rework:** members unchanged (fast path). Owner callers enter the same
  advisory-locked transaction: count OTHER owners inside the lock → 0 → existing 400 ("Transfer ownership
  before removing yourself."); ≥1 → delete own membership row by id. Cookie-clear behavior unchanged.
- **`getWorkspaceContext` fallback check (no code change expected):** "oldest owned membership" — a promoted
  member's shared-workspace membership could predate nothing: personal workspaces are provisioned at
  registration, so the personal membership is always the oldest owned row. Verified in design; the implementer
  asserts it with a table-driven `resolveActiveMembershipId` test case (promoted-member scenario).
- Ripple check (all verified role-generic, no changes needed): `requireOwnerContext`, `isWorkspaceOwner`
  (OAuth callbacks), invites (any owner manages), settings, roster/members DTOs (role field already flows).
- UI (`team-section.tsx` OwnerView): member rows gain "Make owner" (ConfirmDialog: "They'll be able to manage
  members, connections, and settings."); owner rows gain "Make member" (ConfirmDialog; disabled with reason
  when target is the last owner — client knows owner count from the members list; server enforces regardless).
  OwnerView gains the "Leave workspace" block (mirrors MemberView's), disabled with reason while sole owner.
  MemberView unchanged.

## Sequencing & isolation

Main checkout: A (tasks A1 schema/libs → A2 reset flow → A3 verification), then B (single task).
Worktree: C (C1 API → C2 UI), then D (D1 API → D2 UI) sequentially in the same worktree (disk budget).
File overlap between groups: none (A: auth/schema/shell-banner · B: scripts/package.json/docs · C:
posts route/postsDto/hook/activity/queue · D: workspaces routes/team-section). All PRs held for owner;
A's migration applied only at the gated release step.
