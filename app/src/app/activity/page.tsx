import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { ActivityView } from "./activity-view";

// Server-side auth gate (matches settings/page.tsx): unauthenticated users are
// redirected before any client work runs. Authed users get the client view,
// which fetches and renders their post jobs.
export default async function ActivityPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/activity")}`);
  }

  return <ActivityView />;
}
