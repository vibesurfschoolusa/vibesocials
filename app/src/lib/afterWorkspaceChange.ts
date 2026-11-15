/**
 * Ends every action that changes the ACTIVE workspace (join, switch, create,
 * leave, delete) with a full page load. Client views fetch under the workspace
 * active when they mounted, and the account menu and the workspace banner read
 * once per page load; router.refresh() re-renders only server components, so
 * it left the top bar and the views on the old workspace (R14, R15). A change
 * that keeps the active workspace (a rename, stepping down to member) ends in
 * router.refresh() and announceWorkspaceChange() instead (R16).
 * noPrefetchRouteHandlers.guard.test.ts checks both.
 *
 * With no address the current page loads again (Leave stays on Settings, a
 * switch stays where it was), without the one-time parameters below: they
 * carried the last workspace's message, such as "Facebook connected." or a
 * plan's "Thanks", which the next workspace must not show (R16-pages L1). The
 * load then replaces the history entry, as a reload would. Otherwise the given
 * page loads.
 */
export function afterWorkspaceChange(
  to?: string,
  location: Pick<Location, "assign" | "reload" | "replace" | "href"> = window.location,
): void {
  if (to !== undefined) {
    location.assign(to);
    return;
  }
  const cleaned = withoutOneTimeParams(location.href);
  // Same address: reload, since assigning it with a #section would only scroll.
  if (cleaned === null) location.reload();
  else location.replace(cleaned);
}

/**
 * Address parameters that say what just happened, in the workspace active at
 * the time: OAuth returns (success, error, location_cleared, same_end,
 * signed_in_as), checkout's return (billing), /go's notice, and the
 * connection dialogs (choose, linkedin_setup). afterWorkspaceChange.test.ts
 * fails a parameter a page reads that is neither here nor kept on purpose.
 */
export const ONE_TIME_PARAMS: readonly string[] = [
  "success",
  "error",
  "billing",
  "notice",
  "location_cleared",
  "same_end",
  "signed_in_as",
  "choose",
  "linkedin_setup",
];

/** The path, query and section of `href` without the one-time parameters, or null when it has none. */
export function withoutOneTimeParams(href: string): string | null {
  const url = new URL(href);
  const present = ONE_TIME_PARAMS.filter((name) => url.searchParams.has(name));
  if (present.length === 0) return null;
  for (const name of present) url.searchParams.delete(name);
  return `${url.pathname}${url.search}${url.hash}`;
}
