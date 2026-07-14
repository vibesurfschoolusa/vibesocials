# Vibe Socials – Project Overview

## Purpose

Vibe Socials lets a logged-in user upload media + caption once and publish to multiple social platforms (TikTok, YouTube, X, LinkedIn, Instagram, Google Business Profile, Facebook Page) using connected accounts. Team **workspaces** share connections, media, and brand footer settings via invite links.

## Tech stack

| Layer | Choice |
|-------|--------|
| Language | TypeScript |
| Framework | Next.js App Router |
| DB | PostgreSQL + Prisma (Neon in production) |
| Auth | NextAuth v4 credentials (JWT) |
| Media | Vercel Blob (client direct upload); local FS in dev |
| Jobs | Inngest (publish fan-out, retention, metrics, scheduled scanner) |
| Email | Resend (optional; env-gated) |
| Monitoring | Sentry (optional; env-gated) |

## Current product surface

| Area | Status |
|------|--------|
| Multi-platform publish (7 platforms) | Done |
| Client direct-to-Blob uploads | Done |
| Background publish via Inngest | Done |
| Scheduling, drafts, queue, cancel, retry | Done |
| Media library + retention sweep | Done |
| Team workspaces (owner/member, invites, co-owners) | Done |
| Connection health / reconnect flags | Done |
| Google review list + reply + AI draft | Done |
| YouTube engagement metrics (hourly cron) | Done (YouTube only) |
| Password reset + soft email verification | Done |
| Activity keyset pagination | Done |

### Platform maturity notes

- **TikTok**: sandbox / Creator inbox draft flow until production approval.
- **LinkedIn**: company-page posting needs Community Management API access.
- **Metrics**: YouTube only in v1; other platforms are not synced yet.

## High-level architecture

```
Browser → Next.js pages + API routes
              ↓
         getWorkspaceContext (session + active workspace cookie, re-validated)
              ↓
         Prisma / Postgres (workspace-scoped tenants)
              ↓
         Inngest steps → platform clients → social APIs
              ↓
         Vercel Blob (media)
```

### Auth model

- Email + password (bcrypt). Emails stored **normalized** (`trim` + lowercase).
- JWT sessions carry `id` + `sessionVersion`. Password reset increments `sessionVersion`; `getCurrentUser` rejects stale JWTs.
- Soft email verification when Resend is configured (banner + **live publish** gated on `emailVerifiedAt`).
- Social OAuth is separate; `state` is HMAC-signed and carries `userId` + `workspaceId` (X OAuth 1.0a uses server-side `OAuthHandshake` instead of cookies).

### Workspaces

- Every user gets a personal workspace at registration.
- Active workspace: httpOnly cookie `vs_active_workspace` (hint only; membership always re-checked).
- Roles: `owner` (connections, settings, invites, member management) and `member` (compose/publish, own media delete, reviews).
- Connections are **one per platform per workspace** (shared by members).

### Data model (core)

- `User` — credentials, notification prefs, `sessionVersion`, `emailVerifiedAt`
- `Workspace` / `WorkspaceMember` / `WorkspaceInvite`
- `SocialConnection` — OAuth tokens (**encrypted at rest** when `TOKEN_ENCRYPTION_KEY` is set)
- `MediaItem` — blob URL, captions, soft-delete / retention fields
- `PostJob` / `PostJobResult` — immediate, draft, scheduled, cancelled statuses
- `PostMetric` — denormalized engagement snapshots (survives disconnect)
- `AccountToken` — password reset / email verify (hash-only storage)
- `RateLimitEntry` — fixed-window counters

### Posting flow

1. Client uploads media via `@vercel/blob/client` → `/api/upload` (token only).
2. Client `POST /api/posts` with allowlisted `blobUrl` (or reuse `mediaItemId`), caption, optional schedule/draft/platforms.
3. Server creates `MediaItem` + `PostJob` (+ results for immediate jobs) and enqueues Inngest.
4. Inngest steps re-load connections from DB (tokens never serialized in step output) and publish per platform.
5. Activity/queue UI polls `GET /api/posts` (keyset pagination).

### Security practices

- SEC-1 DTOs: API never returns access tokens, refresh tokens, or raw connection secrets.
- Blob URL host allowlist (`isAllowedBlobUrl`) on media/posts create.
- Rate limits on publish, invites, and **fail-closed** limits on anonymous auth routes (register / forgot / reset / verify).
- Logger key-based redaction for secret-shaped fields.
- Middleware gates non-public app pages; API routes still enforce session themselves.

## Configuration

All secrets via environment variables (see `app/.env.example`). Never commit real values.

Notable:

- `TOKEN_ENCRYPTION_KEY` — production **required** for OAuth token encryption (seal throws if missing in production)
- `BLOB_ALLOWED_HOSTS` — optional extra media hosts
- `XAI_API_KEY` / `OPENAI_API_KEY` — AI captions (SpaceXAI preferred)
- `DEV_DB_OK=1` — override for local dev against a remote (staging) DB

**Ops:** `npm run build` does **not** run migrations. Deploy checklist: `npx prisma migrate deploy`, set `TOKEN_ENCRYPTION_KEY`, redeploy, smoke auth + publish.

## Repo layout

```
app/                 Next.js application
  src/app/           Pages + API routes
  src/components/    UI
  src/lib/           Shared helpers (auth, workspace, DTOs, crypto)
  src/server/        Platform clients, jobs, storage, notifications
  prisma/            Schema + migrations
docs/                Setup guides, design specs, plans
```

## Future enhancements (not implemented)

- Billing / plans
- SSO / Google Sign-In for app users
- Ownership transfer UI (beyond co-owner leave)
- Metrics for non-YouTube platforms
- X thread support for long captions; X chunked upload for large media
