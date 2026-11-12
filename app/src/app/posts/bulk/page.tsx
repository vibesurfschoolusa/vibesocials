import Link from "next/link";
import { redirect } from "next/navigation";

import { planIncludes } from "@/lib/planFeatures";
import { getWorkspaceContext } from "@/lib/workspace";
import { BulkPostsForm } from "./bulk-posts-form";

// Signed-out visitors go to login before any client work runs (as on Queue and
// Create). The workspace id is sent with every create request, as on Create, so
// a workspace switch in another tab is refused instead of posting there.
export default async function BulkPostsPage() {
  const context = await getWorkspaceContext();

  if (!context) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/posts/bulk")}`);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-6">
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
        <BulkPostsForm workspaceId={context.workspace.id} />
      ) : (
        <p className="text-sm text-foreground">
          Add many is part of the Growth and Pro plans.{" "}
          <Link href="/settings#plan" className="font-medium text-primary underline-offset-4 hover:underline">
            Choose a plan in Settings, Plan
          </Link>
          .
        </p>
      )}
    </div>
  );
}
