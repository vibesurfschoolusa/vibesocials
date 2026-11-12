import { NextResponse } from "next/server";

import { BILLING_INTERVALS, paymentsConfigured, type BillingInterval } from "@/lib/billing";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { adminNotFoundResponse, adminOtherMethods } from "@/lib/operator";
import { isPlanKey } from "@/lib/plans";
import { checkRateLimit } from "@/lib/rateLimit";
import { requireOwnerContext } from "@/lib/workspace";
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
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Wait a few minutes and try again.", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 60) } },
    );
  }

  const body = await readJsonObject(request);
  if (!body) return invalidJsonBodyResponse();
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
