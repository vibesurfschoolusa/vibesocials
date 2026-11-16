import { WORKSPACE_CHANGED_CODE } from "@/lib/workspaceChanged";

/**
 * R27: what a page says when a route refused it because the page was drawn for
 * another workspace (409 WORKSPACE_CHANGED, lib/workspaceChanged.ts): the
 * workspace switched in another tab. Reload draws the page for the active one
 * (workspace-changed-notice.tsx).
 */
export const WORKSPACE_CHANGED_RELOAD_MESSAGE =
  "This page was opened for another workspace. Reload to see the one you're working in.";

/** Whether an answer's body is that refusal; only the code is read. */
export function isWorkspaceChanged(body: { code?: unknown } | null | undefined): boolean {
  return body?.code === WORKSPACE_CHANGED_CODE;
}
