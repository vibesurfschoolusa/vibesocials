import { NextResponse } from "next/server";

import { paymentsConfigured } from "@/lib/billing";
import { adminNotFoundResponse, adminOtherMethods } from "@/lib/operator";
import { verifyStripeSignature } from "@/server/billing/stripeSignature";
import { handleStripeEvent } from "@/server/billing/stripeWebhook";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/stripe (21b). Public: Stripe calls it with no session,
 * and the proxy lets every /api path through to the route's own checks.
 *
 * With payments not configured it answers the app's JSON 404, like any
 * unknown path. Otherwise the body is read as text before anything parses
 * it, because the signature covers those exact bytes; a bad or missing
 * signature answers 400 and nothing else happens. A verified event goes to
 * handleStripeEvent, whose status is answered as is (500 makes Stripe retry).
 */
export async function POST(request: Request) {
  if (!paymentsConfigured()) return adminNotFoundResponse();

  const rawBody = await request.text();
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  if (!verifyStripeSignature(rawBody, request.headers.get("stripe-signature"), secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const status = await handleStripeEvent(event);
  if (status === 200) return NextResponse.json({ received: true });
  return NextResponse.json({ error: status === 400 ? "Invalid event" : "Not handled; send it again" }, { status });
}

export const { GET, PUT, PATCH, DELETE, OPTIONS } = adminOtherMethods;
