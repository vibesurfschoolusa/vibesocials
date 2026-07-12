import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { JoinView } from "./join-view";

interface JoinPageProps {
  params: Promise<{ token: string }>;
}

// Server-side auth gate (matches settings/activity/queue/reviews): a
// signed-out visitor is bounced to /login with a callbackUrl back to this
// exact invite link, so they land right back here post-login instead of on
// the dashboard. `getCurrentUser` (not `getWorkspaceContext`) — the token
// names the TARGET workspace, not the caller's active one; workspace
// resolution happens entirely in the invite API routes.
export default async function JoinPage({ params }: JoinPageProps) {
  const { token } = await params;
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/join/${token}`)}`);
  }

  return <JoinView token={token} />;
}
