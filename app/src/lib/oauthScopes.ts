/**
 * The OAuth permissions each connect requests (2026-11-09): only what the app
 * uses, because platform reviews (Meta App Review, Google verification) reject
 * apps that ask for more. Pinned by oauthStarts.test.ts.
 */

/**
 * Facebook Page: pages_show_list (GET /me/accounts), pages_manage_posts
 * (POST /{page}/photos and /videos), pages_read_engagement, which Meta lists
 * as a required dependency of pages_manage_posts, and business_management.
 * No comment moderation.
 *
 * business_management: GET /me/accounts lists a Page that a business portfolio
 * owns only when the token has it. Checked live on 2026-11-09: without it,
 * connecting a portfolio-owned Page returned zero Pages. Most small businesses
 * keep their Page in a portfolio, so this is required.
 */
export const FACEBOOK_PAGE_SCOPES = [
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
  "business_management",
] as const;

/**
 * Instagram professional account (through its linked Page): instagram_basic
 * (account id, username, permalinks), instagram_content_publish (media containers
 * and media_publish), pages_show_list + pages_read_engagement (finding the
 * account through its Page; dependencies of instagram_content_publish), and
 * business_management, for a Page owned by a business portfolio (see
 * FACEBOOK_PAGE_SCOPES). No comment or message permissions.
 */
export const INSTAGRAM_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
] as const;

/**
 * YouTube: youtube.upload (videos.insert, multipart and resumable) and
 * youtube.readonly (channels.list mine=true at connect, videos.list statistics).
 * Not youtube.force-ssl: the app never edits, deletes or comments.
 */
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
] as const;

/** Google Business Profile: local posts, gallery media and review replies. */
export const GOOGLE_BUSINESS_PROFILE_SCOPES = ["https://www.googleapis.com/auth/business.manage"] as const;
