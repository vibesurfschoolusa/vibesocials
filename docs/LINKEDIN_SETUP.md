# LinkedIn Integration Setup Guide

## Prerequisites

You need a LinkedIn Developer account and an app to use the LinkedIn integration.

## Step 1: Create a LinkedIn App

1. Go to [LinkedIn Developers](https://www.linkedin.com/developers/apps)
2. Click **"Create app"**
3. Fill in the required information:
   - **App name**: Vibe Social Sync
   - **LinkedIn Page**: Select your company's LinkedIn Page (required)
   - **Privacy policy URL**: Your privacy policy URL
   - **App logo**: Upload a logo (optional but recommended)
4. Check the **LinkedIn Pages** and **Share on LinkedIn** products
5. Click **"Create app"**

## Step 2: Configure OAuth Settings

1. In your app dashboard, go to the **"Auth"** tab
2. Under **OAuth 2.0 settings**:
   - **Authorized redirect URLs**: Add your callback URL
     - Development: `http://localhost:3000/api/auth/linkedin/callback`
     - Production: `https://yourdomain.com/api/auth/linkedin/callback`

## Step 3: Request API Access

1. Go to the **"Products"** tab
2. Request access to:
   - **Share on LinkedIn** - For posting content
   - **Sign In with LinkedIn using OpenID Connect** - For authentication

Note: These products require review for production use, but you can test in development mode immediately.

## Step 4: Get Your Credentials

1. Go to the **"Auth"** tab
2. Copy your credentials:
   - **Client ID**
   - **Client Secret** (click "Show" to reveal)

## Step 5: Configure Environment Variables

Add these to your `.env.local` file:

```env
# LinkedIn OAuth
LINKEDIN_CLIENT_ID=your_client_id_here
LINKEDIN_CLIENT_SECRET=your_client_secret_here
LINKEDIN_REDIRECT_URI=https://yourdomain.com/api/auth/linkedin/callback
```

For development:
```env
LINKEDIN_REDIRECT_URI=http://localhost:3000/api/auth/linkedin/callback
```

## Step 6: Test the Integration

1. Go to `/connections` in your app
2. Click **"Connect"** next to LinkedIn
3. Authorize the app with your LinkedIn account
4. You should be redirected back with a success message

## Step 7: Test Posting

1. Go to `/posts/new`
2. Upload an image or video
3. Add a caption
4. Click **"Create post"**
5. Check your LinkedIn feed for the new post

## API Scopes Used

- `openid` - Required for OpenID Connect
- `profile` - Access to basic profile information
- `email` - Access to email address
- `w_member_social` - Post content on behalf of the user

## Supported Features

- ✅ **Image Posts** - Upload and share images
- ✅ **Video Posts** - Upload and share videos (with chunked upload)
- ✅ **Captions** - Add text commentary to posts
- ✅ **Public Visibility** - Posts are visible to your network
- ❌ **Company Pages** - Not yet supported (personal profiles only)
- ❌ **Article Sharing** - Not yet supported

## Media Requirements

### Images
- **Max file size**: 10 MB
- **Supported formats**: JPG, PNG, GIF
- **Recommended dimensions**: 1200 x 627 pixels

### Videos
- **Max file size**: 200 MB
- **Supported formats**: MP4
- **Max duration**: 10 minutes
- **Recommended dimensions**: 1280 x 720 pixels or higher

## Troubleshooting

### "Invalid client_id" error
- Verify your `LINKEDIN_CLIENT_ID` is correct
- Make sure you copied it from the Auth tab

### "Redirect URI mismatch" error
- Ensure your `LINKEDIN_REDIRECT_URI` matches exactly what's configured in LinkedIn app settings
- Check for http vs https
- Check for trailing slashes

### "Insufficient permissions" error
- Make sure "Share on LinkedIn" product is enabled
- Request access if it's pending review
- Wait for LinkedIn to approve your access (can take 1-2 weeks)

### "Image/Video upload failed" error
- Check file size limits
- Verify the file format is supported
- Ensure the blob storage URL is publicly accessible

## Development vs Production

### Development Mode
- You can test immediately after creating the app
- Posts are only visible to you (the app developer)
- Limited to your personal account

### Production Mode
- Requires LinkedIn review (1-2 weeks)
- Posts are public and visible to your network
- Can post on behalf of any authorized user

## LinkedIn App Review Process

When you're ready for production:

1. Go to your app settings
2. Complete the **App verification** section
3. Submit for review with:
   - A detailed description of your use case
   - Screenshots of your integration
   - Privacy policy and terms of service
4. Wait for LinkedIn's approval (typically 1-2 weeks)

## Additional Resources

- [LinkedIn API Documentation](https://learn.microsoft.com/en-us/linkedin/)
- [UGC Post API](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/ugc-post-api)
- [LinkedIn OAuth 2.0](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authentication)
- [Rate Limits](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits)

## Rate Limits

LinkedIn enforces rate limits on API calls:

- **Application-level**: 500 requests per user per day
- **User-level**: Varies by product and tier

If you hit rate limits, the API will return a `429 Too Many Requests` error. Implement exponential backoff and retry logic if needed.
