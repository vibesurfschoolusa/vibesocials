import { NextResponse } from "next/server";

import { adminNotFoundResponse, adminOtherMethods, requireOperator } from "@/lib/operator";
import { exemptWorkspace } from "@/server/admin/actions";

type AdminWorkspaceRouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/workspaces/[id]/exempt — operator only (21a). "Exempt this
 * workspace": sets billingExempt and records it; nothing else changes. Ending
 * an exemption is starting a trial (POST .../trial). Anyone else gets the
 * plain 404 of a route that does not exist.
 */
export async function POST(_request: Request, context: AdminWorkspaceRouteContext) {
  const operator = await requireOperator("change");
  if (operator instanceof NextResponse) return operator;

  const { id } = await context.params;
  const result = await exemptWorkspace({ operator, workspaceId: id });
  if (result.status === "not_found") return adminNotFoundResponse();
  return NextResponse.json({ ok: true, changed: result.status === "changed" });
}

export const GET = adminOtherMethods.GET;
export const PUT = adminOtherMethods.PUT;
export const PATCH = adminOtherMethods.PATCH;
export const DELETE = adminOtherMethods.DELETE;
export const OPTIONS = adminOtherMethods.OPTIONS;
