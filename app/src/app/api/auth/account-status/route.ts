import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";

/**
 * GET /api/auth/account-status — the minimal, user-level account facts the
 * client chrome needs to decide whether to nudge the signed-in user to verify
 * their email (scale-readiness spec §A). Reads the USER (getCurrentUser), not
 * workspace context — verification is a property of the person, not the active
 * workspace.
 *
 * SEC-1: the body is exactly two booleans and nothing else — no email, id, or
 * timestamp leaks. `emailVerified` reflects the user's `emailVerifiedAt`;
 * `verificationAvailable` reports whether email is configured (RESEND_API_KEY),
 * so the banner can hide its "Resend" affordance when a resend would only 503.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    emailVerified: user.emailVerifiedAt !== null,
    verificationAvailable: Boolean(process.env.RESEND_API_KEY),
  });
}
