import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import type { CaptionFooterUser } from "@/lib/captionFooter";
import { getWorkspaceContext } from "@/lib/workspace";
import { QueueView } from "./queue-view";

export const metadata = { title: "Queue | Vibe Socials" };

// Server-side auth gate (matches activity/page.tsx): unauthenticated users are
// redirected before any client work runs. Authed users get the client view,
// which fetches and manages their scheduled + draft posts.
export default async function QueuePage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/queue")}`);
  }

  // The workspace footer appended at publish time, projected to the same two
  // fields the Create page passes (app/posts/new/page.tsx), so the edit
  // dialog's per-platform counters and "Adapt" length leave room for it.
  const context = await getWorkspaceContext();
  const footerSettings: CaptionFooterUser | undefined = context
    ? {
        companyWebsite: context.workspace.companyWebsite,
        defaultHashtags: context.workspace.defaultHashtags,
        trackWebsiteLinks: context.workspace.trackWebsiteLinks,
      }
    : undefined;

  return <QueueView footerSettings={footerSettings} />;
}
