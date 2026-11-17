import { NextResponse } from "next/server";

import { BILLING_INTERVALS, paymentsConfigured, type BillingInterval } from "@/lib/billing";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { adminNotFoundResponse, adminOtherMethods } from "@/lib/operator";
import { isPlanKey } from "@/lib/plans";
import { checkRateLimit } from "@/lib/rateLimit";
import { tooManyTriesResponse } from "@/lib/tooManyTries";
import { limitUncheckedResponse } from "@/lib/limitUnchecked";
import { requireOwnerContext } from "@/lib/workspace";
import { renderedWorkspaceRefusal } from "@/lib/workspaceChanged";
import { startCheckout } from "@/server/billing/checkout";

export const dynamic = "force-dynamic";

/**
 * POST /api/billing/checkout { plan, interval? } (21b; interval P1: "month"
 * or "year", monthly when absent so older pages still work). Owner only, for the active
 * workspace. Answers { url } of a Stripe Checkout page for the plan; the
 * page sends the browser there. Writes no plan column: the webhook does.
 * With payments not configured: the app's JSON 404, before anything is read.
 */
export async function POST(request: Request) {
  if (!paymentsConfigured()) return adminNotFoundResponse();

  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) return contextOrError;
  const context = contextOrError;

  // Fails closed: each request can create objects at Stripe.
  const rateLimit = await checkRateLimit({
    userId: context.user.id,
    route: "billing/checkout",
    limit: 10,
    windowMs: 60 * 60 * 1000,
    failClosed: true,
  });
  if (rateLimit.unavailable) return limitUncheckedResponse();
  // R43 security L1: the limit is an hour, so the refusal names the real wait.
  if (!rateLimit.allowed) return tooManyTriesResponse(rateLimit);

  const body = await readJsonObject(request);
  if (!body) return invalidJsonBodyResponse();
  // F3: the workspace the Plan section was rendered for; the active one is a
  // cookie every tab shares, so a stale tab must not buy a plan for another.
  const refusal = renderedWorkspaceRefusal(body.workspaceId, context.workspace.id);
  if (refusal) return refusal;
  if (typeof body.plan !== "string" || !isPlanKey(body.plan)) {
    return NextResponse.json({ error: "Choose Starter, Growth or Pro." }, { status: 400 });
  }
  const interval = body.interval ?? "month";
  if (typeof interval !== "string" || !(BILLING_INTERVALS as readonly string[]).includes(interval)) {
    return NextResponse.json({ error: "Choose monthly or yearly." }, { status: 400 });
  }

  const result = await startCheckout({
    workspaceId: context.workspace.id,
    ownerEmail: context.user.email,
    ownerUserId: context.user.id,
    plan: body.plan,
    // Absent: startCheckout's monthly default, so the call is today's.
    ...(body.interval === undefined ? {} : { interval: interval as BillingInterval }),
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
