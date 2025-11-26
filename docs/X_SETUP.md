# X (Twitter) Integration Setup Guide

## Overview

Vibe Socials uses **OAuth 1.0a** for X (Twitter) authentication, which is available on the **Free tier**. This allows posting both images and videos without requiring paid API access.

## Prerequisites

You need an X (Twitter) Developer account and an app to use the X integration.

## Step 1: Create an X Developer Account

1. Go to [X Developer Portal](https://developer.twitter.com/en/portal/dashboard)
2. Sign in with your X (Twitter) account
3. Apply for a developer account if you don't have one
4. Fill out the application form (describe your use case: "Social media management tool for multi-platform content posting")
5. Wait for approval (usually instant for Free tier access)

## Step 2: Create an X App

1. In the X Developer Portal, go to **Projects & Apps**
2. Click **+ Create App** (or create a project first if prompted)
3. Fill in the required information:
   - **App name**: Vibe Socials (or your preferred name)
   - **App description**: Social media management tool for multi-platform posting
   - **Website URL**: Your website URL (e.g., https://vibesocials.wtf)
4. Click **Create**

## Step 3: Configure OAuth 1.0a Settings

1. In your app dashboard, go to **Settings** → **User authentication settings**
2. Click **Set up** or **Edit**
3. Configure the following:

### OAuth 1.0a Settings
- **App permissions**: **Read and write** (required for posting)
- **Type of App**: **Web App, Automated App or Bot**
- **Callback URI / Redirect URL**: 
  ```
  http://localhost:3000/api/auth/x/callback
  https://vibesocials.wtf/api/auth/x/callback
  ```
  ⚠️ Add BOTH URLs (one per line) for development and production
  ⚠️ Must match EXACTLY (including protocol and no trailing slash)
  
- **Website URL**: https://vibesocials.wtf

4. Click **Save**

## Step 4: Get Your API Keys

1. In your app dashboard, go to **Keys and tokens** tab
2. Find these credentials:
   - **API Key** (also called Consumer Key)
   - **API Key Secret** (also called Consumer Secret)
3. Click **Generate** if you don't see them
4. **Save these securely** - you'll need them for environment variables

⚠️ **Important:** Use the **Consumer Keys** (API Key/Secret), NOT the OAuth 2.0 Client ID/Secret!

## Step 5: Configure Environment Variables

Add these environment variables to your `.env.local` file for local development:

```env
# X (Twitter) OAuth 1.0a Configuration
X_CONSUMER_KEY=your_api_key_here
X_CONSUMER_SECRET=your_api_secret_here
X_CALLBACK_URL=http://localhost:3000/api/auth/x/callback
```

For production (Vercel), add these environment variables:

```env
# X (Twitter) OAuth 1.0a Configuration
X_CONSUMER_KEY=your_api_key_here
X_CONSUMER_SECRET=your_api_secret_here
X_CALLBACK_URL=https://vibesocials.wtf/api/auth/x/callback
```

### Where to find these values:
- **X_CONSUMER_KEY**: In your app's "Keys and tokens" tab, listed as **"API Key"** or **"Consumer Key"**
- **X_CONSUMER_SECRET**: In your app's "Keys and tokens" tab, listed as **"API Key Secret"** or **"Consumer Secret"**
- **X_CALLBACK_URL**: Must match one of the callback URLs you configured in OAuth settings (use localhost for dev, production URL for production)

## Step 6: OAuth 1.0a Permissions

OAuth 1.0a uses **app-level permissions** (configured in step 3):
- ✅ **Read and write** - Allows reading user info and posting tweets
- ✅ **No expiration** - Tokens don't expire (no refresh needed!)
- ✅ **Free tier compatible** - Works without paid API access

## Step 6: Test the Integration

1. Go to https://vibesocials.wtf/connections
2. Click **Connect** next to X (Twitter)
3. You'll be redirected to X to authorize the app
4. After authorizing, you'll be redirected back to the connections page
5. You should see "Connected as @your_username"

## Posting with X

### Supported Media Types
- **Images**: JPG, PNG, GIF, WebP (up to 5MB per image)
- **Videos**: MP4, MOV (up to 512MB, automatically uses chunked upload)

### Video Upload Process
Videos use X's chunked upload API:
1. **INIT** - Initialize upload session with total file size
2. **APPEND** - Upload video in 5MB chunks
3. **FINALIZE** - Complete upload and get media ID
4. **STATUS** - Poll until video processing is complete
5. **CREATE TWEET** - Post tweet with processed media

This process happens automatically and supports large video files!

### Character Limits
- Tweet text: **280 characters**
- If your caption is longer, it will be automatically truncated to 277 characters + "..."

### Posting Flow
1. Upload media on the "Create Post" page (images or videos)
2. Add your caption (will be auto-truncated if > 280 chars)
3. Select X (Twitter) as one of your platforms
4. Click "Post"
5. Your tweet will be created with the media attached

## Troubleshooting

### Error: "Could not authenticate you" (code 32)
- This is an OAuth signature error
- Disconnect and reconnect your X account in the Connections page
- Make sure you're using **Consumer Keys** (not OAuth 2.0 Client ID/Secret)
- Verify `X_CONSUMER_KEY` and `X_CONSUMER_SECRET` are correct

### Error: "redirect_uri_mismatch"
- Make sure the callback URL in your X app settings matches exactly
- For local: `http://localhost:3000/api/auth/x/callback`
- For production: `https://vibesocials.wtf/api/auth/x/callback`
- No trailing slash
- Protocol must match (http vs https)

### Error: "Invalid Client ID"
- Double-check your `X_CONSUMER_KEY` in `.env.local`
- Make sure you're using the **API Key** (Consumer Key), not OAuth 2.0 Client ID
- Make sure there are no extra spaces or quotes

### Error: "Unauthorized"
- Regenerate your API Key Secret in the X Developer Portal
- Update `X_CONSUMER_SECRET` in `.env.local`
- Restart your development server
- Reconnect your X account

### Error: "Access to this endpoint requires a different access level" (code 453)
- Some v1.1 endpoints require paid tiers
- Our implementation uses:
  - ✅ Media Upload v1.1 (available on Free tier)
  - ✅ Tweets API v2 (available on Free tier)
- This error should not occur with our implementation

### Error: "Media upload failed"
- Check file size: Images < 5MB
- Videos can be up to 512MB (chunked upload handles this)
- Supported formats: JPG, PNG, GIF, WebP for images; MP4, MOV for videos
- Make sure the file is not corrupted
- Check Vercel Blob storage has sufficient space

### Error: "Video processing timed out"
- X takes time to process large videos
- Our implementation waits up to 5 minutes
- Try a shorter/smaller video if this persists
- Check X status page for platform issues

### Tweet not appearing
- Check your X account to see if the tweet posted successfully
- The tweet ID is logged in the Vercel function logs
- You can view your tweet at: `https://twitter.com/i/web/status/[TWEET_ID]`
- Allow a few seconds for the tweet to appear on X

## X API Limitations

### Free Tier (Available with OAuth 1.0a)
- ✅ 1,500 tweets per month (write limit)
- ✅ 10,000 tweets read per month
- ✅ Media upload API access (images and videos)
- ✅ OAuth 1.0a authentication
- ✅ No expiration on access tokens
- ⚠️ Limited to v1.1 endpoints for media, v2 for tweets

### Basic Tier ($100/month)
- Higher rate limits
- Access to more v1.1 endpoints
- OAuth 2.0 support
- 3,000 tweets per month

### Rate Limits
If you hit rate limits, you'll see an error. Rate limits reset monthly. Monitor your usage in the X Developer Portal.

## Technical Implementation

### OAuth 1.0a Flow
1. User clicks "Connect" → Request token generated
2. User authorizes on X → Receives oauth_verifier
3. Exchange verifier for access token
4. Store access_token and access_token_secret
5. Use tokens to sign all API requests with HMAC-SHA1

### Media Upload Details
- **Images**: Simple base64 upload in one request
- **Videos**: Chunked upload (INIT → APPEND → FINALIZE → STATUS)
- **Signature**: All requests signed with OAuth 1.0a
- **Processing**: Videos are processed by X before tweets can be created

### API Endpoints Used
- `https://api.twitter.com/oauth/request_token` - Get request token
- `https://api.twitter.com/oauth/access_token` - Exchange for access token
- `https://upload.twitter.com/1.1/media/upload.json` - Upload media (v1.1)
- `https://api.twitter.com/2/tweets` - Create tweets (v2)

## Security Best Practices

1. **Never commit** your Consumer Secret to Git
2. Use environment variables for all credentials
3. Rotate your API Keys periodically in X Developer Portal
4. Monitor your app's usage and API calls
5. Use HTTPS for all callback URLs in production
6. Store access tokens securely in the database (encrypted)

## Additional Resources

- [X API Documentation](https://developer.twitter.com/en/docs/twitter-api)
- [OAuth 1.0a Docs](https://developer.twitter.com/en/docs/authentication/oauth-1-0a)
- [Media Upload API](https://developer.twitter.com/en/docs/twitter-api/v1/media/upload-media/overview)
- [Chunked Media Upload](https://developer.twitter.com/en/docs/twitter-api/v1/media/upload-media/uploading-media/chunked-media-upload)
- [Tweet Character Count](https://developer.twitter.com/en/docs/counting-characters)
- [X API Free vs Paid](https://developer.twitter.com/en/portal/products)

## Support

If you encounter issues:
1. Check the troubleshooting section above
2. Review Vercel function logs for detailed error messages
3. Verify all environment variables are set correctly (Consumer Keys, not Client ID)
4. Check X Developer Portal for API status and usage limits
5. Disconnect and reconnect your X account if authentication fails
6. Ensure your app has "Read and write" permissions enabled
