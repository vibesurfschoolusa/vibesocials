# Vibe Social Sync – Project Overview

## Purpose
Vibe Social Sync lets a logged-in user upload media (primarily videos, but also photos where required) + caption once and post it to multiple social platforms (TikTok, YouTube, X, LinkedIn, Instagram, Google Business Profile for Maps photos) using that user’s own connected accounts.

Initial goal: deliver a thin, maintainable vertical slice for **one real platform (Google Business Profile / Google Maps photos)** end-to-end, with scaffolding for all others. **Google Business Profile** is now fully operational with automatic token refresh and photo uploads. **TikTok** integration is fully working in Sandbox mode using the Content Posting API v2 (video uploads to Creator Portal inbox).

## Tech Stack (V1)
- **Language:** TypeScript
- **Runtime:** Node.js (LTS)
- **Web framework:** Next.js (App Router, React, TypeScript)
- **Frontend:** Next.js pages/routes, React components, Tailwind CSS for simple responsive UI.
- **Backend:** Next.js server routes (API routes) for auth, OAuth callbacks, posting jobs, and status.
- **Database:** PostgreSQL (via Prisma ORM) - Neon hosted database for production.
- **Storage:** 
  - **Production:** Vercel Blob Storage for media uploads (images and videos).
  - **Development:** Local filesystem fallback with abstraction layer.
  - Storage abstraction (`src/server/storage`) detects mime types from file extensions and handles uploads to Vercel Blob.
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
    - `/login`, `/register` (credentials auth).
    - `/connections` – list and manage per-platform social connections.
    - `/settings` – configure company website and default hashtags for caption footer.
    - `/posts/new` – create post (upload video + captions).
    - `/posts/[id]` – view posting status (per platform).
    - `/media` – view media library.
- **`/app/api` routes**
  - **Auth for Vibe Social Sync users**
    - NextAuth route (e.g. `/api/auth/[...nextauth]`) for app sessions.
  - **Social OAuth:** for each platform
    - `GET /api/auth/{platform}/start`
    - `GET /api/auth/{platform}/callback`
  - **Settings:**
    - `POST /api/settings` – update user's company website and default hashtags.
  - **Media:**
    - `GET /api/media` – list user's uploaded media items.
    - `POST /api/media` – upload media to Vercel Blob and create MediaItem.
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
  - `companyWebsite` (optional, for caption footer)
  - `defaultHashtags` (optional, for caption footer)
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
  - `storageLocation` (Vercel Blob URL or local path)
  - `originalFilename`
  - `mimeType` (auto-detected from file extension as fallback)
  - `sizeBytes`
  - `baseCaption` (text, user-provided caption before footer)
  - `perPlatformOverrides` (jsonb: partial map of platform → caption override)
  - `createdAt`
  
  **Note:** All captions are automatically appended with user's `companyWebsite` and `defaultHashtags` before posting.

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

### First Platform: Google Business Profile (Google Maps photos) - ✅ FULLY WORKING

- **Status:** Production ready with automatic token refresh
- **Implementation:**
  - OAuth start/callback endpoints for `google_business_profile` platform
  - Automatic access token refresh using refresh tokens when expired
  - Photo uploads using Google My Business API v4 with public Vercel Blob URLs
  - Photos posted with `ADDITIONAL` category (flexible aspect ratios)
  - Location configuration with three options:
    - Manual entry of full resource: `accounts/{accountId}/locations/{locationId}`
    - Store code from GBP Advanced settings (auto-resolved via APIs)
    - Location picker fetching all accessible locations from Google
- **Technical details:**
  - API: `https://mybusiness.googleapis.com/v4/{locationName}/media`
  - Scope: `https://www.googleapis.com/auth/business.manage`
  - Token refresh: Automatic before API calls when `expiresAt < now()`
  - Media format: Uses `sourceUrl` field pointing to Vercel Blob public URL
  - Category: `ADDITIONAL` to support any aspect ratio (COVER requires 16:9)
- **Required APIs enabled in Google Cloud:**
  - Google My Business API
  - Business Profile API
  - My Business Account Management API
  - My Business Business Information API

### Second Platform: TikTok (Sandbox - Implemented)

- **Status:** Fully working in Sandbox mode
- **Implementation:**
  - OAuth start/callback endpoints for TikTok authentication
  - Content Posting API v2 integration (`/v2/post/publish/inbox/video/init/`)
  - Video uploads with captions to TikTok Creator Portal inbox
  - Videos require manual approval/publish in Sandbox mode (privacy: `SELF_ONLY`)
  - Supports video files only (MP4, MOV, WebM) - images not supported by TikTok
  - Automatic mime type detection from file extensions
- **Environment Variables:**
  - `TIKTOK_CLIENT_KEY`
  - `TIKTOK_CLIENT_SECRET`
  - `TIKTOK_REDIRECT_URI`
- **Limitations:**
  - Sandbox mode requires videos to be manually approved in TikTok Creator Portal
  - Videos are private (`SELF_ONLY`) until Production approval
  - Rate limits: `spam_risk_too_many_pending_share` error if too many pending videos in inbox
    - **Solution:** Clear pending videos from Creator Portal before uploading more
    - Alternatively: wait 30-60 minutes for rate limit to reset
  - Disconnect/reconnect may help reset rate limits

### Other Platforms (Scaffolded)

For YouTube, X, LinkedIn, Instagram:
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

- ✅ ~~Replace local file storage with object store~~ - **DONE: Using Vercel Blob Storage**
- ✅ ~~Implement Google Business Profile photo posting~~ - **DONE: Fully working**
- ✅ ~~Implement TikTok video posting~~ - **DONE: Working in Sandbox**
- Add background job processing (e.g., queues) instead of synchronous posting.
- Add more auth options (Sign in with Google, etc.).
- Expand multi-tenancy (teams, roles, billing) as needed.
- Implement full platform integrations for YouTube, X, LinkedIn, and Instagram following the GBP pattern.
- Submit TikTok app for Production approval to enable public posting.
- Add client-side video compression or direct-to-Blob uploads for files >4MB.
- Implement media library management (delete, edit captions).
- Add post scheduling functionality.
- Integrate analytics/insights from social platforms.

