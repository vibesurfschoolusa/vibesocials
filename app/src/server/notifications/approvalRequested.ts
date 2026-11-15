import type { Platform } from "@prisma/client";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { personLabel } from "@/lib/usageLimits";
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
  /**
   * 2026-11-01 audit (M1): the per-platform texts that will publish with the
   * post (`resolvePlatformCaptions`), or `null` for none. Required so a caller
   * can't forget them - the owner approves what goes out, not just the base
   * caption.
   */
  platformCaptions: Partial<Record<Platform, string>> | null;
  /** A held repeating post (brief 11): the one email says how many posts and when. */
  series?: { count: number; first: Date; last: Date };
  /** A held Feed and Story post (Q1): the platforms its Story job goes to. */
  alsoAsStory?: readonly Platform[];
}): Promise<void> {
  try {
    const owners = await prisma.workspaceMember.findMany({
      where: { workspaceId: params.workspaceId, role: "owner", userId: { not: params.submitter.id } },
      select: { user: { select: { email: true, timeZone: true } } },
    });
    if (owners.length === 0) return;

    // Every reader is an owner: the one person label gives the name, else the
    // full address, as the Team card and the posts' "by" show it to owners
    // (R15-new-customer L3).
    const submitterName = personLabel(params.submitter, true);
    // One email per owner: a repeating post's days are shown in each owner's own zone (F4).
    const emailFor = (timeZone: string | null) =>
      buildApprovalRequestedEmail({
        submitterName,
        workspaceId: params.workspaceId,
        workspaceName: params.workspaceName,
        caption: params.caption,
        platformCaptions: params.platformCaptions,
        timeZone,
        appBaseUrl: process.env.NEXTAUTH_URL ?? null,
        ...(params.series ? { series: params.series } : {}),
        ...(params.alsoAsStory ? { alsoAsStory: params.alsoAsStory } : {}),
      });

    await Promise.all(
      owners.map((owner) => sendEmail({ to: owner.user.email, ...emailFor(owner.user.timeZone ?? null) })),
    );
  } catch (error) {
    logger.error("[Notifications] Failed to notify owners of an approval request", {
      error,
      workspaceId: params.workspaceId,
    });
  }
}
