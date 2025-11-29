# TikTok Integration Setup Guide

## Prerequisites

Before you begin, you need:

1. **TikTok Developer Account** - Free to create at [developers.tiktok.com](https://developers.tiktok.com)
2. **TikTok Business/Creator Account** - The account you want to post to
3. **Private Account (for Sandbox)** - Your TikTok account must be set to PRIVATE during development

## Step 1: Create a TikTok App

1. Go to [TikTok Developer Portal](https://developers.tiktok.com)
2. Click **"Manage apps"** → **"Create app"**
3. Fill in the required information:
   - **App name**: Vibe Socials
   - **Description**: Social media posting application
   - **Category**: Social Media
4. Click **"Create"**

## Step 2: Add Content Posting API Product

1. In your app dashboard, go to **"Products"**
2. Click **"+ Add products"**
3. Add **"Content Posting API"**
4. In the Content Posting API settings:
   - ✅ Enable **"Direct Post"** toggle (required for captions!)
   - Configure sandbox settings

## Step 3: Configure OAuth Settings

1. Go to **"Sandbox"** settings in your app
2. Under **"Redirect URIs"**, add:
   - Development: `http://localhost:3000/api/auth/tiktok/callback`
   - Production: `https://yourdomain.com/api/auth/tiktok/callback`

## Step 4: Configure Scopes

In your app settings, ensure these scopes are enabled:

| Scope | Description | Required |
|-------|-------------|----------|
| `user.info.basic` | Read user's profile info | ✅ Yes |
| `video.publish` | Direct post content to user's profile | ✅ Yes |

**Important:** Use `video.publish` (not `video.upload`):
- `video.upload` = Inbox API (drafts only, no captions)
- `video.publish` = Direct Post API (auto-post with captions)

## Step 5: Add Target Users (Sandbox)

1. Go to **"Sandbox settings"** → **"Target Users"**
2. Click **"+ Add account"**
3. Enter the TikTok username you want to test with
4. The user must accept the invitation in their TikTok app

## Step 6: Get Your Credentials

1. Go to the **"App details"** tab
2. Copy your credentials:
   - **Client Key** (also called App ID)
   - **Client Secret**

## Step 7: Configure Environment Variables

Add these to your `.env.local` file:

```env
# TikTok OAuth
TIKTOK_CLIENT_KEY=your_client_key_here
TIKTOK_CLIENT_SECRET=your_client_secret_here
TIKTOK_REDIRECT_URI=https://yourdomain.com/api/auth/tiktok/callback
```

For development:
```env
TIKTOK_REDIRECT_URI=http://localhost:3000/api/auth/tiktok/callback
```

## Step 8: Make Your TikTok Account Private

**CRITICAL for Sandbox Mode:**

Unaudited (sandbox) TikTok apps can only post to **private accounts**.

1. Open TikTok app on your phone
2. Go to **Profile** → **≡** (menu) → **Settings and Privacy**
3. Tap **Privacy**
4. Enable **Private Account**

## Step 9: Connect Your TikTok Account

1. Go to `/connections` in Vibe Socials
2. Click **"Connect"** next to TikTok
3. Authorize the app with your TikTok account
4. Grant the `video.publish` permission
5. You should be redirected back with a success message

## Step 10: Test Posting

1. Go to `/posts/new`
2. Upload a video (MP4 format)
3. Add a caption with hashtags
4. Select TikTok as the target platform
5. Click **"Create post"**

## How It Works

### Direct Post API Flow

```
1. Initialize Upload
   POST /v2/post/publish/video/init/
   - Send post_info (caption, privacy, settings)
   - Send source_info (FILE_UPLOAD, video size)
   - Receive upload_url and publish_id

2. Upload Video
   PUT {upload_url}
   - Send video bytes with Content-Range header
   - Single chunk upload (video_size = chunk_size)

3. Processing
   - TikTok processes the video asynchronously
   - Video appears on profile (SELF_ONLY visibility in sandbox)
```

### Caption Support

The Direct Post API supports captions through the `post_info.title` field:

```json
{
  "post_info": {
    "title": "Your full caption with #hashtags and @mentions",
    "privacy_level": "SELF_ONLY",
    "disable_comment": false,
    "disable_duet": false,
    "disable_stitch": false,
    "video_cover_timestamp_ms": 1000
  }
}
```

**Caption limits:**
- Maximum 2200 characters
- Supports hashtags (#), mentions (@), and emojis

## Sandbox vs Production Mode

### Sandbox Mode (Development)
- ✅ Immediate testing without approval
- ⚠️ Account must be PRIVATE
- ⚠️ Videos are `SELF_ONLY` (only visible to you)
- ⚠️ Limited to target users you add

### Production Mode (After Approval)
- ✅ Public accounts supported
- ✅ All privacy levels available (PUBLIC, FRIENDS, etc.)
- ✅ No target user restrictions
- Requires TikTok app review (1-2 weeks)

## Troubleshooting

### Error: `scope_not_authorized`

**Cause:** User authorized with wrong scope (likely `video.upload` instead of `video.publish`)

**Solution:**
1. Disconnect TikTok in Vibe Socials settings
2. Reconnect TikTok
3. Ensure you authorize `video.publish` scope

### Error: `unaudited_client_can_only_post_to_private_accounts`

**Cause:** TikTok account is public, but sandbox mode requires private accounts

**Solution:**
1. Open TikTok app
2. Settings → Privacy → Enable "Private Account"
3. Try posting again

### Error: `url_ownership_unverified`

**Cause:** Tried to use PULL_FROM_URL with an unverified domain

**Solution:** This error won't occur with the current implementation (FILE_UPLOAD method).

### Error: `The chunk size is invalid` / `The total chunk count is invalid`

**Cause:** TikTok's chunking validation is very strict

**Solution:** Current implementation uses single-chunk upload which avoids these errors.

### Video Uploaded But Not Visible

**Possible causes:**
1. Account is not private (sandbox requirement)
2. Processing delay (wait a few minutes)
3. Video is in "Only me" section of your profile

**Solution:**
1. Check your TikTok profile for videos
2. Look for "Only me" or private videos filter
3. Ensure account is private

## API Reference

### Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v2/post/publish/video/init/` | POST | Initialize Direct Post upload |
| `{upload_url}` | PUT | Upload video bytes |

### Request/Response Examples

**Initialize Upload:**
```bash
curl --location 'https://open.tiktokapis.com/v2/post/publish/video/init/' \
--header 'Authorization: Bearer {access_token}' \
--header 'Content-Type: application/json' \
--data '{
  "post_info": {
    "title": "Check out this video! #vibesocials",
    "privacy_level": "SELF_ONLY",
    "disable_comment": false,
    "disable_duet": false,
    "disable_stitch": false,
    "video_cover_timestamp_ms": 1000
  },
  "source_info": {
    "source": "FILE_UPLOAD",
    "video_size": 9652098,
    "chunk_size": 9652098,
    "total_chunk_count": 1
  }
}'
```

**Response:**
```json
{
  "data": {
    "publish_id": "v_pub_file~v2-1.7578015649516046349",
    "upload_url": "https://open-upload.tiktokapis.com/video/?upload_id=..."
  },
  "error": {
    "code": "ok",
    "message": "",
    "log_id": "..."
  }
}
```

**Upload Video:**
```bash
curl --location --request PUT '{upload_url}' \
--header 'Content-Range: bytes 0-9652097/9652098' \
--header 'Content-Type: video/mp4' \
--data-binary '@/path/to/video.mp4'
```

## Getting Production Approval

To post to public accounts and remove sandbox restrictions:

1. Go to TikTok Developer Portal
2. Navigate to your app → **"Submit for review"**
3. Provide required information:
   - Use case description
   - Demo video showing your app
   - Privacy policy URL
   - Terms of service URL
4. Wait for review (typically 1-2 weeks)
5. After approval:
   - Update `privacy_level` to `PUBLIC_TO_EVERYONE` or other options
   - Users no longer need private accounts

## Related Documentation

- [TikTok Content Posting API Overview](https://developers.tiktok.com/doc/content-posting-api-get-started)
- [Direct Post API Reference](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post)
- [Media Transfer Guide](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide)
- [Content Sharing Guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines)
