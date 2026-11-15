import { after, NextResponse } from "next/server";

import { buildPasswordResetEmail, deliverAccountEmail } from "@/lib/accountEmails";
import { hashAccountToken, issueAccountToken } from "@/lib/accountToken";
import { prisma } from "@/lib/db";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { SUPPORT_EMAIL } from "@/lib/siteInfo";
import { followEmailChangeInStripe } from "@/server/billing/customerEmail";

const RATE_LIMIT = { route: "auth/change-email-undo", limit: 10, windowMs: 15 * 60 * 1000 } as const;

const refuse = (status: number, error: string) => NextResponse.json({ error }, { status });

const NOT_VALID = `This link isn't valid. Open the link from the email again, or write to ${SUPPORT_EMAIL} and we'll help you get the account back.`;
const USED = `This link was already used, so the change was already undone. If you still can't sign in, write to ${SUPPORT_EMAIL}.`;
const EXPIRED = `This link has expired: it worked for 72 hours. Write to ${SUPPORT_EMAIL} and we'll help you get the account back.`;
const CHANGED_AGAIN = `The sign-in email has changed again since this email was sent, so this link can't undo it. Write to ${SUPPORT_EMAIL} and we'll help you get the account back.`;

/** Thrown inside the transaction so the claim rolls back with it. */
class ChangedAgain extends Error {}

/**
 * POST /api/auth/change-email/undo { token } (R5 new-customer L4, review)
 *
 * The "This wasn't me: undo" link in the notice sent to the old address
 * (lib/accountEmails.ts buildEmailChangedNoticeEmail) lands on
 * /verify-email/undo, which posts here when the person presses its button.
 * It puts the previous address back, once, within 72 hours, and only while the
 * account still signs in with the address that change set: after a later
 * change it would hand the account to an address its owner has since left.
 * Whoever made the change knows the password, so the undo locks them out in
 * the same write: the password is cleared, every session ends
 * (sessionVersion), and unused account links and pending changes are
 * dropped. A fresh password-reset link then goes to the restored address, the
 * only way back in besides Google sign-in, which links an account without a
 * password only for a Google account on that same address
 * (lib/googleSso.ts). Anonymous and rate limited by network, like the other
 * account links.
 */
export async function POST(request: Request) {
  const ip = (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim() || "unknown";
  const rateLimit = await checkRateLimit({ userId: `ip:${ip}`, ...RATE_LIMIT, failClosed: true });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "This network has tried too many links in the last few minutes. Wait 15 minutes, then try again.",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 60) } },
    );
  }

  const body = await readJsonObject(request);
  if (!body) {
    return invalidJsonBodyResponse();
  }
  const { token } = body;
  if (typeof token !== "string" || token.length === 0) {
    return refuse(400, NOT_VALID);
  }

  const undoTokenHash = hashAccountToken(token);
  const now = new Date();
  try {
    const record = await prisma.emailChangeRequest.findUnique({
      where: { undoTokenHash },
      include: { user: { select: { email: true } } },
    });
    if (!record || !record.previousEmail || !record.undoExpiresAt) return refuse(400, NOT_VALID);
    if (record.undoneAt) return refuse(400, USED);
    if (record.undoExpiresAt <= now) return refuse(400, EXPIRED);
    if (record.user.email !== record.newEmail) return refuse(409, CHANGED_AGAIN);
    const previousEmail = record.previousEmail;

    const resetToken = await prisma.$transaction(async (tx) => {
      const { count } = await tx.emailChangeRequest.updateMany({
        where: { undoTokenHash, undoneAt: null, undoExpiresAt: { gt: now } },
        data: { undoneAt: now },
      });
      if (count === 0) return null;
      // Guarded on the address this change set, against a change made
      // between the read above and now.
      const restored = await tx.user.updateMany({
        where: { id: record.userId, email: record.newEmail },
        data: {
          email: previousEmail,
          emailVerifiedAt: now,
          passwordHash: null,
          googleLinkedAt: null,
          sessionVersion: { increment: 1 },
        },
      });
      if (restored.count === 0) throw new ChangedAgain();
      await tx.accountToken.deleteMany({ where: { userId: record.userId, usedAt: null } });
      await tx.emailChangeRequest.deleteMany({ where: { userId: record.userId, usedAt: null } });
      return issueAccountToken(tx, record.userId, "password_reset", now);
    });
    if (!resetToken) return refuse(400, USED);

    // deliverAccountEmail logs and returns false on any failure; the page
    // then points to Forgot password instead.
    const resetSent = await deliverAccountEmail(
      previousEmail,
      buildPasswordResetEmail({ to: previousEmail, rawToken: resetToken, baseUrl: process.env.NEXTAUTH_URL ?? "" }),
    );

    // After the answer is sent: Stripe can be slow, and the undo is made.
    const { userId, newEmail } = record;
    after(() =>
      followEmailChangeInStripe({ userId, from: newEmail, to: previousEmail }).catch((error: unknown) =>
        logger.error("[POST /api/auth/change-email/undo] Stripe follow-up failed", { error }),
      ),
    );

    return NextResponse.json({ ok: true, email: previousEmail, resetSent }, { status: 200 });
  } catch (error) {
    if (error instanceof ChangedAgain) return refuse(409, CHANGED_AGAIN);
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "P2002") {
      return refuse(
        409,
        `Another Vibe Socials account now signs in with your previous address, so it can't be put back. Write to ${SUPPORT_EMAIL} and we'll help you get the account back.`,
      );
    }
    logger.error("[POST /api/auth/change-email/undo] Unexpected error", { error });
    return refuse(
      500,
      "Something went wrong on our side, and nothing was changed. This link still works: please try again in a minute.",
    );
  }
}
