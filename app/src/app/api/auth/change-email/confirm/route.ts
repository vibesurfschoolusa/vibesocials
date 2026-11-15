import { after, NextResponse } from "next/server";

import { buildEmailChangedNoticeEmail, deliverAccountEmail } from "@/lib/accountEmails";
import { generateAccountToken, hashAccountToken } from "@/lib/accountToken";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { emailChangeLockedSentence, formatDisplayDate } from "@/lib/displayDate";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { accountUndoWindowUntil, addressHeldUntil } from "@/server/auth/undoWindow";
import { followEmailChangeInStripe } from "@/server/billing/customerEmail";

/**
 * How long the old mailbox's "This wasn't me: undo" link works: long enough
 * to notice the email over a weekend, short enough that a lost or hacked old
 * mailbox can't take the account back for long. There is no way to turn it
 * off: whoever changed the email knows the password, so a switch would only
 * help a hijacker.
 */
const UNDO_TTL_MS = 72 * 60 * 60 * 1000;

const RATE_LIMIT = { route: "auth/change-email-confirm", limit: 10, windowMs: 15 * 60 * 1000 } as const;

const deadLinkResponse = () =>
  NextResponse.json(
    {
      error:
        "This link has expired or was already used. Your email is unchanged. To change it, ask again in Settings, Account.",
    },
    { status: 400 },
  );

// R6-pages L1: about the link, since whoever opens it again most likely just used it.
const usedLinkResponse = () =>
  NextResponse.json(
    { error: "This link was already used. If you just confirmed it, your email has changed.", used: true },
    { status: 400 },
  );

type Outcome = { kind: "changed" } | { kind: "used" } | { kind: "locked"; until: Date } | { kind: "held"; until: Date };

/**
 * POST /api/auth/change-email/confirm { token } (R5 new-customer L4)
 *
 * The link sent to the new address lands on /verify-email/new-address, which
 * posts its token here. Anonymous: the link may be opened in another browser.
 * The token is single-use, claimed atomically like the verify and reset links.
 *
 * The change is handled like a password change: every session is signed out
 * (sessionVersion), and unused reset and verify links, which went to the old
 * mailbox, stop working. Following the link proves the new mailbox, so the
 * email counts as verified. A Google link was made by the old address, so it
 * is cleared. The old address is told, so its owner learns of a change they
 * did not make, with a one-use undo link (./undo) that works for 72 hours.
 *
 * The page posts here only when the person presses its button, never on
 * load, so a mail scanner opening the link changes nothing. `viewer` says
 * whether this browser is signed in to the account that changed (the page
 * then signs it out), to another account (left signed in, and told only that
 * the change was made), or to none.
 *
 * R6-security M1: nothing may leave an open undo window (./undo) without an
 * address to put back. So the change is refused while this account's last
 * change can still be undone (the request route refuses that too; this
 * covers a link asked for before it), and when the new address is another
 * account's previous one that its undo may still restore. Both are read in
 * the transaction that makes the change.
 */
export async function POST(request: Request) {
  const ip = (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim() || "unknown";
  const rateLimit = await checkRateLimit({ userId: `ip:${ip}`, ...RATE_LIMIT, failClosed: true });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "This network has tried too many links in the last few minutes. Wait 15 minutes, then reload this page.",
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
    return deadLinkResponse();
  }

  const tokenHash = hashAccountToken(token);
  const now = new Date();
  const undo = generateAccountToken();
  try {
    const caller = await getCurrentUser();
    const record = await prisma.emailChangeRequest.findUnique({
      where: { tokenHash },
      include: { user: { select: { email: true } } },
    });
    if (record?.usedAt) {
      return usedLinkResponse();
    }
    if (!record || record.expiresAt <= now) {
      return deadLinkResponse();
    }

    const outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
      const lockedUntil = await accountUndoWindowUntil(tx, record.userId, now);
      if (lockedUntil) return { kind: "locked", until: lockedUntil };
      const heldUntil = await addressHeldUntil(tx, record.newEmail, now);
      if (heldUntil) return { kind: "held", until: heldUntil };

      const { count } = await tx.emailChangeRequest.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
        data: {
          usedAt: now,
          previousEmail: record.user.email,
          undoTokenHash: undo.hash,
          undoExpiresAt: new Date(now.getTime() + UNDO_TTL_MS),
        },
      });
      // The same `now` as the read above, so the link can't have expired
      // since: it was used in the meantime.
      if (count === 0) return { kind: "used" };
      await tx.user.update({
        where: { id: record.userId },
        data: {
          email: record.newEmail,
          emailVerifiedAt: now,
          googleLinkedAt: null,
          sessionVersion: { increment: 1 },
        },
      });
      await tx.accountToken.deleteMany({ where: { userId: record.userId, usedAt: null } });
      await tx.emailChangeRequest.deleteMany({ where: { userId: record.userId, usedAt: null } });
      return { kind: "changed" };
    });
    if (outcome.kind === "used") {
      return usedLinkResponse();
    }
    if (outcome.kind === "locked") {
      return NextResponse.json(
        { error: emailChangeLockedSentence(outcome.until), until: outcome.until.toISOString() },
        { status: 409 },
      );
    }
    if (outcome.kind === "held") {
      return NextResponse.json(
        {
          error: `This address was another Vibe Socials account's sign-in email until recently, and that account can take it back until ${formatDisplayDate(outcome.until)}, so your email is unchanged. After that, ask for the change again in Settings, Account.`,
        },
        { status: 409 },
      );
    }

    // Best-effort: deliverAccountEmail logs and returns false on any failure.
    await deliverAccountEmail(
      record.user.email,
      buildEmailChangedNoticeEmail({
        newEmail: record.newEmail,
        rawUndoToken: undo.raw,
        baseUrl: process.env.NEXTAUTH_URL ?? "",
      }),
    );
    // After the answer is sent, never on its path: Stripe can be slow or
    // down, and the change is already made. It logs and never throws; the
    // catch is for a surprise.
    const change = { userId: record.userId, from: record.user.email, to: record.newEmail };
    after(() =>
      followEmailChangeInStripe(change).catch((error: unknown) =>
        logger.error("[POST /api/auth/change-email/confirm] Stripe follow-up failed", { error }),
      ),
    );

    if (caller && caller.id !== record.userId) {
      return NextResponse.json({ ok: true, viewer: "other_account" }, { status: 200 });
    }
    return NextResponse.json(
      { ok: true, viewer: caller ? "this_account" : "signed_out", email: record.newEmail },
      { status: 200 },
    );
  } catch (error) {
    // User.email is unique: another account registered the address after the
    // link was sent. The transaction rolled back, so the link still works.
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "P2002") {
      return NextResponse.json(
        { error: "Another Vibe Socials account now signs in with this address, so your email is unchanged." },
        { status: 409 },
      );
    }
    logger.error("[POST /api/auth/change-email/confirm] Unexpected error", { error });
    return NextResponse.json(
      { error: "Something went wrong on our side. Your email is unchanged, and this link still works. Please try again in a minute." },
      { status: 500 },
    );
  }
}
