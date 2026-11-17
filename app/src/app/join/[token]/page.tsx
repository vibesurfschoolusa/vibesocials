import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { hashInviteToken } from "@/lib/inviteToken";
import { JoinView } from "./join-view";

export const metadata: Metadata = {
  title: "Join a workspace | Vibe Socials",
  // The invite token is in the address and stays usable for 7 days, so only the
  // bare origin is ever sent as a referrer. Not "no-referrer": as on /c, a browser
  // without fetch metadata would then send `Origin: null` on the accept.
  referrer: "strict-origin",
};

interface JoinPageProps {
  params: Promise<{ token: string }>;
}

// Server-side auth gate (matches settings/activity/queue/reviews): a
// signed-out visitor is bounced to /login with a callbackUrl back to this
// exact invite link, so they land right back here post-login instead of on
// the dashboard. `getCurrentUser` (not `getWorkspaceContext`) — the token
// names the TARGET workspace, not the caller's active one; workspace
// resolution happens entirely in the invite API routes.
//
// R6-pages L4: whether the invite's workspace asks for approval, so the page
// says so. Read by the same token the preview route reads, and only the flag
// and this person's own role there: approval holds a member's posts, never an
// owner's, so an owner opening the link isn't told it. A dead or unreadable
// invite reads false, and the view then shows the preview route's answer.
async function requiresApprovalFor(token: string, userId: string): Promise<boolean> {
  try {
    const invite = await prisma.workspaceInvite.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      select: {
        workspace: {
          select: { requireApproval: true, members: { where: { userId }, select: { role: true } } },
        },
      },
    });
    if (!invite?.workspace.requireApproval) return false;
    return !invite.workspace.members.some((member) => member.role === "owner");
  } catch {
    return false;
  }
}

export default async function JoinPage({ params }: JoinPageProps) {
  const { token } = await params;
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/join/${token}`)}`);
  }

  return <JoinView token={token} requiresApproval={await requiresApprovalFor(token, user.id)} />;
}
