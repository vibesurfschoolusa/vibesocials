import { NextResponse } from "next/server";

import { getWorkspaceContext } from "@/lib/workspace";
import {
  accessBlock,
  EMAIL_UNCONFIRMED_CODE,
  PLAN_ENDED_CODE,
  trialDaysLeftNotice,
  trialEndingNotice,
} from "@/lib/workspaceStatus";

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
export async function GET() {
  const context = await getWorkspaceContext();
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const block = accessBlock(context);
  const trialNotice = block ? null : trialEndingNotice(context.workspace, context.role);
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
