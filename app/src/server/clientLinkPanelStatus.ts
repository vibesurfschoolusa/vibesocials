import { pausedByPlan } from "@/lib/planFeatures";
import { workspaceBlock, type WorkspaceStatusFields } from "@/lib/workspaceStatus";

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
  if (block) return { workspaceBlocked: `Client links don't work right now. ${block.message}` };
  return pausedByPlan(workspace, "clientLinks", process.env, now);
}
