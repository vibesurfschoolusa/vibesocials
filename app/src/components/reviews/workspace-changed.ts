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

/**
 * R27 lead review: which refusal the page shows after `next`. "press" (a reply
 * or draft, with typed text and the copy hint on the page) is never downgraded
 * to "load" (which hides the list), so the typed text can still be copied.
 */
export function workspaceChangedAfter(prev: "load" | "press" | null, next: "load" | "press"): "load" | "press" {
  return prev === "press" ? "press" : next;
}
