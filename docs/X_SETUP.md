# X (Twitter) Integration Setup Guide

## Prerequisites

You need an X (Twitter) Developer account and an app to use the X integration.

## Step 1: Create an X Developer Account

1. Go to [X Developer Portal](https://developer.twitter.com/en/portal/dashboard)
2. Sign in with your X (Twitter) account
3. Apply for a developer account if you don't have one
4. Fill out the application form (describe your use case for Vibe Socials)
5. Wait for approval (usually instant for basic access)

## Step 2: Create an X App

1. In the X Developer Portal, go to **Projects & Apps**
2. Click **+ Create Project** or **+ New App**
3. Fill in the required information:
   - **App name**: Vibe Socials
   - **App description**: Social media management tool for multi-platform posting
   - **Website URL**: Your website URL (e.g., https://vibesocials.wtf)
4. Click **Create**
5. Save your **Client ID** and **Client Secret** (you'll need these for environment variables)

## Step 3: Configure OAuth Settings

1. In your app dashboard, go to **Settings** → **User authentication settings**
2. Click **Set up** or **Edit**
3. Configure the following:

### OAuth 2.0 Settings
- **App permissions**: Read and write
- **Type of App**: Web App, Automated App or Bot
- **Callback URI / Redirect URL**: 
  ```
  https://vibesocials.wtf/api/auth/x/callback
  ```
  ⚠️ This must match EXACTLY (including https://)
  
- **Website URL**: https://vibesocials.wtf

4. Click **Save**

## Step 4: Configure Environment Variables

Add these environment variables to your `.env.local` file:

```env
# X (Twitter) OAuth Configuration
X_CLIENT_ID=your_x_client_id_here
X_CLIENT_SECRET=your_x_client_secret_here
X_REDIRECT_URI=https://vibesocials.wtf/api/auth/x/callback
```

### Where to find these values:
- **X_CLIENT_ID**: In your app's "Keys and tokens" tab, listed as "Client ID" or "API Key"
- **X_CLIENT_SECRET**: In your app's "Keys and tokens" tab, listed as "Client Secret" or "API Secret Key"
- **X_REDIRECT_URI**: Must match the callback URL you configured in OAuth settings

## Step 5: Set Up Required Scopes

The app requests these OAuth 2.0 scopes:
- `tweet.read` - Read tweets (view user's tweets)
- `tweet.write` - Create tweets (post on user's behalf)
- `users.read` - Read user profile (get username and account info)
- `offline.access` - Get refresh token for long-term access

These are automatically requested during the OAuth flow.

## Step 6: Test the Integration

1. Go to https://vibesocials.wtf/connections
2. Click **Connect** next to X (Twitter)
3. You'll be redirected to X to authorize the app
4. After authorizing, you'll be redirected back to the connections page
5. You should see "Connected as @your_username"

## Posting with X

### Supported Media Types
- **Images**: JPG, PNG, GIF (up to 5MB)
- **Videos**: MP4 (up to 512MB for most accounts, 15MB for simple upload)

### Character Limits
- Tweet text: **280 characters**
- If your caption is longer, it will be automatically truncated to 277 characters + "..."

### Posting Flow
1. Upload media on the "Create Post" page
2. Add your caption (will be auto-truncated if > 280 chars)
3. Select X (Twitter) as one of your platforms
4. Click "Post"
5. Your tweet will be created with the media attached

## Troubleshooting

### Error: "redirect_uri_mismatch"
- Make sure the callback URL in your X app settings matches exactly: `https://vibesocials.wtf/api/auth/x/callback`
- No trailing slash
- Must be https (not http)

### Error: "Invalid Client ID"
- Double-check your `X_CLIENT_ID` in `.env.local`
- Make sure there are no extra spaces or quotes

### Error: "Unauthorized"
- Regenerate your Client Secret in the X Developer Portal
- Update `X_CLIENT_SECRET` in `.env.local`
- Restart your development server

### Error: "Access token expired"
- The app automatically refreshes tokens using the refresh token
- If you see this error persistently, try disconnecting and reconnecting your X account

### Error: "Media upload failed"
- Check file size: Images < 5MB, Videos < 15MB for simple upload
- Supported formats: JPG, PNG, GIF for images; MP4 for videos
- Make sure the file is not corrupted

### Tweet not appearing
- Check your X account to see if the tweet posted successfully
- The tweet ID is logged in the Vercel function logs
- You can view your tweet at: `https://twitter.com/i/web/status/[TWEET_ID]`

## X API Limitations

### Free Tier (Basic Access)
- 1,500 tweets per month
- Tweet creation rate limit: 50 tweets per 24 hours
- Media upload size limits apply

### Pro Tier (Enhanced Access)
- Higher rate limits
- Larger media uploads (up to 512MB for videos)
- No monthly tweet cap

### Rate Limits
If you hit rate limits, you'll see an error. Wait for the rate limit to reset (usually 24 hours) before trying again.

## Security Best Practices

1. **Never commit** your Client Secret to Git
2. Use environment variables for all credentials
3. Rotate your Client Secret periodically
4. Monitor your app's usage in the X Developer Portal
5. Report any suspicious activity immediately

## Additional Resources

- [X API Documentation](https://developer.twitter.com/en/docs/twitter-api)
- [OAuth 2.0 with PKCE](https://developer.twitter.com/en/docs/authentication/oauth-2-0/authorization-code)
- [Media Upload API](https://developer.twitter.com/en/docs/twitter-api/v1/media/upload-media/overview)
- [Tweet Character Count](https://developer.twitter.com/en/docs/counting-characters)

## Support

If you encounter issues:
1. Check the troubleshooting section above
2. Review Vercel function logs for detailed error messages
3. Verify all environment variables are set correctly
4. Check X Developer Portal for any API status issues
