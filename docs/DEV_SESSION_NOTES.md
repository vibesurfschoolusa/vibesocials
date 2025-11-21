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
  1. ✅ Provision a hosted PostgreSQL database (Neon) and configure production `DATABASE_URL` for the Vercel project.
  2. ✅ Configure remaining Vercel environment variables for production.
  3. ✅ Test the full TikTok flow in Sandbox on `https://vibesocials.wtf`.
  4. Once the TikTok flow is stable, record a demo video and fill out the TikTok **App review** section to prepare for Production.
  5. After Google approves the Business Profile APIs and raises quotas, re-test the GBP location picker and photo posting as outlined above.


## Session: 2025-11-19 (Vercel Blob Storage & TikTok Implementation)

- **Summary of changes**
  - **Replaced local filesystem with Vercel Blob Storage** for media uploads to work in Vercel's serverless environment:
    - Created `vercelBlobStorage.ts` that uses `@vercel/blob` SDK to upload files to Vercel Blob.
    - Added mime type detection from file extensions as fallback when browser doesn't provide `file.type`.
    - Updated platform clients (TikTok and Google Business Profile) to fetch media from Blob URLs instead of reading from filesystem.
  - **Implemented TikTok video posting integration** (Sandbox mode):
    - OAuth flow for TikTok authentication working end-to-end.
    - Content Posting API v2 implementation with video upload to Creator Portal inbox.
    - Added caption support with `post_info` metadata (title, privacy_level, etc.).
    - Privacy set to `SELF_ONLY` as required by Sandbox mode.
    - Videos upload successfully but require manual approval in TikTok Creator Portal.
  - **Added automatic caption footer feature**:
    - Added `companyWebsite` and `defaultHashtags` fields to User model.
    - Created `/settings` page where users can configure their default caption footer.
    - Implemented `buildCaptionWithFooter()` function that automatically appends:
      - "For more info visit [website]"
      - User's default hashtags
    - Footer is applied to all captions before posting to any platform.
  - **Database migrations**:
    - Migration: `20051549_add_user_caption_settings` - added `companyWebsite` and `defaultHashtags` to User table.
  - **Fixed deployment issues**:
    - Configured Vercel function timeouts for media operations.
    - Resolved 413 Content Too Large errors by documenting 4.5MB limit.
    - Added detailed error logging for TikTok API responses.

- **Technical details**
  - **Vercel Blob Storage:**
    - Uploads use `put()` from `@vercel/blob` package.
    - Files stored with path: `{userId}/{timestamp}-{safeName}`.
    - Returns public URL that is stored in `MediaItem.storageLocation`.
    - Access requires `BLOB_READ_WRITE_TOKEN` environment variable (auto-configured by Vercel).
  - **TikTok API Integration:**
    - Endpoint: `https://open.tiktokapis.com/v2/post/publish/inbox/video/init/`
    - Upload flow:
      1. Initialize upload with video metadata and caption
      2. Receive `upload_url` and `publish_id`
      3. PUT video bytes to upload URL
      4. Video appears in Creator Portal inbox
    - Caption goes in `post_info.title` field.
    - Sandbox limitations: `privacy_level: "SELF_ONLY"` required, manual approval needed.
  - **Caption Footer Logic:**
    - `buildCaptionWithFooter()` in `src/server/jobs/posting.ts`
    - Joins user caption + website + hashtags with double line breaks.
    - Applied to both base captions and platform-specific overrides.

- **Encountered Issues & Resolutions**
  - ❌ **Issue:** `ENOENT: no such file or directory` when creating posts on Vercel.
    - **Cause:** Trying to write to local filesystem in serverless environment.
    - **Solution:** Migrated to Vercel Blob Storage.
  
  - ❌ **Issue:** `TIKTOK_MEDIA_NOT_VIDEO` error despite uploading MP4 file.
    - **Cause:** Browser not providing correct mime type; saved as `application/octet-stream`.
    - **Solution:** Added `getMimeTypeFromFilename()` function to detect mime type from file extension.
  
  - ❌ **Issue:** TikTok API 400 error: `spam_risk_too_many_pending_share`.
    - **Cause:** Too many pending videos in Creator Portal inbox.
    - **Solution:** User must clear pending videos from TikTok Creator Portal before uploading more.
  
  - ❌ **Issue:** Caption not appearing in TikTok posts.
    - **Cause:** Caption not included in API request.
    - **Solution:** Added `post_info` object with `title` field containing the caption.

- **Current Status**
  - ✅ **TikTok Integration:** Fully functional in Sandbox mode
    - OAuth working
    - Video uploads successful
    - Captions working with automatic footer
    - Videos appear in Creator Portal inbox for manual approval
  - ✅ **Vercel Blob Storage:** Fully operational for both images and videos
  - ✅ **Caption Footer:** Implemented and working
  - ⏳ **Google Business Profile:** Still blocked by API quota (0 QPM), awaiting Google approval
  - 🔄 **TikTok Production:** Sandbox only, needs app review for public posting

- **Next Steps**
  1. **TikTok Production Approval:**
     - Record demo video showing the integration working
     - Submit TikTok app for Production review
     - Once approved, update `privacy_level` to allow public posts
  2. **File Size Optimization:**
     - Consider implementing client-side compression for videos >4MB
     - Or implement direct client-to-Blob uploads to bypass serverless function limits
  3. **Google Business Profile:**
     - Continue waiting for Google API approval
     - Test location picker and photo posting once quota is raised
  4. **Additional Features:**
     - Add media library management (delete, edit captions)
     - Implement scheduling for posts
     - Add analytics/insights from social platforms
