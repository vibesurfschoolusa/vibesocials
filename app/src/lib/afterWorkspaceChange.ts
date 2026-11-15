/**
 * Ends every action that changes the active workspace, the list of workspaces
 * or a workspace's name (join, switch, create, leave, rename, delete) with a
 * full page load. The account menu reads its workspaces, and the workspace
 * banner its status, once per page load, and client views fetch under the
 * workspace active when they mounted; router.refresh() re-renders only server
 * components, so it left the top bar naming the old workspace (R14, R15).
 * noPrefetchRouteHandlers.guard.test.ts fails a changing call without it.
 *
 * With no address the current page loads again (Leave and rename stay on
 * Settings); otherwise the given page loads.
 */
export function afterWorkspaceChange(
  to?: string,
  location: Pick<Location, "assign" | "reload"> = window.location,
): void {
  if (to === undefined) location.reload();
  else location.assign(to);
}
