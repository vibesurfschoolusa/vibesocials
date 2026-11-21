import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";

import { buildEmailChangeEmail, deliverAccountEmail } from "@/lib/accountEmails";
import { generateAccountToken } from "@/lib/accountToken";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { emailChangeLockedSentence } from "@/lib/displayDate";
import { isEmailShaped, normalizeEmail } from "@/lib/email";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { tooManyTriesResponse } from "@/lib/tooManyTries";
import { limitUncheckedResponse } from "@/lib/limitUnchecked";
import { accountUndoWindowUntil, addressHeldUntil, clearPassedUndoWindows } from "@/server/auth/undoWindow";
import { signedOutResponse } from "@/lib/signedOutResponse";

/** How long the confirmation link works. */
const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

const RATE_LIMIT = { route: "auth/change-email", limit: 5, windowMs: 60 * 60 * 1000 } as const;

/**
 * POST /api/auth/change-email { newEmail, currentPassword } (R5 new-customer L4)
 *
 * A signed-in person asks to sign in with another address. Nothing changes
 * yet: a link goes to the new address, and following it makes the change
 * (./confirm). The current password is asked so a session left open on
 * another computer can't move the account to someone else's mailbox.
 *
 * No email-existence oracle, like registration: when another account already
 * uses the address the answer is the same 200 and no email is sent. The
 * screen says so ("if no other account uses it").
 *
 * While the previous address can still undo the last change (./undo), a new
 * change is refused, and an address another account's undo may put back
 * counts as taken (R6-security M1, server/auth/undoWindow.ts): either would
 * leave the undo nothing to put back.
 *
 * The limiter fails closed: it guards a password check.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return signedOutResponse();
  }

  const rateLimit = await checkRateLimit({ userId: user.id, ...RATE_LIMIT, failClosed: true });
  if (rateLimit.unavailable) return limitUncheckedResponse();
  // R43 security L3: a fixed window, so the refusal names the wait it has left.
  if (!rateLimit.allowed) return tooManyTriesResponse(rateLimit);

  const body = await readJsonObject(request);
  if (!body) {
    return invalidJsonBodyResponse();
  }
  const { newEmail: rawEmail, currentPassword } = body;

  if (!user.passwordHash) {
    return NextResponse.json(
      {
        // R18 new-customer L2: the sign-in page shows a signed-in person the
        // notice, not its Forgot password link, so the page itself is named.
        error:
          "You sign in with Google, so your sign-in email is your Google account's address. To use another address, set a password at /forgot-password, then change it here.",
      },
      { status: 400 },
    );
  }

  if (typeof rawEmail !== "string" || !isEmailShaped(rawEmail.trim())) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  const newEmail = normalizeEmail(rawEmail);
  if (newEmail === user.email) {
    return NextResponse.json({ error: "That is already your sign-in email." }, { status: 400 });
  }

  if (typeof currentPassword !== "string" || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return NextResponse.json({ error: "Your current password is not correct." }, { status: 400 });
  }

  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json(
      { error: "Vibe Socials can't send email right now, so a new address can't be confirmed. Please try again later." },
      { status: 503 },
    );
  }

  try {
    const now = new Date();
    await clearPassedUndoWindows(prisma, now);
    const lockedUntil = await accountUndoWindowUntil(prisma, user.id, now);
    if (lockedUntil) {
      // `until` lets the form write the date in the viewer's time zone.
      return NextResponse.json(
        { error: emailChangeLockedSentence(lockedUntil), until: lockedUntil.toISOString() },
        { status: 409 },
      );
    }

    const taken =
      (await prisma.user.findUnique({ where: { email: newEmail }, select: { id: true } })) ||
      (await addressHeldUntil(prisma, newEmail, now));
    if (taken) {
      // No email goes out, so none can be accepted: an earlier change to
      // another address is retired here too (R57 new-customer L1, below).
      await prisma.emailChangeRequest.deleteMany({
        where: { userId: user.id, usedAt: null, newEmail: { not: newEmail } },
      });
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const { raw, hash } = generateAccountToken();
    const created = await prisma.emailChangeRequest.create({
      data: {
        userId: user.id,
        newEmail,
        tokenHash: hash,
        expiresAt: new Date(now.getTime() + EMAIL_CHANGE_TTL_MS),
      },
      select: { id: true, createdAt: true },
    });

    // Only the newest link works, as with the other account links. A pending
    // change to another address is retired now, whatever the send's result:
    // that address may be a typo this request corrects, and its link could
    // move the account to a stranger's mailbox (R57 new-customer L1). One to
    // this same address goes to the same mailbox, so it is retired only once
    // this email is accepted (R56 new-customer L1, as lib/accountToken.ts
    // issueAccountToken). Both by createdAt, so two requests at once can't
    // retire each other's.
    let delivered = false;
    try {
      await prisma.emailChangeRequest.deleteMany({
        where: { userId: user.id, usedAt: null, newEmail: { not: newEmail }, createdAt: { lt: created.createdAt } },
      });
      delivered = await deliverAccountEmail(
        newEmail,
        buildEmailChangeEmail({ to: newEmail, rawToken: raw, baseUrl: process.env.NEXTAUTH_URL ?? "" }),
      );
    } finally {
      if (!delivered) {
        await prisma.emailChangeRequest.deleteMany({ where: { id: created.id, usedAt: null } });
      }
    }
    if (delivered) {
      await prisma.emailChangeRequest.deleteMany({
        where: { userId: user.id, usedAt: null, createdAt: { lt: created.createdAt } },
      });
    }
    if (!delivered) {
      return NextResponse.json(
        { error: "We couldn't send the confirmation email just now. Your email is unchanged. Please try again in a few minutes." },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    logger.error("[POST /api/auth/change-email] Unexpected error", { error });
    return NextResponse.json(
      { error: "We couldn't start the change just now. Your email is unchanged. Please try again in a minute." },
      { status: 500 },
    );
  }
}
