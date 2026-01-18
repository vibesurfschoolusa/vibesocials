# TikTok Direct Post API - Compliance Implementation

This document outlines how Vibe Socials implements TikTok's Direct Post API Developer Guidelines.

## ✅ Compliance Checklist

### 1. Creator Info API - REQUIRED ✅
**Guideline**: API Clients must retrieve the latest creator info when rendering the Post to TikTok page.

**Implementation**:
- ✅ Created `getTikTokCreatorInfo()` function in `tiktokClient.ts`
- ✅ API endpoint at `/api/tiktok/creator-info` fetches creator info before posting
- ✅ Displays creator's username (`@username`) in the TikTok settings panel
- ✅ Checks posting limits via `creator_info` API
- ✅ Retrieves `privacy_level_options` from API
- ✅ Checks `max_video_post_duration_sec` for video duration validation
- ✅ Retrieves interaction settings (`comment_disabled`, `duet_disabled`, `stitch_disabled`)

**Files**:
- `app/src/server/platforms/tiktokClient.ts` (lines 9-45)
- `app/src/app/api/tiktok/creator-info/route.ts`

---

### 2. Privacy Level Selection - REQUIRED ✅
**Guideline**: Users must manually select privacy status from a dropdown with no default value.

**Implementation**:
- ✅ Privacy dropdown with empty default (`<option value="">Select privacy level...</option>`)
- ✅ Options dynamically populated from `privacy_level_options` returned by creator_info API
- ✅ User must manually select before posting
- ✅ Form validation prevents posting without privacy selection
- ✅ Privacy levels mapped to user-friendly labels:
  - `PUBLIC_TO_EVERYONE` → "Public (Everyone)"
  - `MUTUAL_FOLLOW_FRIENDS` → "Friends"
  - `SELF_ONLY` → "Private (Only Me)"
  - `FOLLOWER_OF_CREATOR` → "Followers"

**Files**:
- `app/src/components/tiktok-post-settings.tsx` (lines 106-128)
- `app/src/components/create-post-form.tsx` (lines 188-194)

---

### 3. Interaction Settings - REQUIRED ✅
**Guideline**: Allow Comment, Duet, and Stitch must be manually enabled (unchecked by default). Disabled features must be greyed out.

**Implementation**:
- ✅ All interaction checkboxes default to **disabled** (unchecked)
- ✅ Users must manually enable each interaction
- ✅ Checkboxes disabled and greyed out if feature is disabled in creator's TikTok settings
- ✅ Visual indicator shows "(Disabled in your TikTok settings)" for disabled features
- ✅ Duet and Stitch only shown for video posts (not photos)
- ✅ Help text: "Manually enable interaction features. None are checked by default."

**Files**:
- `app/src/components/tiktok-post-settings.tsx` (lines 130-183)
- `app/src/server/platforms/tiktokClient.ts` (lines 109-111)

---

### 4. Commercial Content Disclosure - REQUIRED ✅
**Guideline**: Users must disclose commercial content with toggle and checkboxes for "Your Brand" and "Branded Content".

**Implementation**:
- ✅ Commercial content toggle (off by default)
- ✅ When enabled, shows two checkboxes:
  - **Your Brand**: "You are promoting yourself or your own business"
    - Shows label: "Your video will be labeled as 'Promotional content'"
  - **Branded Content**: "You are promoting another brand or third party"
    - Shows label: "Your video will be labeled as 'Paid partnership'"
- ✅ At least one option must be selected if toggle is enabled
- ✅ Publish button validation prevents posting without selection
- ✅ Warning message: "You must select at least one option to proceed"

**Privacy Management**:
- ✅ Branded Content cannot be set to "Private (Only Me)"
- ✅ If user selects Branded Content with private visibility, automatically switches to public
- ✅ Warning shown: "Branded content cannot be set to private. Change privacy to Public or Friends."
- ✅ "Only Me" option disabled when Branded Content is selected

**Files**:
- `app/src/components/tiktok-post-settings.tsx` (lines 185-249)
- `app/src/server/platforms/tiktokClient.ts` (lines 115-126)

---

### 5. Required Consent Declarations - REQUIRED ✅
**Guideline**: Display consent declarations before posting.

**Implementation**:
- ✅ Always shows: "By posting, you agree to TikTok's Music Usage Confirmation"
- ✅ When commercial content is enabled, adds: "TikTok's Branded Content Policy"
- ✅ Displayed in prominent blue info box before publish button
- ✅ Cannot be dismissed or hidden

**Files**:
- `app/src/components/tiktok-post-settings.tsx` (lines 251-265)

---

### 6. User Awareness and Control - REQUIRED ✅
**Guideline**: Users must have full awareness and control of what is being posted.

**Implementation**:
- ✅ **Preview**: File preview shown in upload form
- ✅ **Editable Content**: Caption/title is fully editable by user
- ✅ **No Watermarks**: No promotional watermarks or logos added to content
- ✅ **Explicit Consent**: Upload only starts after user clicks "Create post" button
- ✅ **Processing Notice**: Info box states: "After publishing, it may take a few minutes for your content to process and be visible on your profile."

**Files**:
- `app/src/components/tiktok-post-settings.tsx` (lines 267-273)
- `app/src/components/create-post-form.tsx` (caption editing at lines 358-364)

---

### 7. Technical Implementation - REQUIRED ✅
**Guideline**: Keep client_secret confidential and use efficient upload methods.

**Implementation**:
- ✅ `client_secret` stored in environment variables (never exposed to client)
- ✅ Uses `FILE_UPLOAD` method for client-side uploads (correct for user device files)
- ✅ Chunked upload for large videos (10MB chunks)
- ✅ Proper error handling and logging

**Files**:
- `app/src/server/platforms/tiktokClient.ts` (lines 47-173)

---

## 📋 Data Flow

1. **User selects file** → Form checks for TikTok connection
2. **TikTok detected** → Fetches creator info from `/api/tiktok/creator-info`
3. **Settings panel shown** → User configures:
   - Privacy level (required)
   - Interaction settings (optional)
   - Commercial content disclosure (if applicable)
4. **User clicks "Create post"** → Validates TikTok metadata
5. **API receives request** → Passes `tiktokMetadata` to Inngest job
6. **Inngest job** → Passes metadata to `tiktokClient.publishVideo()`
7. **TikTok API** → Posts with user's selected settings

---

## 🔧 Key Files Modified

### New Files Created:
1. `app/src/app/api/tiktok/creator-info/route.ts` - Creator info API endpoint
2. `app/src/components/tiktok-post-settings.tsx` - TikTok settings UI component
3. `TIKTOK_COMPLIANCE.md` - This documentation

### Modified Files:
1. `app/src/server/platforms/types.ts` - Added TikTok types
2. `app/src/server/platforms/tiktokClient.ts` - Added creator_info function, dynamic metadata
3. `app/src/components/create-post-form.tsx` - Integrated TikTok settings
4. `app/src/app/api/posts/route.ts` - Added tiktokMetadata handling
5. `app/src/server/jobs/inngest-functions.ts` - Pass metadata to platform client

---

## 🧪 Testing Checklist

Before resubmitting for TikTok audit:

- [ ] Test creator_info API call with connected TikTok account
- [ ] Verify privacy dropdown shows all available options
- [ ] Confirm no default privacy level is selected
- [ ] Test interaction toggles (all unchecked by default)
- [ ] Verify disabled features are greyed out
- [ ] Test commercial content toggle and checkboxes
- [ ] Verify branded content privacy validation
- [ ] Confirm consent declarations appear correctly
- [ ] Test video upload with all settings combinations
- [ ] Verify post appears on TikTok with correct privacy/settings
- [ ] Test with both video and photo posts
- [ ] Verify Duet/Stitch only shown for videos

---

## 📝 Audit Submission Notes

**What Changed**:
- Implemented mandatory creator_info API call before posting
- Added user-controlled privacy level selection (no defaults)
- Added manual interaction settings (unchecked by default)
- Implemented commercial content disclosure with privacy validation
- Added required consent declarations
- Added post processing notice

**Compliance Status**: ✅ All Developer Guidelines requirements implemented

**API Usage**:
- Uses Direct Post API with FILE_UPLOAD method
- Respects creator_info privacy_level_options
- Respects interaction settings from creator account
- Implements proper commercial content disclosure

---

## 🚀 Next Steps

1. Test the complete flow with a TikTok account
2. Verify all guideline requirements are met
3. Resubmit application for TikTok audit
4. Monitor for any additional feedback from TikTok review team
