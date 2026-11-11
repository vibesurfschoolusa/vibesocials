import { NextResponse } from "next/server";

import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { adminNotFoundResponse, adminOtherMethods, requireOperator } from "@/lib/operator";
import { startTrial, validateTrialBody } from "@/server/admin/actions";

type AdminWorkspaceRouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/workspaces/[id]/trial { trialEndsAt: "YYYY-MM-DD" } —
 * operator only (21a). "Set the trial's end": ends the exemption and sets the
 * trial to run to the end of that UTC day, from tomorrow (UTC) to 90 days
 * ahead, and records it. Ending a trial now is POST .../end-trial. Anyone else
 * gets the plain 404 of a route that does not exist.
 */
export async function POST(request: Request, context: AdminWorkspaceRouteContext) {
  const operator = await requireOperator("change");
  if (operator instanceof NextResponse) return operator;

  const { id } = await context.params;
  const body = await readJsonObject(request);
  if (!body) return invalidJsonBodyResponse();
  const parsed = validateTrialBody(body, new Date());
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const result = await startTrial({ operator, workspaceId: id, trialEndsAt: parsed.trialEndsAt });
  if (result.status === "not_found") return adminNotFoundResponse();
  return NextResponse.json({ ok: true, changed: result.status === "changed" });
}

export const GET = adminOtherMethods.GET;
export const PUT = adminOtherMethods.PUT;
export const PATCH = adminOtherMethods.PATCH;
export const DELETE = adminOtherMethods.DELETE;
export const OPTIONS = adminOtherMethods.OPTIONS;
