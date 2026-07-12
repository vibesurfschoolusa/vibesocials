# Team Workspaces — Design

**Goal:** Other people can sign up and use Vibe Socials. First concrete use case: the owner's own team publishes to the business's connected social accounts. Open registration stays; every account works standalone; invite links add people to a shared workspace.

**Approved by owner 2026-07-12** (audience: own team/business · membership: invite links · permissions: members post freely, admin stays owner-only).

## 1. Model

- **Workspace** — the tenant. Owns connections, media, posts, metrics, and brand settings (caption footer). Every user gets a personal workspace at registration (and existing users get one via backfill), so solo use is unchanged.
- **WorkspaceMember** — (workspace, user, role). Roles: `owner` | `member`. The creator is `owner`. One membership row per (workspace, user).
- **WorkspaceInvite** — owner-created join token: random 43-char base64url token (32 bytes), SHA-256 hash stored (raw token appears only in the copied link), 7-day expiry, unlimited uses until revoked or expired, `revokedAt` for revocation.
- **Active workspace** — a user may belong to several workspaces (personal + invited). The active one is selected via an httpOnly cookie `vs_active_workspace` (workspace id), set by `POST /api/workspaces/switch`. Every server read validates membership per request — the cookie is a hint, never an authority. Invalid/missing cookie falls back to the user's personal (oldest owned) workspace.

### Permission matrix

| Action | member | owner |
|---|---|---|
| Compose / publish / schedule / draft / cancel / edit queue / retry | ✅ | ✅ |
| Upload media, use library, delete **own** uploads | ✅ | ✅ |
| Delete anyone's media | ❌ | ✅ |
| Reply to Google reviews (incl. AI draft) | ✅ | ✅ |
| View connection health | ✅ (read-only) | ✅ |
| Connect / disconnect / switch platform accounts, GBP location | ❌ | ✅ |
| Workspace settings (caption footer/hashtags, workspace name) | ❌ | ✅ |
| Invites: create/revoke; members: list emails/remove | ❌ | ✅ |
| Leave workspace | ✅ | only if another owner exists (v1: sole owner cannot leave; ownership transfer is out of scope) |
| Per-user email notification preference | ✅ (own) | ✅ (own) |

## 2. Data model changes (Prisma / Postgres)

New models:

```prisma
enum WorkspaceRole { owner member }

model Workspace {
  id              String   @id @default(cuid())
  name            String
  companyWebsite  String?   // caption footer moves here (brand-level)
  defaultHashtags String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  members     WorkspaceMember[]
  invites     WorkspaceInvite[]
  connections SocialConnection[]
  mediaItems  MediaItem[]
  postJobs    PostJob[]
  postMetrics PostMetric[]
}

model WorkspaceMember {
  id          String        @id @default(cuid())
  workspaceId String
  userId      String
  role        WorkspaceRole @default(member)
  createdAt   DateTime      @default(now())
  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([workspaceId, userId])
  @@index([userId])
}

model WorkspaceInvite {
  id          String    @id @default(cuid())
  workspaceId String
  tokenHash   String    @unique // sha256 hex of the raw token
  createdById String
  expiresAt   DateTime
  revokedAt   DateTime?
  usedCount   Int       @default(0)
  createdAt   DateTime  @default(now())
  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
}
```

Changed models: `SocialConnection`, `MediaItem`, `PostJob`, `PostMetric` each gain `workspaceId String` + relation (onDelete: Cascade) + index. **`userId` stays on all four as creator/uploader attribution** (semantics change only). `SocialConnection`'s unique moves from `[userId, platform]` to `[workspaceId, platform]`. `PostMetric` gains `@@index([workspaceId])` (the `[userId]` index is dropped from the schema; the DB index is left in place — dropping it is a later cleanup). `User.companyWebsite`/`defaultHashtags` stay as dead columns (no destructive drop this program); the workspace copies become the source of truth.

### Migration + backfill (single migration dir, hand-authored SQL, applied via `prisma migrate deploy` at release time — NEVER `migrate dev`)

1. Create enum + 3 tables.
2. Add **nullable** `workspaceId` to the 4 tables.
3. Backfill in SQL: for every `User`, insert a `Workspace` (`name = COALESCE(NULLIF(name,''), split_part(email,'@',1)) || '''s workspace'`, copying `companyWebsite`/`defaultHashtags`) + an `owner` membership; set `workspaceId` on all 4 tables via the creator's personal workspace.
4. Set `workspaceId` NOT NULL, add FKs, indexes, and the new `SocialConnection` unique (drop the old one).

New-user provisioning: the register route creates User + personal Workspace + owner membership in one transaction. Because registration is open TODAY, the code must also self-heal: `getWorkspaceContext` lazily provisions a personal workspace for any user without one (covers accounts created between deploy and migration, and makes ordering safe either way).

## 3. Authorization layer

New `src/lib/workspace.ts`:

```ts
export interface WorkspaceContext {
  user: User;                     // as getCurrentUser returns
  workspace: { id; name; companyWebsite; defaultHashtags };
  role: WorkspaceRole;
  memberCount: number;            // for attribution display gating
}
// role option gates: requireRole: "owner" → 403 for members
export async function getWorkspaceContext(opts?: { requireRole?: "owner" }): Promise<WorkspaceContext | null>
```

Resolution: session user → memberships → active id from `vs_active_workspace` cookie if it matches a membership, else personal (oldest owned) workspace (lazily provisioned if absent). API routes replace `getCurrentUser()` with this and swap `where: { userId }` → `where: { workspaceId }`. Pages keep `getCurrentUser()` for auth gates; workspace resolution happens in the APIs and server components that need data.

## 4. API surface

New (all JSON; route tests for each):
- `GET /api/workspaces` — memberships for the switcher: `[{ id, name, role, isActive }]`.
- `POST /api/workspaces/switch` `{ workspaceId }` — membership-checked; sets cookie; 403 otherwise.
- `PATCH /api/workspaces/active` `{ name }` — owner; renames the active workspace (1–60 chars). Footer fields are NOT here — they stay on `POST /api/settings`.
- `GET|POST|DELETE /api/workspaces/invites` — owner. POST → `{ url, expiresAt }` (single active invite policy: creating revokes prior ones); GET → active invite if any; DELETE → revoke.
- `GET /api/invites/[token]` — auth required; preview `{ workspaceName, alreadyMember }`; 404 for invalid/expired/revoked (no oracle beyond validity).
- `POST /api/invites/[token]/accept` — auth required; validates hash+expiry+revocation; creates `member` membership (idempotent if already a member); increments `usedCount`; switches active-workspace cookie; rate-limited (route `invites/accept`, 10/5min per user).
- `GET /api/workspaces/members` — owner: `[{ userId, email, name, role, joinedAt }]`. `DELETE /api/workspaces/members/[userId]` — owner; cannot remove self.

Rescoped (workspace filter + role gates; response DTOs unchanged unless noted):
- `GET/POST /api/posts` + `[postJobId]` PATCH/DELETE/cancel/publish/retry — any member. PostJob DTO gains `createdBy: { name: string } | null` — always included (name falls back to the email local-part; never the full email in the DTO); the UI decides when to show it (§7: only in >1-member workspaces).
- `GET/POST /api/media`, `DELETE /api/media/[id]` — any member; delete requires `item.userId === user.id` unless owner. Reuse (`GET /api/media/[id]`) — any member.
- `GET /api/connections`, tiktok creator-info — any member (read). `DELETE /api/connections/[platform]`, GBP location GET/POST, all 7 `/api/auth/*/start` — **owner**.
- `POST /api/settings` — **owner**; writes footer fields to the Workspace; `notifyOnPostComplete` continues writing to the User row (any member, own row). GET settings page splits accordingly.
- Reviews routes — any member; they read the workspace's GBP connection.

## 5. OAuth state

`createOAuthState(userId)` → `createOAuthState({ userId, workspaceId })`; payload `{ userId, workspaceId, ts }` (same HMAC envelope; verify returns both). Start routes: `getWorkspaceContext({ requireRole: "owner" })`. Callbacks: after `verifyOAuthState`, re-check the user is still an **owner** of that workspace before writing; connection upsert keys on `[workspaceId, platform]` and stamps both `workspaceId` and `userId` (connector attribution). Old-format states (no workspaceId) fail verification → existing `*_invalid_state` redirect (10-minute state TTL makes a deploy-boundary mismatch a non-event).

## 6. Server jobs

- `posting.ts`: job creation + `prepareDeferredPostJobDispatch` load the PostJob's `workspaceId` and fan out over `socialConnection.findMany({ where: { workspaceId } })` (3 sites). `PostJob.workspaceId` set at creation from the context.
- `inngest-functions.ts` (`publishToAllPlatforms` + retry): connection lookups move to the job's `workspaceId`; result rows still bound fan-out.
- `metricsScanner`: iterate youtube connections (now workspace-scoped); `PostMetric` rows stamp `workspaceId` (+ keep `userId` = connection's connector for legacy compat).
- `postOutcomeEmail`: recipient stays the **job creator** (`PostJob.userId` → User email + `notifyOnPostComplete` pref) — the person who pressed publish gets the outcome mail. Unchanged pipeline otherwise.
- `mediaRetention`: unaffected (item/job scoped).

## 7. UI

- **Account menu**: workspace section — current workspace name; if >1 membership, a switcher list (radio-style, calls switch + `router.refresh()`).
- **Settings → Team section** (new card, below Connections): owner sees a workspace-name field (inline rename, saves via PATCH /api/workspaces/active), the invite-link block (Create/Copy/Revoke, expiry shown) + member list (name/email, role badge, Remove with ConfirmDialog: "They'll lose access to this workspace's accounts and posts. Their own account keeps working."); members see the member list (names only) + "Only the workspace owner can manage members."
- **Settings → Captions + Connections**: owner-only mutation. Members see the caption footer read-only (it affects their posts' preview) and connection rows without Connect/Disconnect/Switch buttons.
- **Join page** `/join/[token]`: server-gated (redirect to `/login?callbackUrl=/join/<token>` signed out). Shows "Join {workspace name}?" + Join/Cancel; error state for invalid/expired invite; on join → toast + redirect `/` with the new workspace active.
- **Attribution**: queue + activity cards show `by {name}` (muted, next to timestamp) when the workspace has >1 member.
- **Workspace name** shown in the top bar next to the section title? No — only in the account menu (avoid crowding mobile).
- Composer/preview: no changes (they already ride `useConnections` → now workspace-scoped server-side).

## 8. Testing

- Pure: invite token hash/expiry/revocation validators; context resolution (cookie valid/invalid/absent/foreign); permission matrix as a table-driven test on the shared `assertWorkspaceRole` helper.
- Route tests (existing conventions, mocked prisma): every new route (switch 403, accept idempotency/expiry/revoked, members owner-gating, self-removal 400) + updated mocks for every rescoped route (the big mechanical cost: existing route tests mock `getCurrentUser` — a shared `mockWorkspaceContext` test helper keeps this tractable).
- Jobs: posting fan-out by workspaceId (extend the targeting trio), deferred dispatch, metrics stamping.
- E2E: extend `core-flows.spec.ts` scaffold with an invite→join→post-attribution flow (skipped, like the rest); public smoke unchanged.

## 9. Rollout (gated)

1. Ship branch → PR → merge (code is backward-safe pre-migration ONLY behind lazy provisioning; still, order is migrate-then-deploy like the roadmap release).
2. **Gated step (owner confirms before execution):** `prisma migrate deploy` against prod Neon, then merge/deploy.
3. Post-deploy checks: owner sees personal workspace with all existing data; create invite; join with a second account; member publishes to a connected platform; member blocked from Connections mutations.

## 10. Out of scope (explicit)

Billing/plans; email-sending invites; email verification; password reset; ownership transfer / multi-owner; per-member post-approval workflow (deferred option "approval toggle"); platform app reviews (TikTok audit, Google verification, Meta review — required only when strangers connect their OWN accounts); quotas; audit log.
