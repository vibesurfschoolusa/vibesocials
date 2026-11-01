import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { buildApprovalRequestedEmail } from "@/server/notifications/approvalEmail";
import { sendEmail } from "@/server/notifications/email";

/**
 * Tell every OWNER of the workspace that a member's post is waiting for their
 * approval (2026-11-01 audit — `buildApprovalRequestedEmail` existed but was
 * never sent, so owners had no idea anything was waiting). Called whenever a
 * post BECOMES pending: the create-time hold, a publish-route submission, and
 * an edit that re-holds a scheduled post.
 *
 * Always sends — `User.notifyOnPostComplete` is about publish OUTCOMES, not
 * review requests. Never emails the submitter. Never throws: a lookup or mail
 * failure is logged and swallowed, because the submission is already
 * committed and must not fail over a notification.
 */
export async function notifyOwnersOfApprovalRequest(params: {
  workspaceId: string;
  workspaceName: string;
  submitter: { id: string; name: string | null; email: string };
  caption: string;
}): Promise<void> {
  try {
    const owners = await prisma.workspaceMember.findMany({
      where: { workspaceId: params.workspaceId, role: "owner", userId: { not: params.submitter.id } },
      select: { user: { select: { email: true } } },
    });
    if (owners.length === 0) return;

    // Same display rule as the activity feed's `createdBy`: the name, else the
    // email local-part — never the submitter's full address.
    const submitterName =
      params.submitter.name?.trim() || params.submitter.email.split("@")[0];
    const email = buildApprovalRequestedEmail({
      submitterName,
      workspaceName: params.workspaceName,
      caption: params.caption,
      appBaseUrl: process.env.NEXTAUTH_URL ?? null,
    });

    await Promise.all(owners.map((owner) => sendEmail({ to: owner.user.email, ...email })));
  } catch (error) {
    logger.error("[Notifications] Failed to notify owners of an approval request", {
      error,
      workspaceId: params.workspaceId,
    });
  }
}
