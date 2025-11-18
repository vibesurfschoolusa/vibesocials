# Dev Session Notes – Vibe Social Sync

## Session: 2025-11-15

- **Summary of changes**
  - Initialized high-level architecture and stack decisions for Vibe Social Sync.
  - Created `docs/PROJECT_OVERVIEW.md` with:
    - Purpose and scope of the app.
    - Chosen tech stack (Next.js + TypeScript + Prisma + PostgreSQL, local storage, NextAuth).
    - Data model overview (Users, SocialConnections, MediaItems, PostJobs, PostJobResults).
    - High-level data flows for login, OAuth connect, upload, posting, and status.
    - Decision to implement **Google Photos** as the first fully working platform, with scaffolding for others.

- **Decisions / Rationale**
  - **Framework:** Next.js (App Router) chosen to unify frontend and backend API routes in a single codebase, simplifying deployment and multi-user auth.
  - **Language:** TypeScript for type safety and maintainability.
  - **DB/ORM:** PostgreSQL + Prisma for strong relational modeling and migrations.
  - **Storage:** Local filesystem for videos in V1 to keep dependencies light; abstracted via a storage module to allow S3/object storage later.
  - **Auth:** NextAuth with a credentials (email/password) provider for straightforward multi-user support.
  - **First platform:** Google Photos chosen for the first end-to-end slice since it uses Google OAuth and is a good pattern for other Google APIs (e.g., YouTube) later.

- **Open Issues / TODOs**
  - Scaffold the Next.js app in this repo (create-next-app, TypeScript, Tailwind, ESLint).
  - Add Prisma schema and migrations for the core models.
  - Configure NextAuth and basic auth pages (login/register) and document `getCurrentUser` helper.
  - Implement `/api/auth/google_photos/start` and `/api/auth/google_photos/callback` with Google OAuth.
  - Implement the storage abstraction and `POST /api/posts` + `GET /api/posts/{id}` routes.
  - Implement a minimal Google Photos platform client and wire it into the posting orchestrator.
  - Build the Create Post and Connections UI pages.

- **Next Steps (Suggested for Next Session)**
  1. Run `create-next-app` in the repo root to generate a Next.js + TypeScript app.
  2. Add Prisma and define the initial schema (Users, SocialConnections, MediaItems, PostJobs, PostJobResults).
  3. Set up NextAuth with credentials provider and stub login/register UI.
  4. Implement the Google Photos OAuth start/callback endpoints and persistence in `SocialConnections`.
  5. Implement the core posting API (`POST /api/posts`, `GET /api/posts/{postJobId}`) and storage abstraction.
  6. Build the initial frontend flows for connections and creating a post.

## Session: 2025-11-17

- **Summary of changes**
  - Implemented **Google Business Profile (GBP)** as the first real platform integration.
  - Added OAuth start/callback routes for `google_business_profile` using a dedicated Google Cloud project and client ID/secret.
  - Persisted GBP tokens in `SocialConnection` for platform `google_business_profile` (access token, refresh token, expiry, scopes, account identifier).
  - Implemented the **GBP platform client** under `src/server/platforms/googleBusinessProfileClient.ts`:
    - Uploads media bytes to Google Business Profile and creates media items so photos appear on Google Maps for a specific location.
  - Added support for configuring the GBP target location in three ways:
    - Directly entering the full resource name: `accounts/{accountId}/locations/{locationId}`.
    - Entering the **store code** from GBP Advanced settings; the backend resolves store code → location via Account Management + Business Information APIs.
    - Using a **location picker** on the Connections page that calls `/api/connections/google_business_profile/locations` to list all accessible locations and lets the user pick one.
  - Updated the **Connections** UI to show a Google Business Profile card with:
    - Connect button (initial OAuth).
    - When connected, the `GoogleBusinessLocationForm` with manual input + “Fetch locations from Google” + dropdown picker.

- **Technical notes**
  - APIs involved:
    - OAuth: `https://accounts.google.com/o/oauth2/v2/auth` with scope `https://www.googleapis.com/auth/business.manage`.
    - Media upload: `https://mybusiness.googleapis.com/v4/accounts/{accountId}/locations/{locationId}/media:startUpload` and related endpoints.
    - Location discovery / store code resolution:
      - `https://mybusinessaccountmanagement.googleapis.com/v1/accounts` (Account Management API).
      - `https://mybusinessbusinessinformation.googleapis.com/v1/{accountName}/locations` (Business Information API) with `readMask` and optional `filter=storeCode="{code}"`.
  - New API route: `GET /api/connections/google_business_profile/locations`:
    - Uses the stored GBP access token to call `accounts.list` and `accounts.locations.list`.
    - Normalizes results into `{ resourceName, title, storeCode, address, accountName }` for the UI.
  - Implemented a simple **access-token refresh** helper in the locations route using the stored `refreshToken` and `GOOGLE_GBP_CLIENT_ID` / `GOOGLE_GBP_CLIENT_SECRET` against `https://oauth2.googleapis.com/token`.

- **Current issues / external blockers**
  - Even with OAuth working, calls to `mybusinessaccountmanagement.googleapis.com` and `mybusinessbusinessinformation.googleapis.com` return:
    - `401` when using stale tokens from older projects.
    - After moving to a new project + client and successfully reconnecting, `429 Too Many Requests` for `accounts.list`.
  - The 429 is not due to local rate limiting but because the Google Cloud project has **0 QPM quota** for the Business Profile APIs.
  - Per the official **Business Profile APIs Prerequisites**, the project must be explicitly approved via the **GBP API contact form** (“Application for Basic API Access”) and associated with a verified GBP that is 60+ days old.

- **Actions taken**
  - Created a dedicated Google Cloud project for Vibe Socials and a Web OAuth client with redirect URI `http://localhost:3000/api/auth/google_business_profile/callback`.
  - Enabled **Business Profile API**, **My Business Account Management API**, and **My Business Business Information API** in that project.
  - Swapped `.env.local` to use the new client ID/secret and re-ran the OAuth flow.
  - Observed that the app is now blocked by Google’s **Business Profile API approval / quota (0 QPM)** rather than by local configuration.

- **Next steps once Google approves the project**
  1. Check in Google Cloud Console that Business Profile APIs show **300 QPM** instead of **0 QPM** for the Vibe Socials project.
  2. Visit `/connections` and click **Fetch locations from Google**:
     - Confirm that `/api/connections/google_business_profile/locations` returns 200 and populates the location dropdown.
  3. On `/connections`, save the desired GBP location either by:
     - Selecting from the dropdown; or
     - Entering a store code or full `accounts/{accountId}/locations/{locationId}` value.
  4. Go to `/posts/new`, upload a photo, and submit:
     - Verify that the Google Business Profile result row shows **success** and that the photo appears on the business’s Maps listing.
  5. If any errors remain, capture the `[GBP] ...` log lines and update these notes with the new status.


## Session: 2025-11-17 (Deployment & TikTok Sandbox)

- **Summary of changes**
  - Fixed Next.js 16 route handler typing issues for several API routes so the app builds successfully on Vercel (notably `/api/connections/[platform]` and `/api/posts/[postJobId]`).
  - Deployed the Next.js app to Vercel (project `vibesocials`) and confirmed the production site loads at:
    - `https://vibesocials.vercel.app`
    - `https://vibesocials.wtf` (custom domain, primary user-facing URL).
  - Configured the `vibesocials.wtf` domain in Vercel and verified it with TikTok via a TXT DNS record.

- **TikTok Sandbox configuration**
  - Created and configured a TikTok for Developers app in **Sandbox** environment.
  - Set URLs to point at the Vercel deployment:
    - Web/Desktop URL: `https://vibesocials.wtf/`
    - Terms of Service URL: `https://vibesocials.wtf/terms`
    - Privacy Policy URL: `https://vibesocials.wtf/privacy`
    - Redirect URI (Web): `https://vibesocials.wtf/api/auth/tiktok/callback`
  - Enabled products and scopes:
    - Products: **Login Kit**, **Content Posting API**.
    - Scopes: `user.info.basic`, `video.upload`.

- **Current status**
  - Domain + HTTPS endpoints are ready for TikTok OAuth in Sandbox.
  - TikTok app remains in Sandbox; Production app review (written explanation + demo video) is not yet submitted.
  - Google Business Profile integration is still blocked by Google Business Profile API approval / quota (0 QPM) as described in the previous session.

- **Next steps for upcoming sessions**
  1. Provision a hosted PostgreSQL database (e.g., Neon or Supabase) and configure a production `DATABASE_URL` for the Vercel project.
  2. Configure remaining Vercel environment variables for production:
     - `NEXTAUTH_URL`, `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI`, etc.
  3. Test the full TikTok flow in Sandbox on `https://vibesocials.wtf`:
     - Log in, connect TikTok on `/connections`, create a video post on `/posts/new`, and confirm the upload reaches TikTok via the Content Posting API.
  4. Once the TikTok flow is stable, record a demo video and fill out the TikTok **App review** section to prepare for Production.
  5. After Google approves the Business Profile APIs and raises quotas, re-test the GBP location picker and photo posting as outlined above.
