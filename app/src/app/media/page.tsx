import { redirect } from "next/navigation";

import { APP_PAGE_CLASS } from "@/lib/pageLayout";
import { getWorkspaceContext } from "@/lib/workspace";
import { MediaLibrary } from "@/components/media-library";

export const metadata = { title: "Media library | Vibe Socials" };

export default async function MediaPage() {
  const context = await getWorkspaceContext();

  if (!context) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/media")}`);
  }

  return (
    <div className={APP_PAGE_CLASS}>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Media library
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload videos or images once, then reuse them across posts and platforms.
        </p>
      </div>

      <div className="mt-8">
        {/* 2026-11-02 scale audit (correctness): the library sends the workspace it
            was rendered for, so an upload from a stale tab is refused (409)
            instead of landing in the workspace another tab switched to. */}
        <MediaLibrary workspaceId={context.workspace.id} />
      </div>
    </div>
  );
}
