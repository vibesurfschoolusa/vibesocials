import { NextResponse } from "next/server";

import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { adminNotFoundResponse, adminOtherMethods, requireOperator } from "@/lib/operator";
import { setBillingExempt, validateExemptBody } from "@/server/admin/actions";

type AdminWorkspaceRouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/workspaces/[id]/exempt { exempt } — operator only (21a).
 * Exempts the workspace from billing, or ends the exemption, and records the
 * old and new values. Anyone else gets the plain 404 of a route that does not exist.
 */
export async function POST(request: Request, context: AdminWorkspaceRouteContext) {
  const operator = await requireOperator("change");
  if (operator instanceof NextResponse) return operator;

  const { id } = await context.params;
  const body = await readJsonObject(request);
  if (!body) return invalidJsonBodyResponse();
  const parsed = validateExemptBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const result = await setBillingExempt({ operator, workspaceId: id, exempt: parsed.exempt });
  if (result.status === "not_found") return adminNotFoundResponse();
  return NextResponse.json({ ok: true, changed: result.status === "changed" });
}

export const GET = adminOtherMethods.GET;
export const PUT = adminOtherMethods.PUT;
export const PATCH = adminOtherMethods.PATCH;
export const DELETE = adminOtherMethods.DELETE;
export const OPTIONS = adminOtherMethods.OPTIONS;
