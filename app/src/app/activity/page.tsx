import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { getWorkspaceContext } from "@/lib/workspace";
import { ActivityView } from "./activity-view";

// Server-side auth gate (matches settings/page.tsx): unauthenticated users are
// redirected before any client work runs. Authed users get the client view,
// which fetches and renders their post jobs.
export const metadata = { title: "Activity | Vibe Socials" };

export default async function ActivityPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/activity")}`);
  }

  // R32 publishing L1: the list's reads name this workspace, so a tab left on
  // it after another tab switched never fills with the other one's posts.
  const context = await getWorkspaceContext();
  return <ActivityView workspaceId={context?.workspace.id ?? null} />;
}
