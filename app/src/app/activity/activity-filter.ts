/**
 * N3: Activity's two tabs. The choice lives in the URL so the dashboard can
 * link straight to `/activity?show=problems`.
 */
export type ActivityFilter = "all" | "problems";

/** The tab a URL query selects; anything but `show=problems` is all posts. */
export function activityFilterFromSearch(search: string | URLSearchParams): ActivityFilter {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return params.get("show") === "problems" ? "problems" : "all";
}

/** The Activity URL for a tab. */
export function activityFilterHref(filter: ActivityFilter): string {
  return filter === "problems" ? "/activity?show=problems" : "/activity";
}

/** What the list says when a tab has no posts. */
export function activityEmptyState(filter: ActivityFilter): {
  title: string;
  description: string | null;
  showCreate: boolean;
} {
  if (filter === "problems") {
    return { title: "No post has had a problem.", description: null, showCreate: false };
  }
  return {
    title: "No posts yet",
    description:
      "When you publish a post, it'll appear here with a per-platform breakdown of what succeeded and what failed.",
    showCreate: true,
  };
}
