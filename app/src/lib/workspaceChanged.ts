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
 * R41 second look L3: an owner-only read refused (403). The members route
 * checks the owner role before the workspace, so this is true both when the
 * viewer's role changed and when another tab switched workspace. The page was
 * drawn for an owner of this workspace; only reloading draws it for now.
 * R42 pages-b L2: no "in another tab", since another owner may have changed
 * the role. R66 pages-a-2 L1: every owner gate answers its 403 with it too,
 * since members never see the controls. Here, not in load-error.tsx, because
 * that file is "use client" and the server routes read this value.
 */
export const ROLE_CHANGED_MESSAGE = "Your role or workspace changed. Reload the page.";

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

/**
 * R32 publishing L1: the id a read sent as ?workspaceId=, for
 * renderedWorkspaceRefusal (absent is undefined, so it is that 400). Reads
 * answered for the cookie's workspace, which every tab shares, so a page drawn
 * for A filled itself with B's posts, files or times.
 */
export function sentWorkspaceId(request: Request): string | undefined {
  return new URL(request.url).searchParams.get("workspaceId") ?? undefined;
}

/**
 * R32: the shared sentence when a read was refused for the page's workspace
 * (pageWorkspaceRefusalText), else null. Reads a clone, so the caller can
 * still read the body of any other answer.
 */
export async function readWorkspaceRefusalText(response: Response): Promise<string | null> {
  if (response.status !== 409 && response.status !== 400) return null;
  const body = (await response.clone().json().catch(() => null)) as { code?: unknown } | null;
  return pageWorkspaceRefusalText(body?.code);
}

/**
 * `path` with `workspaceId` added to its query, for the OAuth start links
 * and (R32) every read. A page that couldn't read its workspace (null) sends
 * none, which the route answers with the reload sentence.
 */
export function withWorkspaceId(path: string, workspaceId: string | null): string {
  if (workspaceId === null) return path;
  return `${path}${path.includes("?") ? "&" : "?"}workspaceId=${encodeURIComponent(workspaceId)}`;
}
