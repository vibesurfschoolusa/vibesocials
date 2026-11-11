import { NextResponse } from "next/server";

import { stripeReachable } from "@/lib/billing";
import { adminNotFoundResponse, adminOtherMethods } from "@/lib/operator";
import { checkRateLimit } from "@/lib/rateLimit";
import { requireOwnerContext } from "@/lib/workspace";
import { openPortal } from "@/server/billing/checkout";

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

  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) return contextOrError;
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
