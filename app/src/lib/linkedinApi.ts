/**
 * The one place the LinkedIn API version is set: posting (server/platforms/
 * linkedinClient.ts) and the company-page lookups of the OAuth callback
 * (server/connections/linkedinOrganizations.ts).
 *
 * LinkedIn's versioned APIs live under https://api.linkedin.com/rest. Every call
 * names the version it was written against in a `Linkedin-Version: YYYYMM`
 * header (a call without one, or with a sunset version, is refused) and sends
 * `X-Restli-Protocol-Version: 2.0.0`:
 * https://learn.microsoft.com/en-us/linkedin/marketing/versioning
 *
 * Each monthly version is supported for at least a year. 202610 (October 2026)
 * is the latest; its support ends on 2027-10-15
 * (https://learn.microsoft.com/en-us/linkedin/marketing/integrations/migrations).
 * Until 2026-11 the app sent 202405, which LinkedIn sunset on 2025-05-15.
 *
 * Calls that use it: POST /rest/posts, POST /rest/images?action=initializeUpload,
 * POST /rest/videos?action=initializeUpload|finalizeUpload, GET /rest/videos/{urn},
 * GET /rest/organizationAcls?q=roleAssignee, GET /rest/organizations/{id} and
 * GET /rest/organizations?q=vanityName. To move to a newer version: read
 * LinkedIn's changelog for those, change LINKEDIN_API_VERSION, and make one live
 * post with an image and one with a video before 2027-10-15.
 */
export const LINKEDIN_API_VERSION = "202610";

/** Base URL of LinkedIn's versioned REST APIs, e.g. `${LINKEDIN_REST_BASE_URL}/posts`. */
export const LINKEDIN_REST_BASE_URL = "https://api.linkedin.com/rest";

/** The Rest.li protocol version every versioned call sends. */
export const LINKEDIN_RESTLI_PROTOCOL_VERSION = "2.0.0";

/**
 * The headers of a call to the versioned REST APIs: the member token, the
 * version and the Rest.li protocol, plus `extra` (a `Content-Type`, say).
 */
export function linkedinRestHeaders(
  accessToken: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Linkedin-Version": LINKEDIN_API_VERSION,
    "X-Restli-Protocol-Version": LINKEDIN_RESTLI_PROTOCOL_VERSION,
    ...extra,
  };
}

/**
 * Characters LinkedIn's `little` text format reserves. The Posts API takes its
 * `commentary` in that format, and a reserved character that is not escaped
 * with a backslash is read as markup "even if those characters are not used in
 * one of the supported elements or templates":
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format
 * (`Text ::= ... "\\|" | "\\{" | "\\}" | "\\@" | "\\[" | "\\]" | "\\(" | "\\)" |
 * "\\<" | "\\>" | "\\#" | "\\\\" | "\\*" | "\\_" | "\\~"`).
 */
const LITTLE_RESERVED = /[\\|{}@[\]()<>#*_~]/gu;

/** A `#` followed by a letter or digit starts a hashtag (`HashtagElement ::= '#' SINGLE_WORD`). */
const HASHTAG_WORD_START = /^[\p{L}\p{N}]/u;

/**
 * A caption as `little` text, so the Posts API shows it as written: every
 * reserved character is escaped, except a `#` that starts a word, which stays a
 * hashtag. That matches what the legacy ugcPosts API did with plain text: it
 * linked `#word` as a hashtag and showed everything else as typed (an `@` was
 * never a mention without attributes).
 */
export function toLinkedInLittleText(text: string): string {
  return text.replace(LITTLE_RESERVED, (char: string, offset: number) => {
    if (char === "#" && HASHTAG_WORD_START.test(text.slice(offset + 1, offset + 3))) return char;
    return `\\${char}`;
  });
}
