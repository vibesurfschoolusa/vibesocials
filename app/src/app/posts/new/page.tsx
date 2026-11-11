import Link from "next/link";
import { redirect } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";

import { getWorkspaceContext } from "@/lib/workspace";
import { CreatePostForm } from "@/components/create-post-form";
import type { CaptionFooterUser } from "@/lib/captionFooter";
import { googleButtonFromWorkspace } from "@/lib/googlePostOptions";

export default async function NewPostPage() {
  const context = await getWorkspaceContext();

  if (!context) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/posts/new")}`);
  }

  // SEC-1: project only the two caption-footer fields the Preview section
  // needs (Roadmap Phase 7) so passwordHash/email never reach the client
  // component payload — same pattern as `settings/page.tsx`'s `UserSettings`
  // projection. Team Workspaces (Task 7): sourced from the active WORKSPACE,
  // not the composing user — the footer is brand-level (design §2) and this
  // is what actually gets published (Task 6 moved the publish-time footer
  // read to `postJob.workspaceId`'s Workspace row), so the preview now
  // matches what every member — owner or not — will actually publish.
  const footerSettings: CaptionFooterUser = {
    companyWebsite: context.workspace.companyWebsite,
    defaultHashtags: context.workspace.defaultHashtags,
    trackWebsiteLinks: context.workspace.trackWebsiteLinks,
  };

  // 2026-11-01 audit: a member's publish is held for an owner's approval on the
  // server, so the composer's confirmation must not claim it "publishes
  // immediately". Only the boolean reaches the client.
  const holdsForApproval =
    context.role === "member" && context.workspace.requireApproval;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 md:px-6">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Create post</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload a new image or video, then post to your connected platforms.
          </p>
        </div>
        <Link href="/posts/bulk" className={buttonVariants({ variant: "outline", size: "md" })}>
          Add many at once
        </Link>
      </div>

      {/* 2026-11-01 audit (M3): the composer sends the workspace it was rendered
          for, so a switch in another tab is refused (409) instead of publishing
          into the new workspace. */}
      <CreatePostForm
        footerSettings={footerSettings}
        holdsForApproval={holdsForApproval}
        workspaceId={context.workspace.id}
        // 2026-11-10: Google posts start with the workspace's default button.
        googleButtonDefault={googleButtonFromWorkspace(context.workspace)}
      />
    </div>
  );
}
