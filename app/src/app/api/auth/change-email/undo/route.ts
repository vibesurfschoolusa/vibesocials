import { after, NextResponse } from "next/server";

import { buildPasswordResetEmail, deliverAccountEmail } from "@/lib/accountEmails";
import { hashAccountToken, issueAccountToken } from "@/lib/accountToken";
import { prisma } from "@/lib/db";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { tooManyTriesResponse } from "@/lib/tooManyTries";
import { SUPPORT_EMAIL } from "@/lib/siteInfo";
import { followEmailChangeInStripe } from "@/server/billing/customerEmail";

const RATE_LIMIT = { route: "auth/change-email-undo", limit: 10, windowMs: 15 * 60 * 1000 } as const;

const refuse = (status: number, error: string) => NextResponse.json({ error }, { status });
/** `reason`: the page titles it "This link can't be used", not "wasn't undone". */
const refuseNotValid = () => NextResponse.json({ error: NOT_VALID, reason: "not_valid" }, { status: 400 });

// R6-pages L6: a link's record is cleared once its 72 hours have passed
// (server/auth/undoWindow.ts), so a link not found may be an expired one.
// R29 OO1 (security L2): or one already used, so it claims neither.
const NOT_VALID = `This link has expired or was already used: undo links work for 72 hours. If you already undid the change, sign in with your old address (reset your password if it doesn't work). If not, write to ${SUPPORT_EMAIL} and we'll help you get the account back.`;
// R29 OO1 (security L1): the undo cleared the password, so say how to get back
// in. Not that a reset link went: that email may have failed. R30 pages L4:
// nor that the password stopped working: one may have been set since.
const USED =
  "This link was already used, so the change was undone. If you haven't set a new password since, use Reset your password.";
const EXPIRED = `This link has expired: it worked for 72 hours. Write to ${SUPPORT_EMAIL} and we'll help you get the account back.`;
// R7-new-customer H1: no link is sent for such a change; this is the backstop.
const UNCONFIRMED = `This change can't be undone with a link, because the address it replaced was never confirmed. If this is your account, write to ${SUPPORT_EMAIL}.`;
const CHANGED_AGAIN = `The sign-in email has changed again since this email was sent, so this link can't undo it. Write to ${SUPPORT_EMAIL} and we'll help you get the account back.`;

/** `used`: the page titles a used link "already used", not "wasn't undone" (R28 NN2). */
const refuseUsed = () => NextResponse.json({ error: USED, used: true }, { status: 400 });

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
 *
 * R6-security M1: while the window is open no other change can be made and
 * no other account can take the previous address (server/auth/undoWindow.ts),
 * so the "changed again" and "address taken" refusals below are backstops.
 */
export async function POST(request: Request) {
  const ip = (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim() || "unknown";
  const rateLimit = await checkRateLimit({ userId: `ip:${ip}`, ...RATE_LIMIT, failClosed: true });
  // R43 security L3: a fixed window, so the refusal names the wait it has left.
  if (!rateLimit.allowed) return tooManyTriesResponse(rateLimit);

  const body = await readJsonObject(request);
  if (!body) {
    return invalidJsonBodyResponse();
  }
  const { token } = body;
  if (typeof token !== "string" || token.length === 0) {
    return refuseNotValid();
  }

  const undoTokenHash = hashAccountToken(token);
  const now = new Date();
  try {
    const record = await prisma.emailChangeRequest.findUnique({
      where: { undoTokenHash },
      include: { user: { select: { email: true } } },
    });
    if (record?.previousEmailUnverified) return refuse(400, UNCONFIRMED);
    if (!record || !record.previousEmail || !record.undoExpiresAt) return refuseNotValid();
    if (record.undoneAt) return refuseUsed();
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
    if (!resetToken) return refuseUsed();

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
