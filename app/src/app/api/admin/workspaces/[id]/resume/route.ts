import { after, NextResponse } from "next/server";

import { adminNotFoundResponse, adminOtherMethods, requireOperator } from "@/lib/operator";
import { resumeWorkspace } from "@/server/admin/actions";
import { notifyOwnersOfPauseChange } from "@/server/admin/pauseEmail";

type AdminWorkspaceRouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/workspaces/[id]/resume — operator only. Resumes a paused
 * workspace and records it; resuming one that is not paused changes nothing.
 * Posts failed while paused stay failed until someone retries them. The owners
 * are emailed after the response. Anyone else gets the plain 404.
 */
export async function POST(_request: Request, context: AdminWorkspaceRouteContext) {
  const operator = await requireOperator("change");
  if (operator instanceof NextResponse) return operator;

  const { id } = await context.params;
  const result = await resumeWorkspace({ operator, workspaceId: id });
  if (result.status === "not_found") return adminNotFoundResponse();

  if (result.status === "changed") {
    after(() =>
      notifyOwnersOfPauseChange({
        actionId: result.actionId,
        kind: "resume",
        workspaceId: id,
        workspaceName: result.workspaceName,
        reason: null,
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
