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

/**
 * One order for several reads of the same data (the menu's list, the banner's
 * status): a page load or navigation read and an announce read can answer out
 * of order. `next()` is called as a read starts; the function it returns is
 * called when its answer arrives and says whether to show it: not when a read
 * started later has already shown its answer. A later read that fails never
 * shows, so it holds nothing back.
 */
export function newestAnswer(): { next(): () => boolean } {
  let started = 0;
  let shown = 0;
  return {
    next() {
      const mine = ++started;
      return () => {
        if (mine < shown) return false;
        shown = mine;
        return true;
      };
    },
  };
}

/** Calls `listener` on each announce; the answer unsubscribes. */
export function subscribeWorkspaceChange(listener: () => void): () => void {
  const onEvent = () => listener();
  window.addEventListener(WORKSPACE_CHANGED_EVENT, onEvent);
  return () => window.removeEventListener(WORKSPACE_CHANGED_EVENT, onEvent);
}
