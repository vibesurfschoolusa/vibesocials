import { NextResponse } from "next/server";

import { getWorkspaceContext } from "@/lib/workspace";
import { workspaceBlock } from "@/lib/workspaceStatus";

export const dynamic = "force-dynamic";

/**
 * GET /api/workspaces/status — why the active workspace cannot work, if it
 * cannot (2026-11-10: paused by the operator). The banner on every signed-in
 * page reads it; the message is the one the refusing routes answer with. Read
 * fresh on every call (no-store), so a pause or resume shows on the next page.
 */
export async function GET() {
  const context = await getWorkspaceContext();
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const block = workspaceBlock(context.workspace);
  return NextResponse.json(
    { blockedMessage: block?.message ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
