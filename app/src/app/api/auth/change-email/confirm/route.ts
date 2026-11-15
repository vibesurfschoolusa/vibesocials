import { NextResponse } from "next/server";

import { buildEmailChangedNoticeEmail, deliverAccountEmail } from "@/lib/accountEmails";
import { hashAccountToken } from "@/lib/accountToken";
import { prisma } from "@/lib/db";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";

const RATE_LIMIT = { route: "auth/change-email-confirm", limit: 10, windowMs: 15 * 60 * 1000 } as const;

const deadLinkResponse = () =>
  NextResponse.json(
    {
      error:
        "This link has expired or was already used. Your email is unchanged. To change it, ask again in Settings, Account.",
    },
    { status: 400 },
  );

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
 * did not make.
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
  try {
    const record = await prisma.emailChangeRequest.findUnique({
      where: { tokenHash },
      include: { user: { select: { email: true } } },
    });
    if (!record || record.usedAt || record.expiresAt <= now) {
      return deadLinkResponse();
    }

    const changed = await prisma.$transaction(async (tx) => {
      const { count } = await tx.emailChangeRequest.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (count === 0) return false;
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
      return true;
    });
    if (!changed) {
      return deadLinkResponse();
    }

    // Best-effort: deliverAccountEmail logs and returns false on any failure.
    await deliverAccountEmail(record.user.email, buildEmailChangedNoticeEmail({ newEmail: record.newEmail }));

    return NextResponse.json({ ok: true, email: record.newEmail }, { status: 200 });
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
