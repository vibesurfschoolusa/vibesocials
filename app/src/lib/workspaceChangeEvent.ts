/**
 * R16: a change that keeps the active workspace (a rename, an owner making
 * themselves a member) is not worth a full page load, which threw away unsaved
 * Settings typing and a freshly shown invite or connect link. The page refreshes
 * its server parts, and this event tells the two client parts that read once
 * per page load to read again: the account menu (GET /api/workspaces) and the
 * workspace banner (GET /api/workspaces/status). A change of the active
 * workspace itself still ends in afterWorkspaceChange.
 *
 * A plain module, not "use client": only client files call it.
 */

export const WORKSPACE_CHANGED_EVENT = "vibe:workspace-changed";

export function announceWorkspaceChange(): void {
  window.dispatchEvent(new Event(WORKSPACE_CHANGED_EVENT));
}

/** Calls `listener` on each announce; the answer unsubscribes. */
export function subscribeWorkspaceChange(listener: () => void): () => void {
  const onEvent = () => listener();
  window.addEventListener(WORKSPACE_CHANGED_EVENT, onEvent);
  return () => window.removeEventListener(WORKSPACE_CHANGED_EVENT, onEvent);
}
