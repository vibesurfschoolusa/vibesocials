import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";

import { buildPasswordChangedEmail, deliverAccountEmail } from "@/lib/accountEmails";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";

/**
 * POST /api/auth/change-password { currentPassword, newPassword }
 *
 * A signed-in user changes their own password. The write bumps
 * User.sessionVersion in the same transaction (as reset-password does), which
 * signs out every session, this one included.
 *
 * The limiter fails closed: it guards a password check, and an unlimited
 * guess rate during a store outage is worse than a 429.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimit = await checkRateLimit({
    userId: user.id,
    route: "auth/change-password",
    limit: 5,
    windowMs: 15 * 60 * 1000,
    failClosed: true,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
    );
  }

  const body = await readJsonObject(request);
  if (!body) {
    return invalidJsonBodyResponse();
  }
  const { currentPassword, newPassword } = body;

  if (!user.passwordHash) {
    return NextResponse.json(
      { error: "You sign in with Google, so this account has no password to change." },
      { status: 400 },
    );
  }

  // Same rule as register and reset-password.
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  }

  if (
    typeof currentPassword !== "string" ||
    !(await bcrypt.compare(currentPassword, user.passwordHash))
  ) {
    return NextResponse.json({ error: "Your current password is not correct." }, { status: 400 });
  }

  if (newPassword === currentPassword) {
    return NextResponse.json(
      { error: "Your new password must be different from your current one." },
      { status: 400 },
    );
  }

  try {
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, sessionVersion: { increment: 1 } },
      });
    });
  } catch (error) {
    logger.error("[POST /api/auth/change-password] Unexpected error", { error });
    return NextResponse.json({ error: "Could not change your password. Try again." }, { status: 500 });
  }

  // Best-effort: deliverAccountEmail logs and returns false on any failure.
  await deliverAccountEmail(
    user.email,
    buildPasswordChangedEmail({ baseUrl: process.env.NEXTAUTH_URL ?? "" }),
  );

  return NextResponse.json({ ok: true }, { status: 200 });
}
