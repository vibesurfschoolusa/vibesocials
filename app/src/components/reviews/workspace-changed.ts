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

/**
 * R27 lead's second review: what a page that knows it belongs to another
 * workspace shows. A refused list puts the selection back to the location whose
 * reviews are on screen, so the list is hidden only when none is selected. The
 * copy hint shows after a refused press, or whenever a reply box holds text.
 * The picker stays locked until Reload.
 */
export function refusedPageView(
  kind: "load" | "press" | null,
  selectedLocation: string | null,
  typedReply: boolean,
): { hideList: boolean; copyHint: boolean; locked: boolean } {
  if (kind === null) return { hideList: false, copyHint: false, locked: false };
  return { hideList: kind === "load" && selectedLocation === null, copyHint: kind === "press" || typedReply, locked: true };
}
