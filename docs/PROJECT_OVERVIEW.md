# Vibe Social Sync – Project Overview

## Purpose
Vibe Social Sync lets a logged-in user upload media (primarily videos, but also photos where required) + caption once and post it to multiple social platforms (TikTok, YouTube, X, LinkedIn, Instagram, Google Business Profile for Maps photos) using that user’s own connected accounts.

Initial goal: deliver a thin, maintainable vertical slice for **one real platform (Google Business Profile / Google Maps photos)** end-to-end, with scaffolding for all others. A second slice is now being built for **TikTok** (Sandbox first) using the Content Posting API.

## Tech Stack (V1)
- **Language:** TypeScript
- **Runtime:** Node.js (LTS)
- **Web framework:** Next.js (App Router, React, TypeScript)
- **Frontend:** Next.js pages/routes, React components, Tailwind CSS for simple responsive UI.
- **Backend:** Next.js server routes (API routes) for auth, OAuth callbacks, posting jobs, and status.
- **Database:** PostgreSQL (via Prisma ORM).
- **Storage:** Local filesystem in the project (e.g. `storage/uploads/`) for uploaded videos in development.
  - Extension point: replace with S3 or other object storage in production; keep paths abstracted via a storage service module.
- **Auth for app users:** NextAuth (Auth.js) using an email+password credentials provider (initially).
  - Later extension: add Google Sign-In using the same Google Cloud project used for Google Photos, if desired.
- **Social OAuth & APIs:**
  - First implemented platform: **Google Business Profile (GBP)**, posting photos that appear on Google Maps for a specific business location.
  - Second implemented platform (in progress, Sandbox first): **TikTok**, uploading videos via TikTok’s Content Posting API.
  - Remaining scaffolded modules for future implementation: YouTube, X, LinkedIn, Instagram.
- **Tooling:**
  - ESLint + Prettier (Next.js defaults).
  - Prisma migrations.

## High-Level Architecture

### Overview
- **Next.js app** (single repo) provides both UI and backend API routes.
- **Database (PostgreSQL)** stores users, per-user social connections, media items, post jobs, and per-platform post results.
- **Storage layer** provides an abstraction for saving and reading uploaded video files.
- **Platform clients** implement a shared interface for publishing videos and refreshing tokens.

### Main Components
- **`/app` (Next.js App Router)**
  - UI routes:
    - `/login`, `/register` (if using credentials auth).
    - `/connections` – list and manage per-platform social connections.
    - `/posts/new` – create post (upload video + captions).
    - `/posts/[id]` – view posting status (per platform).
- **`/app/api` routes**
  - **Auth for Vibe Social Sync users**
    - NextAuth route (e.g. `/api/auth/[...nextauth]`) for app sessions.
  - **Social OAuth:** for each platform
    - `GET /api/auth/{platform}/start`
    - `GET /api/auth/{platform}/callback`
  - **Posting flow:**
    - `POST /api/posts` – upload video + captions, create `MediaItem` + `PostJob` + `PostJobResults`, and fan out to platform clients (synchronously for V1).
    - `GET /api/posts/{postJobId}` – read combined job + results status.

- **Domain/Service Layer** (under `src/server` or similar):
  - `auth` – helpers for getting the current user (`getCurrentUser()`) using NextAuth sessions in server contexts.
  - `db` – Prisma client and repositories for core models.
  - `storage` – file storage abstraction (e.g. `saveUpload`, `getFilePath`).
  - `platforms` – one module per social platform implementing a shared `PlatformClient` interface.
  - `jobs` – posting orchestration logic.

## Authentication Model

### App Users
- Users authenticate to Vibe Social Sync via **NextAuth** using a **Credentials Provider**:
  - `email` + `password` at registration.
  - Passwords stored as `passwordHash` (e.g. bcrypt) in the `User` table.
- NextAuth sessions expose the authenticated user ID in `session.user.id`.
- Backend code (API routes, server actions) uses a small helper, e.g. `getCurrentUser()`:
  - Calls `getServerSession()`.
  - Throws or returns `null` if unauthenticated.
  - Returns a `User` record (via Prisma) or at least the user ID.

### Social Connections
- Each user can connect **one account per platform** (simple v1 model).
- Social OAuth flows are separate from app auth and use platform-specific client IDs/secrets from environment variables.
- For Google Photos (first platform):
  - Use OAuth 2.0 authorization code flow.
  - Store access token, refresh token, expiry, Google account ID, and any default album ID.

## Data Model (Conceptual)

Backed by Prisma models mapped to PostgreSQL tables.

- **Users**
  - `id` (PK)
  - `email` (unique)
  - `name` (optional)
  - `passwordHash` (for credentials auth)
  - `createdAt`, `updatedAt`

- **SocialConnections**
  - `id` (PK)
  - `userId` (FK → Users)
  - `platform` (enum/string: `tiktok`, `youtube`, `x`, `linkedin`, `instagram`, `google_business_profile`)
  - `accessToken`
  - `refreshToken` (nullable)
  - `expiresAt` (nullable)
  - `accountIdentifier` (e.g. Google account ID, YouTube channel ID, TikTok user ID)
  - `scopes` (text/json)
  - `metadata` (jsonb: platform-specific fields like album IDs, page IDs, Google Business `locationName` values)
  - `createdAt`, `updatedAt`

- **MediaItems**
  - `id` (PK)
  - `userId` (FK → Users)
  - `storageLocation` (local path or object storage key)
  - `originalFilename`
  - `mimeType`
  - `sizeBytes`
  - `baseCaption` (text)
  - `perPlatformOverrides` (jsonb: partial map of platform → caption override)
  - `createdAt`

- **PostJobs**
  - `id` (PK)
  - `userId` (FK → Users)
  - `mediaItemId` (FK → MediaItems)
  - `status` (`pending` | `in_progress` | `completed` | `failed`)
  - `createdAt`, `updatedAt`

- **PostJobResults**
  - `id` (PK)
  - `postJobId` (FK → PostJobs)
  - `platform`
  - `socialConnectionId` (FK → SocialConnections)
  - `status` (`pending` | `success` | `failed`)
  - `externalPostId` (nullable)
  - `errorCode` (nullable; machine-readable)
  - `errorMessage` (nullable; user-safe)
  - `createdAt`, `updatedAt`

## Social Platform Integrations

All platform modules implement a shared interface:

- `publishVideo(ctx: PublishContext): Promise<PublishResult>`
- Optional `refreshToken(connection: SocialConnection): Promise<SocialConnection>`

Where:

- `PublishContext` includes:
  - `user`
  - `socialConnection`
  - `mediaItem`
  - `caption` (resolved from base + per-platform override)

- `PublishResult` includes:
  - `externalPostId?`

### First Platform: Google Business Profile (Google Maps photos) (V1)

- Implement real OAuth start/callback endpoints for the `google_business_profile` platform.
- Implement a Google Business Profile platform client that:
  - Uses Google Business Profile APIs to upload **photos** to a specific business `locationName` so they appear on Google Maps.
  - Stores the chosen business location identifier (e.g. `accounts/{accountId}/locations/{locationId}`) in `SocialConnections.metadata`.
- Use Google OAuth credentials from environment variables (no secrets in code).
- **Location configuration UX (Connections page):**
  - Users connect GBP via the **Connect** button, which runs the OAuth flow and persists tokens.
  - Once connected, the **Maps business location** form allows:
    - Entering the full location resource: `accounts/{accountId}/locations/{locationId}`.
    - Entering the **store code** from GBP Advanced settings; the backend resolves store code → location via Account Management + Business Information APIs.
    - Clicking **Fetch locations from Google** to call `/api/connections/google_business_profile/locations`, list all accessible locations, and picking one from a dropdown. The selected location’s full resource name is stored in `metadata.locationName`.

### Other Platforms (Scaffolded)

For TikTok, YouTube, X, LinkedIn, Instagram:
- Create client modules with the shared interface.
- Implement placeholder `publishVideo` that throws a structured "NotImplemented" error.
- Document required env vars and scopes in comments and in this file as they are added.

## Data Flow Summary

### 1. User login
1. User registers/logs in via NextAuth (credentials provider).
2. NextAuth creates a session; backend can access `session.user.id`.

### 2. Connect platform via OAuth (e.g., Google Business Profile)
1. User visits `/connections` and clicks **Connect Google Business Profile**.
2. Frontend calls `GET /api/auth/google_business_profile/start`.
3. Backend builds an authorization URL with:
   - `client_id`, `redirect_uri`, `scope`, `response_type=code`, `state` tied to the user session.
4. Browser is redirected to Google’s consent screen.
5. Google redirects back to `/api/auth/google_business_profile/callback` with `code` and `state`.
6. Backend validates `state`, exchanges `code` for tokens, and calls a "who am I" endpoint.
7. Backend upserts a `SocialConnection` for `(userId, platform='google_business_profile')`.
8. User is redirected back to `/connections` with a success or error message.
9. On the Connections page, the user configures the GBP target location using the location form (manual resource, store code, or picker), which updates `metadata.locationName`.

### 3. Upload + Post
1. User opens `/posts/new` and selects a video file + base caption and optional per-platform captions.
2. Frontend sends `POST /api/posts` with `multipart/form-data`:
   - `file` (video)
   - `baseCaption`
   - optional overrides (JSON or separate fields).
3. Backend:
   - Authenticates user via session.
   - Stores file via storage abstraction (local path for V1).
   - Creates `MediaItem` row.
   - Creates `PostJob` (`status='pending'`).
   - Looks up all `SocialConnections` for the user.
   - For each connection:
     - Creates `PostJobResult` row (`status='pending'`).
     - Immediately runs `publishVideo` for that platform (synchronous v1, simple job orchestrator).
     - On success/failure, updates `PostJobResult` status + `externalPostId`/error details.
   - Updates `PostJob.status` based on per-platform outcomes.
4. Backend returns initial `PostJob` + `PostJobResults` in the response.

### 4. Status Reporting
- Frontend may:
  - Use the initial response; or
  - Poll `GET /api/posts/{postJobId}` for updated `PostJob` + `PostJobResults`.
- UI displays per-platform status chips: success/failure + message.

## Configuration & Secrets

- All sensitive values are provided via environment variables (e.g. `.env.local` in Next.js):
  - Database connection string (`DATABASE_URL`).
  - NextAuth secret and configuration (`NEXTAUTH_SECRET`, etc.).
  - Google Business Profile OAuth credentials (`GOOGLE_GBP_CLIENT_ID`, `GOOGLE_GBP_CLIENT_SECRET`, `GOOGLE_GBP_REDIRECT_URI`, scopes).
  - Other platform-specific keys as they are added.
- No secrets are committed to the repo.
- Logging redacts tokens and secrets; only non-sensitive identifiers and error messages are exposed.

## Extension Points / Future Work

- Replace local file storage with S3 or another object store via the storage abstraction.
- Add background job processing (e.g., queues) instead of synchronous posting.
- Add more auth options (Sign in with Google, etc.).
- Expand multi-tenancy (teams, roles, billing) as needed.
- Implement full platform integrations for TikTok, YouTube, X, LinkedIn, and Instagram following the GBP pattern.
- Once the Google Cloud project is **approved for Business Profile APIs** (see official Prerequisites and GBP API contact form), re-verify that:
  - Business Profile-related APIs (Business Profile API, Account Management, Business Information) show **non-zero (e.g. 300 QPM)** quotas.
  - The location picker and store-code resolution work end-to-end without `401`/`429` errors.

