/**
 * 2026-11-01 audit (M3): the active workspace lives in a cookie that every tab
 * shares, so a workspace switch in tab B silently re-points tab A's next
 * request. The composer therefore sends the id of the workspace it was
 * RENDERED for, and POST /api/posts refuses (409) when that no longer matches.
 *
 * Shared by the route and the composer so the copy and codes cannot drift.
 */

/** 409 `code` when the request's `workspaceId` is not the active workspace. */
export const WORKSPACE_CHANGED_CODE = "WORKSPACE_CHANGED";

/** 400 `code` when `workspaceId` is present but not a string. */
export const INVALID_WORKSPACE_ID_CODE = "INVALID_WORKSPACE_ID";

export const WORKSPACE_CHANGED_MESSAGE =
  "You switched workspace in another tab. Reload this page before posting.";

export const INVALID_WORKSPACE_ID_MESSAGE = "workspaceId must be a string if provided";
