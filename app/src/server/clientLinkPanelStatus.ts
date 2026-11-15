import { pausedByPlan } from "@/lib/planFeatures";
import { SUPPORT_EMAIL } from "@/lib/siteInfo";
import { PLAN_ENDED_CODE, workspaceBlock, type WorkspaceStatusFields } from "@/lib/workspaceStatus";

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
): { pausedByPlan?: true; workspaceBlocked?: string } {
  const block = workspaceBlock(workspace, now, "owner");
  if (block) return { workspaceBlocked: `Client links don't work right now. ${blockSentence(workspace, block)}` };
  return pausedByPlan(workspace, "clientLinks", process.env, now);
}

/**
 * The block in a link panel's words. A pause keeps its own sentence; an ended
 * trial or plan says what brings the links back, not the shared "to keep
 * posting" (GG2 review).
 */
function blockSentence(workspace: WorkspaceStatusFields, block: { code: string; message: string }): string {
  if (block.code !== PLAN_ENDED_CODE) return block.message;
  const ended = workspace.plan ? "Your plan has ended." : "Your free trial has ended.";
  return `${ended} Choose a plan in Settings and your client links work again, or contact ${SUPPORT_EMAIL}.`;
}

/**
 * GG2 review: the three link POSTs refuse while the workspace is blocked, with
 * the panel's sentence, so a hand-sent request can't make a link that answers
 * "not active" until the block ends. Null when a link may be made.
 */
export function clientLinkCreateRefusal(workspace: WorkspaceStatusFields, now: Date = new Date()): string | null {
  return clientLinkPanelStatus(workspace, now).workspaceBlocked ?? null;
}
