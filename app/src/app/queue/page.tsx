import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { QueueView } from "./queue-view";

// Server-side auth gate (matches activity/page.tsx): unauthenticated users are
// redirected before any client work runs. Authed users get the client view,
// which fetches and manages their scheduled + draft posts.
export default async function QueuePage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return <QueueView />;
}
