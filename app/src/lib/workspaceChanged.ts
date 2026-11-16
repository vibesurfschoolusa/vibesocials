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

/**
 * F3 (2026-11-14 review, R1 security H1): the owner and member writes outside
 * Create (Settings, posting times, team, connections, the Google location,
 * rename and delete) REQUIRE the id; an absent one is this 400, so a write
 * that forgot to send it fails at once instead of trusting the cookie.
 */
export const MISSING_WORKSPACE_ID_CODE = "MISSING_WORKSPACE_ID";

export const MISSING_WORKSPACE_ID_MESSAGE = "This page is out of date. Reload it, then try again.";

/** Create's sentence says "before posting"; these writes save settings. */
export const WORKSPACE_CHANGED_SAVE_MESSAGE =
  "You switched workspace in another tab. Reload this page, then try again.";

/**
 * The refusal for a write whose `sent` workspace id is not the active
 * workspace, or null when it may go on: 400 when it is absent or not text
 * (JSON null counts as not text, as in POST /api/posts),
 * 409 WORKSPACE_CHANGED when it names another workspace. A plain `Response`,
 * so this file stays importable from client code.
 */
export function renderedWorkspaceRefusal(sent: unknown, activeWorkspaceId: string): Response | null {
  if (sent === undefined || sent === "") {
    return Response.json({ error: MISSING_WORKSPACE_ID_MESSAGE, code: MISSING_WORKSPACE_ID_CODE }, { status: 400 });
  }
  if (typeof sent !== "string") {
    return Response.json({ error: INVALID_WORKSPACE_ID_MESSAGE, code: INVALID_WORKSPACE_ID_CODE }, { status: 400 });
  }
  if (sent !== activeWorkspaceId) {
    return Response.json({ error: WORKSPACE_CHANGED_SAVE_MESSAGE, code: WORKSPACE_CHANGED_CODE }, { status: 409 });
  }
  return null;
}

/**
 * R31: the shared sentence for a refusal code of renderedWorkspaceRefusal, for
 * the pages that word a refusal by its code rather than showing the route's
 * text; null for any other code.
 */
export function pageWorkspaceRefusalText(code: unknown): string | null {
  if (code === WORKSPACE_CHANGED_CODE) return WORKSPACE_CHANGED_SAVE_MESSAGE;
  if (code === MISSING_WORKSPACE_ID_CODE || code === INVALID_WORKSPACE_ID_CODE) return MISSING_WORKSPACE_ID_MESSAGE;
  return null;
}

/** `path` with `workspaceId` added to its query, for the OAuth start links. */
export function withWorkspaceId(path: string, workspaceId: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}workspaceId=${encodeURIComponent(workspaceId)}`;
}
