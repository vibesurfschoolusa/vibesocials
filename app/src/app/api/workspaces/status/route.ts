import { NextResponse } from "next/server";

import { getWorkspaceContext } from "@/lib/workspace";
import {
  accessBlock,
  EMAIL_UNCONFIRMED_CODE,
  PLAN_ENDED_CODE,
  trialDaysLeftNotice,
  trialEndingNotice,
} from "@/lib/workspaceStatus";
import { signedOutResponse } from "@/lib/signedOutResponse";
import { renderedWorkspaceRefusal, sentWorkspaceId } from "@/lib/workspaceChanged";

export const dynamic = "force-dynamic";

/**
 * GET /api/workspaces/status — why the active workspace cannot work, if it
 * cannot (2026-11-10: paused by the operator; 21a: with billing on, a trial or
 * plan that has ended, and for owners a trial ending within 3 days as
 * `trialNotice`, sent only when there is one; 23: with billing on, an
 * unconfirmed email address in a trial or paid workspace, with
 * `emailUnconfirmed` so the banner offers to send the link again). The banner
 * on every signed-in page reads it; the message is the one the refusing routes
 * answer with. S1, billing on: owners earlier in a trial get the days left as
 * `trialDaysLeft`, and an owner of a workspace whose trial or plan ended gets
 * `planLink`, so the banner links to Settings, Plan. Read
 * fresh on every call (no-store), so a pause or resume shows on the next page.
 */
export async function GET(request: Request) {
  const context = await getWorkspaceContext();
  if (!context) {
    return signedOutResponse();
  }

  // R32: the workspace the shell's page was drawn for, so a tab left on it never shows another one's pause or trial line.
  const workspaceRefusal = renderedWorkspaceRefusal(sentWorkspaceId(request), context.workspace.id);
  if (workspaceRefusal) return workspaceRefusal;
  const block = accessBlock(context);
  const trialNotice = block ? null : trialEndingNotice(context.workspace, context.role, new Date(), context.user.timeZone ?? null);
  const trialDaysLeft = block || trialNotice ? null : trialDaysLeftNotice(context.workspace, context.role);
  const planLink = block?.code === PLAN_ENDED_CODE && context.role === "owner";
  return NextResponse.json(
    {
      blockedMessage: block?.message ?? null,
      ...(block?.code === EMAIL_UNCONFIRMED_CODE ? { emailUnconfirmed: true } : {}),
      ...(trialNotice ? { trialNotice } : {}),
      ...(trialDaysLeft ? { trialDaysLeft } : {}),
      ...(planLink ? { planLink: true } : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
