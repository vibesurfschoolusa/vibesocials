# Pinterest setup

Pinterest was added on 2026-11-10 (API v5). The code is deployed but switched off: Settings does not list Pinterest until the three environment variables below are set.

## Status

- App request ("Connect app") filled in on 2026-11-10 at https://developers.pinterest.com/apps/ under the Pinterest account "Vibe Surf School" (vibesurfschoolftl@gmail.com). App name "Vibe Socials by Vibe Surf School". It asks for Trial access.
- Pinterest reviews the request and emails the result. Only one request can be open at a time.
- Nothing has been tested against the live API yet: that needs the app id and secret Pinterest issues on approval.

## When Pinterest approves the app (Trial access)

1. On https://developers.pinterest.com/apps/ open the app and add the redirect URI:
   `https://vibesocials.wtf/api/auth/pinterest/callback`
2. In Vercel (project `vibesocials`, Production) add, as Sensitive:
   - `PINTEREST_APP_ID`: the app id
   - `PINTEREST_APP_SECRET`: the app secret
   - `PINTEREST_REDIRECT_URI`: `https://vibesocials.wtf/api/auth/pinterest/callback`
3. Redeploy production. Settings > Connections now lists Pinterest.
4. Connect, choose a board, and publish one photo and one short video. With Trial access a Pin is visible only to the account that created it.
   - If Pinterest answers the Pin with a 403 saying Trial apps may not create Pins in production, the test and the demo video have to run against Pinterest's sandbox (`api-sandbox.pinterest.com`) instead. The API address is fixed in `src/lib/pinterestApi.ts`, so that needs a small code change first.
5. Check the items under "Not yet confirmed against the live API" below and fix what differs.

## Getting Standard access (Pins visible to everyone)

Pinterest asks for a video demo of the integration: the whole sign-in on Pinterest's own screen, choosing the board, and a Pin being created and shown on Pinterest. Record it with the Trial app (the same way as the Meta, Google and LinkedIn review videos, `C:\Users\Klaus\Videos\tiktok-demo\reviews\build_review.py`), then request the upgrade on the app's page. One upgrade request can be open at a time.

## What the integration does

- Scopes: `boards:read`, `boards:write`, `pins:read`, `pins:write`, `user_accounts:read` (`src/lib/oauthScopes.ts`). Pinterest lists `boards:write` as required for creating a Pin; the app never creates or edits a board.
- Connect: reads the username (`GET /user_account`) and the boards (`GET /boards`). One board connects straight away; several open the "Choose which Pinterest board to post to" dialog; none gives a message asking to create a board. Secret boards are not listed (the app does not ask for `boards:read_secret`). To post to another board, use Switch account and choose again.
- Photo: `POST /pins` with the photo's public URL.
- Video: `POST /media`, upload to the URL Pinterest returns, wait for processing (`GET /media/{id}`, checked every 30 s for up to about 6 minutes), then `POST /pins`. The cover is the frame at second 1.
- Title: the post's own caption fitted to 100 characters. Description: the full caption cut to 800. Link: the workspace's website from Settings > Captions, when one is saved; if Pinterest refuses the Pin with the link, it is created without it.
- Tokens: the access token lasts 30 days and is refreshed by the daily connection-health sweep; each refresh also renews the 60-day refresh token.

## Not yet confirmed against the live API

- How long video processing takes (`PINTEREST_STATUS_MAX_CHECKS` in `src/server/platforms/pinterestClient.ts`).
- How long Pinterest keeps an uploaded video that has no Pin yet (`PINTEREST_MEDIA_MAX_AGE_MS`).
- Whether a Trial app may create Pins in production at all (see step 4 above).
- The status Pinterest answers for a refresh with a dead refresh token. A 400 ends in "reconnect". A 401 does not: a wrong app secret gives a 401 too, and must not mark every customer's connection as broken. A dead connection is then caught when a post is refused.
- Whether a 429 carries `Retry-After` (without it the run's own backoff applies).
- Which image formats `image_url` accepts beyond JPEG and PNG.
