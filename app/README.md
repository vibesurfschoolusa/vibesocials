# Vibe Socials (app)

Multi-platform social publishing: upload media once, caption once, post to TikTok, YouTube, X, LinkedIn, Instagram, Google Business Profile, and Facebook Page. Supports team workspaces, scheduling/drafts, media library, Google review replies, and YouTube engagement metrics.

## Stack

- **Next.js** (App Router) + React + TypeScript + Tailwind
- **PostgreSQL** via Prisma (Neon in production)
- **NextAuth** credentials auth (JWT sessions)
- **Vercel Blob** for media (client direct upload)
- **Inngest** for async multi-platform publish, retention, metrics cron
- **Resend** for password reset / verification / post-outcome email (optional)
- **Sentry** for error reporting (optional)

## Getting started

```bash
cp .env.example .env.local
# Fill DATABASE_URL (local or staging — never production), NEXTAUTH_SECRET, etc.
npm install
npx prisma migrate deploy   # or prisma migrate dev for local schema work
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

`npm run dev` runs a **predev guard** that refuses a remote `DATABASE_URL` unless `DEV_DB_OK=1`. See `docs/STAGING_SETUP.md`.

### Important env vars

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection string |
| `NEXTAUTH_SECRET` | Session JWT signing |
| `NEXTAUTH_URL` | Canonical app URL |
| `TOKEN_ENCRYPTION_KEY` | AES key for OAuth tokens at rest (`openssl rand -base64 32`) — **required in production** (seal fails hard if missing) |
| `XAI_API_KEY` | Preferred LLM for captions / review drafts (falls back to `OPENAI_API_KEY`) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob |
| `BLOB_ALLOWED_HOSTS` | Optional extra hosts for `blobUrl` allowlist |
| `RESEND_API_KEY` | Email delivery (reset / verify / notifications) |
| Platform OAuth vars | See `.env.example` |

## Scripts

```bash
npm run dev          # local server (+ DB guard)
npm run build        # prisma generate + next build
npm test             # vitest unit suite
npm run test:e2e     # playwright
npm run lint
```

## Architecture (short)

- UI routes under `src/app/` (dashboard, composer, queue, activity, media, reviews, settings)
- API under `src/app/api/` (auth, OAuth callbacks, posts, media, workspaces, reviews)
- Domain helpers in `src/lib/` (workspace context, DTOs, rate limit, token crypto)
- Platform clients + jobs in `src/server/`
- Tenant scope is **Workspace**; members share connections and media

## Security notes

- Social OAuth tokens are encrypted at rest when `TOKEN_ENCRYPTION_KEY` is set
- Client-supplied media URLs must match the blob host allowlist
- Emails are stored normalized (lowercase); registration is rate-limited
- Password reset bumps `sessionVersion` so outstanding JWTs stop working
- API responses use SEC-1 DTOs (no tokens / raw secrets)

## Docs

Project-level docs live in `../docs/` (overview, staging, platform setup, design specs).
