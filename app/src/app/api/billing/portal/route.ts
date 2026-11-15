import { NextResponse } from "next/server";

import { stripeReachable } from "@/lib/billing";
import { adminNotFoundResponse, adminOtherMethods } from "@/lib/operator";
import { readJsonObject } from "@/lib/http";
import { checkRateLimit } from "@/lib/rateLimit";
import { getWorkspaceContext, requireOwnerContext } from "@/lib/workspace";
import { renderedWorkspaceRefusal } from "@/lib/workspaceChanged";
import { openPortal } from "@/server/billing/checkout";
import { isWorkspacePayer } from "@/server/billing/payerRefusal";

export const dynamic = "force-dynamic";

/**
 * POST /api/billing/portal (21b). Owner only. Answers { url } of the Stripe
 * customer portal for the active workspace's customer, where the owner
 * changes plan or card, cancels and reads invoices; refused when the
 * workspace has no customer. Needs only the Stripe secret key, so an owner
 * can still cancel while BILLING_ENABLED is off (fix round 1); without the
 * key: the JSON 404.
 */
export async function POST(request: Request) {
  if (!stripeReachable()) return adminNotFoundResponse();

  let contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    // Review of R5-security L2: the person whose card pays may manage it (and
    // cancel) after being made a member, so leaving has a way out.
    if (contextOrError.status !== 403) return contextOrError;
    const member = await getWorkspaceContext();
    if (!member || !(await isWorkspacePayer(member.workspace.id, member.user.id))) return contextOrError;
    contextOrError = member;
  }
  const context = contextOrError;

  const rateLimit = await checkRateLimit({
    userId: context.user.id,
    route: "billing/portal",
    limit: 10,
    windowMs: 60 * 60 * 1000,
    failClosed: true,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Wait a few minutes and try again.", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 60) } },
    );
  }

  // F3: the workspace the Plan section was rendered for (one cookie for every tab).
  const refusal = renderedWorkspaceRefusal((await readJsonObject(request))?.workspaceId, context.workspace.id);
  if (refusal) return refusal;

  const result = await openPortal({
    workspaceId: context.workspace.id,
    now: new Date(),
    baseUrl: process.env.NEXTAUTH_URL || new URL(request.url).origin,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ url: result.url });
}

// Every other method answers the same 404, so the path never shows it exists.
export const GET = adminOtherMethods.GET;
export const PUT = adminOtherMethods.PUT;
export const PATCH = adminOtherMethods.PATCH;
export const DELETE = adminOtherMethods.DELETE;
export const OPTIONS = adminOtherMethods.OPTIONS;
