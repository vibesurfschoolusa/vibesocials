import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";

import { hashAccountToken } from "@/lib/accountToken";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";

/**
 * POST /api/auth/reset-password — the consume half of the password reset flow
 * (scale-readiness spec §A). Anonymous: the caller presents the raw token from
 * the emailed link fragment plus a new password.
 *
 * SEC-1 — NO ORACLE. Every token-validity failure (unknown, wrong type,
 * already-used, expired, or lost a concurrent-use race) returns the exact same
 * 400 body; the two DIFFERENT responses (429 rate limited, 400 password rule)
 * are independent of any token/user and so leak nothing. Tokens are matched by
 * sha256 hash — the raw value is never stored.
 *
 * TOCTOU: a cheap fast-path read gives a uniform 400 for obviously-dead tokens
 * without opening a transaction, but the AUTHORITATIVE, atomic single-use claim
 * is the conditional `updateMany` (`usedAt: null`, `expiresAt > now` in the
 * WHERE) INSIDE the transaction — `count === 0` means the token was used/expired
 * in the window, so nothing is written (mirrors invites/[token]/accept). The
 * token mark, password write, and sibling-token cleanup are ONE transaction.
 *
 * ACCEPTED DEBT: this does not revoke outstanding next-auth v4 JWT sessions —
 * they are stateless and self-expire (30-day maxAge). A reset changes the
 * password (blocking new logins with the old one) but any already-issued
 * session cookie remains valid until it expires. Server-side session
 * revocation is out of scope for this task.
 */

const RATE_LIMIT = { route: "auth/reset", limit: 10, windowMs: 15 * 60 * 1000 } as const;

/** Uniform failure for ANY invalid/expired/used/wrong-type token — no oracle. */
const invalidResetResponse = () =>
  NextResponse.json({ error: "This link is invalid or has expired." }, { status: 400 });

export async function POST(request: Request) {
  // Rate limit FIRST, before any DB work (keyed by ip — the caller is anonymous).
  const ip = (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim() || "unknown";
  const rateLimit = await checkRateLimit({ userId: `ip:${ip}`, ...RATE_LIMIT });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const { token, password } = (body ?? {}) as { token?: unknown; password?: unknown };

  // New-password rule byte-matches the register route (SEC-1: reveals nothing
  // about the token — it's purely about the submitted password).
  if (typeof password !== "string" || password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters." },
      { status: 400 },
    );
  }

  // A missing/empty token is just an invalid token — same uniform 400, no DB hit.
  if (typeof token !== "string" || token.length === 0) {
    return invalidResetResponse();
  }

  try {
    const now = new Date();
    const tokenHash = hashAccountToken(token);

    // Fast path: cheap uniform 400 for obviously-dead tokens without opening a
    // transaction. Also fetches whether the account is already verified, so the
    // reset can double as email verification only when needed.
    const record = await prisma.accountToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { emailVerifiedAt: true } } },
    });

    if (!record || record.type !== "password_reset" || record.usedAt || record.expiresAt <= now) {
      return invalidResetResponse();
    }

    const succeeded = await prisma.$transaction(async (tx) => {
      // Atomic single-use claim + re-validation (TOCTOU guard). Matching
      // nothing (used/expired in the window) mutates nothing.
      const { count } = await tx.accountToken.updateMany({
        where: { tokenHash, type: "password_reset", usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });

      if (count === 0) {
        return false;
      }

      // Hashing only AFTER the token is claimed, so an invalid/raced token
      // never costs a bcrypt. The op is rare, so the short-lived transaction
      // held during hashing is fine.
      const passwordHash = await bcrypt.hash(password, 10);

      await tx.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          // Receiving the reset link proves control of the address, so verify
          // it too — but only if it wasn't already verified (never re-stamp).
          ...(record.user.emailVerifiedAt === null ? { emailVerifiedAt: now } : {}),
        },
      });

      // Invalidate any OTHER still-unused reset token for this user (the one
      // just claimed keeps its usedAt as an audit trail and is left in place).
      await tx.accountToken.deleteMany({
        where: { userId: record.userId, type: "password_reset", usedAt: null },
      });

      return true;
    });

    if (!succeeded) {
      return invalidResetResponse();
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    logger.error("[POST /api/auth/reset-password] Unexpected error", { error });
    return NextResponse.json({ error: "Failed to reset password." }, { status: 500 });
  }
}
