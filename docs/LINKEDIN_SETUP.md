# LinkedIn Integration Setup Guide

## Prerequisites

**IMPORTANT: This integration posts to LinkedIn Company Pages ONLY, not personal profiles.**

Before you begin, you need:

1. **LinkedIn Developer Account** - Free to create
2. **LinkedIn Company Page** - You must be an administrator of a company page
3. **Administrator Access** - You must have admin rights on the company page you want to post to

**Why?** Vibe Socials is designed for business/company page posting only. If you don't have a company page, create one first at [linkedin.com/company/setup/new](https://www.linkedin.com/company/setup/new/).

## Step 1: Create a LinkedIn App

1. Go to [LinkedIn Developers](https://www.linkedin.com/developers/apps)
2. Click **"Create app"**
3. Fill in the required information:
   - **App name**: Vibe Socials
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

**CRITICAL: You MUST enable the Community Management API product for this integration to work!**

1. Go to the **"Products"** tab
2. Request access to these products:
   - ✅ **Community Management API** - **REQUIRED** for posting to company pages
   - ✅ **Share on LinkedIn** - For basic posting capabilities
   - ✅ **Sign In with LinkedIn using OpenID Connect** - For authentication

**Important Notes:**
- **Community Management API is REQUIRED** - Without this, you'll get "unauthorized_scope_error"
- In Development Mode, you can test immediately after requesting access
- For Production Mode, these products require LinkedIn review (1-2 weeks)
- The app posts ONLY to company pages, never to personal profiles

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

- `profile` - Access to basic profile information
- `email` - Access to email address
- `w_member_social` - Post content on behalf of the user (fallback, not used for company pages)
- `w_organization_social` - **REQUIRED** - Post content to company pages
- `r_organization_social` - **REQUIRED** - Read organization/company page data

**Important:** The `w_organization_social` and `r_organization_social` scopes require the **Community Management API** product to be enabled in your LinkedIn app.

## Supported Features

- ✅ **Company Page Posting** - Posts to LinkedIn business profiles/company pages
- ✅ **Image Posts** - Upload and share images
- ✅ **Video Posts** - Upload and share videos (with chunked upload up to 200MB)
- ✅ **Captions** - Add text commentary to posts
- ✅ **Public Visibility** - Posts are visible to company page followers
- ✅ **Organization Detection** - Automatically detects your administered company pages
- ❌ **Personal Profile Posting** - Intentionally disabled (company pages only)
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

### "unauthorized_scope_error" - MOST COMMON ISSUE
**This is the error you're seeing!**

**Cause:** The Community Management API product is not enabled in your LinkedIn app.

**Solution:**
1. Go to [LinkedIn Developers](https://www.linkedin.com/developers/apps)
2. Select your app
3. Click the **"Products"** tab
4. Find **"Community Management API"**
5. Click **"Request access"** or **"Add to app"**
6. In Development Mode, access is granted immediately
7. Try connecting again - it should work now!

**Why this happens:** The scopes `w_organization_social` and `r_organization_social` require this specific API product. Without it, LinkedIn rejects the authorization request.

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
