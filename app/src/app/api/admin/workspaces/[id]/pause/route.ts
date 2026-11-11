import { after, NextResponse } from "next/server";

import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { adminNotFoundResponse, adminOtherMethods, requireOperator } from "@/lib/operator";
import { pauseWorkspace, validatePauseBody } from "@/server/admin/actions";
import { notifyOwnersOfPauseChange } from "@/server/admin/pauseEmail";

type AdminWorkspaceRouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/workspaces/[id]/pause { reason } — operator only. Pauses the
 * workspace and records it; pausing a paused workspace changes nothing. The
 * owners are emailed after the response, so the email never fails the pause.
 * Anyone else gets the plain 404 of a route that does not exist.
 */
export async function POST(request: Request, context: AdminWorkspaceRouteContext) {
  const operator = await requireOperator("change");
  if (operator instanceof NextResponse) return operator;

  const { id } = await context.params;
  const body = await readJsonObject(request);
  if (!body) return invalidJsonBodyResponse();
  const parsed = validatePauseBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const result = await pauseWorkspace({ operator, workspaceId: id, reason: parsed.reason, now: new Date() });
  if (result.status === "not_found") return adminNotFoundResponse();

  if (result.status === "changed") {
    after(() =>
      notifyOwnersOfPauseChange({
        actionId: result.actionId,
        kind: "pause",
        workspaceId: id,
        workspaceName: result.workspaceName,
        reason: parsed.reason,
      }),
    );
  }
  return NextResponse.json({ ok: true, changed: result.status === "changed" });
}

export const GET = adminOtherMethods.GET;
export const PUT = adminOtherMethods.PUT;
export const PATCH = adminOtherMethods.PATCH;
export const DELETE = adminOtherMethods.DELETE;
export const OPTIONS = adminOtherMethods.OPTIONS;
