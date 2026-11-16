import { pausedByPlan, planOffers } from "@/lib/planFeatures";
import type { ClientLinkBlockKind } from "@/lib/clientLinkWording";
import { isPlanKey, PLANS } from "@/lib/plans";
import { SUPPORT_EMAIL } from "@/lib/siteInfo";
import { PLAN_ENDED_CODE, workspaceBlock, type WorkspaceStatusFields } from "@/lib/workspaceStatus";

export type { ClientLinkBlockKind };

/** What a link panel is told; also decides the client line in the reconnect emails (R24). */
export type ClientLinkPanelStatus = { pausedByPlan?: true; workspaceBlocked?: string };

/**
 * R21 client-journey L1: what the three owner link GETs add to their answer.
 * findActiveReviewLink, findActiveUploadLink and findActiveConnectLink refuse
 * every link while workspaceBlock is set (a pause, or with billing on an ended
 * trial or plan), so the panels are told the same and stop offering Copy and
 * Replace. The block wins over the plan flag: it is the reason the link fails.
 * The GETs are owner-only, so the sentence is the owner's.
 */
export function clientLinkPanelStatus(
  workspace: WorkspaceStatusFields,
  now: Date = new Date(),
): ClientLinkPanelStatus {
  const block = workspaceBlock(workspace, now, "owner");
  if (block) return { workspaceBlocked: `Client links don't work right now. ${blockSentence(workspace, block)}` };
  return pausedByPlan(workspace, "clientLinks", process.env, now);
}

/**
 * The block in a link panel's words. A pause keeps its own sentence; an ended
 * trial or plan says what brings the links back, not the shared "to keep
 * posting" (GG2 review). R23 pages L1: only Growth and Pro have client links,
 * so it names them, and an ended plan without them (Starter) says so rather
 * than suggest renewing it brings them back.
 */
function blockSentence(workspace: WorkspaceStatusFields, block: { code: string; message: string }): string {
  if (block.code !== PLAN_ENDED_CODE) return block.message;
  const again = `Choose Growth or Pro in Settings and your client links work again, or contact ${SUPPORT_EMAIL}.`;
  if (!workspace.plan) return `Your free trial has ended. ${again}`;
  if (planOffers(workspace, "clientLinks")) return `Your plan has ended. ${again}`;
  const ended = isPlanKey(workspace.plan)
    ? `Your ${PLANS[workspace.plan].name} plan has ended, and ${PLANS[workspace.plan].name} doesn't include client links.`
    : "Your plan has ended, and it doesn't include client links.";
  return `${ended} ${again}`;
}

/** What blocks the client links (pause or plan); null when nothing does. */
export function clientLinkBlockKind(workspace: WorkspaceStatusFields, now: Date = new Date()): ClientLinkBlockKind | null {
  const block = workspaceBlock(workspace, now, "owner");
  if (!block) return null;
  return block.code === PLAN_ENDED_CODE ? "plan" : "pause";
}

/**
 * GG2 review: the three link POSTs refuse while the workspace is blocked, with
 * the panel's sentence, so a hand-sent request can't make a link that answers
 * "not active" until the block ends. Null when a link may be made.
 */
export function clientLinkCreateRefusal(workspace: WorkspaceStatusFields, now: Date = new Date()): string | null {
  return clientLinkPanelStatus(workspace, now).workspaceBlocked ?? null;
}
