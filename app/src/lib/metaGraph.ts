/**
 * The one place the Meta Graph API version is set (Facebook Pages, Instagram,
 * and the Facebook Login dialog).
 *
 * Meta retires each version about two years after release, and a call to a
 * retired version stops working as written. v21.0 (used until 2026-11) is
 * retired on 2027-01-21. v26.0 was released 2026-07-29. The v22.0–v26.0
 * changelogs list no change to anything this app calls: the OAuth dialog,
 * oauth/access_token (code and long-lived exchange), /me/accounts,
 * /{page-id}/photos, /{ig-user-id}/media, /media_publish and the container
 * `status_code` field.
 *
 * To move to a newer version: read that version's changelog for those
 * endpoints, change META_GRAPH_VERSION, and do one live post to Facebook and
 * Instagram. Versions and retirement dates:
 * https://developers.facebook.com/docs/graph-api/changelog/versions/
 */
export const META_GRAPH_VERSION = "v26.0";

/** Base URL for Graph API calls, e.g. `${META_GRAPH_BASE_URL}/me/accounts`. */
export const META_GRAPH_BASE_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

/** The Facebook Login (OAuth) dialog for the same version. */
export const META_OAUTH_DIALOG_URL = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;
