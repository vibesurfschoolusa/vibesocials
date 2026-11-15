import { billingFieldsSelect } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { planIncludes } from "@/lib/planFeatures";
import { sendEmail } from "@/server/notifications/email";
import { workspaceLink } from "@/server/notifications/links";

/**
 * R5-security L1 (2026-11-14): an owner can copy the client upload link and
 * the client review link, and both keep working after that owner is demoted
 * or leaves. The owners who remain are emailed that the person had them, and
 * the demote answer offers "Make new client links" (POST
 * /api/workspaces/client-links, which replaces both at once).
 *
 * R6 M2: the client connect link too. One another owner made keeps working
 * and the former owner may have copied it ("works"); one the former owner
 * made acts as them, so it stopped working with their ownership
 * (server/connectLink/link.ts) and the client needs a new one ("stopped").
 * The same button replaces it, with the same platforms.
 *
 * R7-pages L3 / client-journey L2: on a plan without client links the links
 * are paused, not off (lib/uploadLink.ts and the others answer as inactive),
 * and "Make new client links" is refused. So the email says they are paused,
 * that the former owner's copies would work again on a plan with client
 * links, and offers "Turn off client links" (DELETE
 * /api/workspaces/client-links), which works on any plan. A connect link
 * that already stopped works for nobody and can't be replaced on that plan,
 * so with nothing else on there is nothing to say.
 *
 * R7-security L4: leaving also turns off the invite links the person made
 * (../../leave); the email says how many.
 */

/** The client connect link at the moment someone stopped being an owner. */
export type FormerOwnerConnectLink = "works" | "stopped" | null;

function listOf(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Settings, Team: where the owners make new client links. */
export const CLIENT_LINKS_SETTINGS_PATH = "/settings#team";

/** Minimal HTML-entity escaper (same table as the email builders). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildFormerOwnerEmail(input: {
  workspaceId: string;
  workspaceName: string;
  formerOwnerName: string;
  uploadLink: boolean;
  reviewLink: boolean;
  connectLink?: FormerOwnerConnectLink;
  /** False when the workspace's plan doesn't include client links (they are paused). */
  clientLinksIncluded?: boolean;
  /** How many invite links the person made were turned off as they left. */
  joinLinksRevoked?: number;
  appBaseUrl: string | null | undefined;
}): { subject: string; html: string; text: string } {
  const { workspaceName, formerOwnerName } = input;
  const href = workspaceLink(input.workspaceId, CLIENT_LINKS_SETTINGS_PATH, input.appBaseUrl);
  const invites = inviteLinksLine(formerOwnerName, workspaceName, input.joinLinksRevoked ?? 0);
  if (input.clientLinksIncluded === false) {
    return pausedLinksEmail({ ...input, href, invites });
  }
  const working = [
    input.uploadLink ? "client upload link" : null,
    input.reviewLink ? "client review link" : null,
    input.connectLink === "works" ? "client connect link" : null,
  ].filter((name): name is string => name !== null);
  const stopped = input.connectLink === "stopped";
  const replaced = working.length + (stopped ? 1 : 0);

  const lines: string[] = [];
  const notOwner = `${formerOwnerName} is no longer an owner of ${workspaceName}.`;
  lines.push(
    working.length > 0
      ? `${notOwner} As an owner, ${formerOwnerName} had access to its ${listOf(working)}, and ${working.length > 1 ? "those links still work" : "that link still works"}.`
      : notOwner,
  );
  if (stopped) {
    lines.push(
      `The client connect link ${formerOwnerName} made stopped working when ${formerOwnerName} stopped being an owner, so your client can't connect accounts with it.`,
    );
  }
  const replaces = replaced === 1 ? "it" : replaced === 2 ? "both at once" : "all three at once";
  lines.push(
    working.length === 0
      ? 'To make a new one with the same platforms, open Settings, Team and press "Make new client links"; send the new link to your client.'
      : `To stop ${working.length > 1 ? "them" : "it"} working, open Settings, Team and press "Make new client links". It replaces ${replaces}; send the new ${replaced > 1 ? "links" : "link"} to your client.`,
  );
  if (invites) lines.push(invites);
  return {
    subject: `Make new client links for ${workspaceName}`,
    text: `${lines.join("\n\n")}\n\nOpen Settings, Team: ${href}\n`,
    html: `${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}<p><a href="${escapeHtml(href)}">Open Settings, Team</a></p>`,
  };
}

function inviteLinksLine(formerOwnerName: string, workspaceName: string, count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? `The invite link ${formerOwnerName} made was turned off when ${formerOwnerName} left, so it can't be used to join ${workspaceName} again.`
    : `The ${count} invite links ${formerOwnerName} made were turned off when ${formerOwnerName} left, so they can't be used to join ${workspaceName} again.`;
}

/** The plan doesn't include client links: the working ones are paused, and can be turned off. */
function pausedLinksEmail(input: {
  workspaceName: string;
  formerOwnerName: string;
  uploadLink: boolean;
  reviewLink: boolean;
  connectLink?: FormerOwnerConnectLink;
  href: string;
  invites: string | null;
}): { subject: string; html: string; text: string } {
  const { workspaceName, formerOwnerName } = input;
  const paused = [
    input.uploadLink ? "client upload link" : null,
    input.reviewLink ? "client review link" : null,
    input.connectLink === "works" ? "client connect link" : null,
  ].filter((name): name is string => name !== null);
  const one = paused.length === 1;
  const lines = [
    `${formerOwnerName} is no longer an owner of ${workspaceName}. As an owner, ${formerOwnerName} had access to its ${listOf(paused)}. ${one ? "It is" : "They are"} paused, because this workspace's plan doesn't include client links.`,
    `If the plan changes to one with client links (Growth or Pro), the copies ${formerOwnerName} kept would work again. To stop that, open Settings, Team and press "Turn off client links".`,
  ];
  if (input.invites) lines.push(input.invites);
  return {
    subject: `Turn off client links for ${workspaceName}`,
    text: `${lines.join("\n\n")}\n\nOpen Settings, Team: ${input.href}\n`,
    html: `${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}<p><a href="${escapeHtml(input.href)}">Open Settings, Team</a></p>`,
  };
}

/**
 * After `formerOwner` stopped being an owner of the workspace (demoted, or
 * left): when a client upload, review or connect link is on, emails each remaining
 * owner once and answers that the links should be replaced. Best-effort and
 * never throws: the change it follows has already been made.
 */
export async function noticeOwnersOfFormerOwner(input: {
  workspaceId: string;
  workspaceName: string;
  formerOwnerId: string;
  /** Given when the person is being deleted, so their row cannot be read. */
  formerOwnerName?: string;
  at: Date;
  /** Given by a leave: how many of the person's invite links it turned off. */
  joinLinksRevoked?: number;
}): Promise<{ clientLinksToReplace: boolean }> {
  const { workspaceId, formerOwnerId } = input;
  let links: { uploadLink: boolean; reviewLink: boolean; connectLink: FormerOwnerConnectLink };
  let clientLinksIncluded: boolean;
  try {
    const [upload, review, connect, workspace] = await Promise.all([
      prisma.workspaceUploadLink.findFirst({ where: { workspaceId, revokedAt: null }, select: { id: true } }),
      prisma.workspaceReviewLink.findFirst({ where: { workspaceId, revokedAt: null }, select: { id: true } }),
      prisma.workspaceConnectLink.findFirst({
        where: { workspaceId, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { createdById: true },
      }),
      prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, ...billingFieldsSelect() } }),
    ]);
    clientLinksIncluded = planIncludes(workspace ?? {}, "clientLinks");
    let connectLink: FormerOwnerConnectLink = null;
    if (connect?.createdById === formerOwnerId) {
      connectLink = "stopped";
    } else if (connect) {
      // Made by someone still an owner: it works, and this person may have copied it.
      // Made by an earlier former owner: it stopped then, and is not this notice's news.
      const creator = await prisma.workspaceMember.findFirst({
        where: { workspaceId, userId: connect.createdById, role: "owner" },
        select: { id: true },
      });
      connectLink = creator ? "works" : null;
    }
    links = { uploadLink: upload !== null, reviewLink: review !== null, connectLink };
  } catch (error) {
    logger.error("[workspaces] Couldn't read the client links after an owner stepped down", { error, workspaceId });
    return { clientLinksToReplace: false };
  }
  if (!links.uploadLink && !links.reviewLink && !links.connectLink) return { clientLinksToReplace: false };
  // Paused by the plan: a stopped connect link alone leaves nothing to turn off.
  if (!clientLinksIncluded && !links.uploadLink && !links.reviewLink && links.connectLink !== "works") {
    return { clientLinksToReplace: false };
  }

  try {
    const [former, owners] = await Promise.all([
      input.formerOwnerName
        ? Promise.resolve({ name: input.formerOwnerName, email: input.formerOwnerName })
        : prisma.user.findUnique({ where: { id: formerOwnerId }, select: { name: true, email: true } }),
      prisma.workspaceMember.findMany({
        where: { workspaceId, role: "owner", userId: { not: formerOwnerId } },
        select: { user: { select: { id: true, email: true } } },
      }),
    ]);
    const email = buildFormerOwnerEmail({
      workspaceId,
      workspaceName: input.workspaceName,
      formerOwnerName: former?.name?.trim() || former?.email || "A former owner",
      ...links,
      clientLinksIncluded,
      joinLinksRevoked: input.joinLinksRevoked ?? 0,
      appBaseUrl: process.env.NEXTAUTH_URL || null,
    });
    for (const owner of owners) {
      await sendEmail(
        { to: owner.user.email, ...email },
        {
          idempotencyKey: `former-owner-links/${workspaceId}/${formerOwnerId}/${input.at.toISOString()}/${owner.user.id}`,
        },
      );
    }
  } catch (error) {
    logger.error("[workspaces] Couldn't email the owners about the client links", {
      error: error instanceof Error ? error.name : typeof error,
      workspaceId,
    });
  }
  return { clientLinksToReplace: true };
}
