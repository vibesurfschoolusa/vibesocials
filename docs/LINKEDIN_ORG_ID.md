# Finding Your LinkedIn Organization ID

Since the Community Management API doesn't provide access to the `organizationalEntityAcls` endpoint, you need to manually configure your LinkedIn company page's Organization ID.

## Method 1: Using LinkedIn's API (Recommended)

### Step 1: Get Your Access Token

After connecting LinkedIn in the app, check your Vercel logs or database for the access token.

### Step 2: Call the Organizations Endpoint

Use this API call to find your organization ID:

```bash
curl -X GET 'https://api.linkedin.com/v2/organizations?q=administeredBy&role=ADMINISTRATOR' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -H 'X-Restli-Protocol-Version: 2.0.0'
```

**OR** try this alternative endpoint:

```bash
curl -X GET 'https://api.linkedin.com/rest/organizations?q=roleAssignee' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -H 'LinkedIn-Version: 202405'
```

### Step 3: Find Your Organization ID

Look for your company page in the response. The organization ID will be in one of these formats:
- Just the numeric ID: `12345678`
- Full URN: `urn:li:organization:12345678`

**Example Response:**
```json
{
  "elements": [
    {
      "id": 87654321,
      "localizedName": "Vibe Surf School USA",
      "vanityName": "vibe-surf-school-usa"
    }
  ]
}
```

In this example, the organization ID is **87654321**.

## Method 2: From LinkedIn URL

### Step 1: Go to Your Company Page

Visit your LinkedIn company page:
```
https://www.linkedin.com/company/vibe-surf-school-usa/
```

### Step 2: View Page Source

1. Right-click on the page
2. Select "View Page Source"
3. Search for `"objectUrn":"urn:li:organization:`

### Step 3: Extract the ID

You'll find something like:
```
"objectUrn":"urn:li:organization:87654321"
```

The number after `organization:` is your Organization ID: **87654321**

## Method 3: Using Browser Developer Tools

### Step 1: Open Developer Tools

1. Go to your LinkedIn company page
2. Press F12 to open Developer Tools
3. Go to "Network" tab
4. Refresh the page

### Step 2: Find the Organization ID

1. Look for network requests to LinkedIn API
2. Search for requests containing "organization"
3. Check the response for your organization ID

## Configure in Your App

### For Local Development:

Add to your `.env.local` file:

```env
LINKEDIN_ORGANIZATION_ID=87654321
LINKEDIN_ORGANIZATION_NAME=Vibe Surf School USA
```

### For Production (Vercel):

1. Go to your Vercel project
2. Click "Settings" → "Environment Variables"
3. Add two new variables:
   - **Name:** `LINKEDIN_ORGANIZATION_ID`
   - **Value:** Your organization ID (numbers only, no URN prefix)
   - **Name:** `LINKEDIN_ORGANIZATION_NAME`
   - **Value:** Your company page name

4. Redeploy your app

## Testing

After configuring:

1. Disconnect LinkedIn (if already connected)
2. Reconnect LinkedIn in your app
3. Check logs - should see: "Using manually configured organization"
4. Try posting - should post to your configured company page

## Troubleshooting

### "No organizations found" Error

**Cause:** Organization ID not configured or incorrect

**Fix:**
1. Double-check the organization ID is correct
2. Make sure there are no spaces or extra characters
3. Use only the numeric ID, not the full URN
4. Verify the environment variable is set in Vercel

### Posts Still Failing

**Cause:** May need to reconnect after adding environment variable

**Fix:**
1. Go to Settings → Connections
2. Disconnect LinkedIn
3. Connect LinkedIn again (will fetch new organization config)
4. Try posting again

## Security Note

The organization ID is not sensitive - it's publicly visible on your LinkedIn company page. However, your access token IS sensitive and should never be committed to version control.
