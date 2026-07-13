import { NextResponse } from "next/server";

import { buildVerifyEmail, deliverAccountEmail } from "@/lib/accountEmails";
import { issueAccountToken } from "@/lib/accountToken";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";

/**
 * POST /api/auth/resend-verification — re-send the email-verification link for
 * the CURRENTLY SIGNED-IN user (scale-readiness spec §A). Unlike the anonymous
 * forgot-password request, this is an authenticated, self-service action, so it
 * can be explicit about its failure modes (already-verified, not configured)
 * without leaking any cross-account information — the caller only ever learns
 * facts about their own account.
 *
 * Order: authenticate → throttle (per user id) → reject if already verified →
 * require email to be configured → issue + deliver. Issuance lives INSIDE the
 * RESEND_API_KEY guard, so a deployment with email disabled never mints an
 * un-sendable token (keeps the AccountToken table clean; matches
 * deliverAccountEmail's own env gate).
 */

const RATE_LIMIT = { route: "auth/resend-verify", limit: 3, windowMs: 15 * 60 * 1000 } as const;

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Per-user throttle (this is an authenticated action, so the key is the user
  // id — not an ip). Bounds email-bombing of one's own inbox to 3/15min.
  const rateLimit = await checkRateLimit({ userId: user.id, ...RATE_LIMIT });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
    );
  }

  // Nothing to do — and telling the user so is not an oracle (it's their own
  // account). Checked before the env gate so a verified user gets a clear 400
  // regardless of whether email happens to be configured.
  if (user.emailVerifiedAt) {
    return NextResponse.json({ error: "Your email is already verified." }, { status: 400 });
  }

  // No point issuing a token we can't email. Surface a distinct 503 so the UI
  // can explain the button is unavailable rather than silently succeeding.
  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json({ error: "Email sending is not configured." }, { status: 503 });
  }

  try {
    // Issue a fresh single-use token (invalidating any older unused one)
    // atomically via issueAccountToken's delete+create.
    const rawToken = await prisma.$transaction((tx) => issueAccountToken(tx, user.id, "email_verify"));
    const verifyEmail = buildVerifyEmail({
      to: user.email,
      rawToken,
      baseUrl: process.env.NEXTAUTH_URL ?? "",
    });
    // Best-effort; deliverAccountEmail is fail-safe and never throws. We've
    // already confirmed the key is set, so this attempts a real send.
    await deliverAccountEmail(user.email, verifyEmail);

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    logger.error("[POST /api/auth/resend-verification] issuance/delivery error", { error });
    return NextResponse.json({ error: "Failed to send verification email." }, { status: 500 });
  }
}
