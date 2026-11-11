import { NextResponse } from "next/server";

import { adminNotFoundResponse, adminOtherMethods, requireOperator } from "@/lib/operator";
import { endTrialNow } from "@/server/admin/actions";

type AdminWorkspaceRouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/workspaces/[id]/end-trial — operator only (21a). "End the
 * trial now": ends any exemption and sets the trial to end at this instant,
 * and records it. A trial already over changes nothing. Anyone else gets the
 * plain 404 of a route that does not exist.
 */
export async function POST(_request: Request, context: AdminWorkspaceRouteContext) {
  const operator = await requireOperator("change");
  if (operator instanceof NextResponse) return operator;

  const { id } = await context.params;
  const result = await endTrialNow({ operator, workspaceId: id, now: new Date() });
  if (result.status === "not_found") return adminNotFoundResponse();
  return NextResponse.json({ ok: true, changed: result.status === "changed" });
}

export const GET = adminOtherMethods.GET;
export const PUT = adminOtherMethods.PUT;
export const PATCH = adminOtherMethods.PATCH;
export const DELETE = adminOtherMethods.DELETE;
export const OPTIONS = adminOtherMethods.OPTIONS;
