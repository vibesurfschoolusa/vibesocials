import Link from "next/link";
import { redirect } from "next/navigation";

import { APP_PAGE_CLASS } from "@/lib/pageLayout";
import { planIncludes } from "@/lib/planFeatures";
import { getWorkspaceContext } from "@/lib/workspace";
import { BulkPostsForm } from "./bulk-posts-form";
import { loadMediaHandoff } from "./mediaHandoff";

// Signed-out visitors go to login before any client work runs (as on Queue and
// Create). The workspace id is sent with every create request, as on Create, so
// a workspace switch in another tab is refused instead of posting there.
export const metadata = { title: "Add many | Vibe Socials" };

export default async function BulkPostsPage({
  searchParams,
}: {
  searchParams?: Promise<{ media?: string | string[] }>;
} = {}) {
  const context = await getWorkspaceContext();

  if (!context) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/posts/bulk")}`);
  }

  // "Schedule with Add many" on the Media page sends ?media=id1,id2. Read only for a
  // plan that has Add many, and only this workspace's items come back.
  const mediaParam = (await searchParams)?.media;
  const handoff =
    mediaParam !== undefined && planIncludes(context.workspace, "bulk")
      ? await loadMediaHandoff(context.workspace.id, mediaParam)
      : { items: [], skipped: 0 };

  return (
    <div className={APP_PAGE_CLASS}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Add many posts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Add up to 20 photos and videos. Each one becomes its own post with an AI caption, spread over the
          coming days.
        </p>
      </div>
      {/* P1: Add many is a Growth and Pro feature. Its requests are Create's own POST
          /api/posts calls, so the page is the one place it can be gated. */}
      {planIncludes(context.workspace, "bulk") ? (
        <BulkPostsForm
          workspaceId={context.workspace.id}
          initialMedia={handoff.items}
          skippedMedia={handoff.skipped}
        />
      ) : context.role !== "owner" ? (
        // P1 fix round 2: a member cannot see Settings, Plan.
        <p className="text-sm text-foreground">
          Add many is part of the Growth and Pro plans. Ask the workspace owner about changing the plan.
        </p>
      ) : (
        <p className="text-sm text-foreground">
          Add many is part of the Growth and Pro plans. See{" "}
          <Link href="/settings#plan" className="font-medium text-primary underline-offset-4 hover:underline">
            Settings, Plan
          </Link>
          .
        </p>
      )}
    </div>
  );
}
