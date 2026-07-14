import { NextResponse } from "next/server";

import { hashAccountToken } from "@/lib/accountToken";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";

/**
 * POST /api/auth/verify-email — the consume half of the email-verification flow
 * (scale-readiness spec §A). Anonymous: the caller presents the raw token from
 * the emailed link fragment. Structurally mirrors reset-password/route.ts (the
 * conditional-updateMany single-use claim inside a transaction), minus the
 * password write.
 *
 * SEC-1 — NO ORACLE. Every token-validity failure (unknown, wrong type,
 * already-used, expired, or a lost concurrent-use race) returns the exact same
 * 400 body — byte-identical to reset-password — so nothing about the token or
 * any account is revealed. Tokens are matched by sha256 hash; the raw value is
 * never stored.
 *
 * TOCTOU: a cheap fast-path read gives a uniform 400 for obviously-dead tokens
 * without opening a transaction, but the AUTHORITATIVE, atomic single-use claim
 * is the conditional `updateMany` (`usedAt: null`, `expiresAt > now` in the
 * WHERE) INSIDE the transaction — `count === 0` means the token was used/expired
 * in the window, so nothing is written.
 *
 * IDEMPOTENT: an already-verified account (grandfathered, or a second still-valid
 * link) still CONSUMES the token (marks it used, as an audit trail) but is never
 * RE-STAMPED — the original `emailVerifiedAt` is preserved. Either way the
 * outcome is 200 { ok: true }.
 */

const RATE_LIMIT = { route: "auth/verify", limit: 10, windowMs: 15 * 60 * 1000 } as const;

/** Uniform failure for ANY invalid/expired/used/wrong-type token — no oracle.
 *  Deliberately the SAME string reset-password returns. */
const invalidTokenResponse = () =>
  NextResponse.json({ error: "This link is invalid or has expired." }, { status: 400 });

export async function POST(request: Request) {
  // Rate limit FIRST, before any DB work (keyed by ip — the caller is anonymous).
  const ip = (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim() || "unknown";
  const rateLimit = await checkRateLimit({
    userId: `ip:${ip}`,
    ...RATE_LIMIT,
    failClosed: true,
  });
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
  const { token } = (body ?? {}) as { token?: unknown };

  // A missing/empty token is just an invalid token — same uniform 400, no DB hit.
  if (typeof token !== "string" || token.length === 0) {
    return invalidTokenResponse();
  }

  try {
    const now = new Date();
    const tokenHash = hashAccountToken(token);

    // Fast path: cheap uniform 400 for obviously-dead tokens without opening a
    // transaction. Also fetches whether the account is already verified, so the
    // claim below can skip a redundant (re-stamping) user write.
    const record = await prisma.accountToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { emailVerifiedAt: true } } },
    });

    if (!record || record.type !== "email_verify" || record.usedAt || record.expiresAt <= now) {
      return invalidTokenResponse();
    }

    const succeeded = await prisma.$transaction(async (tx) => {
      // Atomic single-use claim + re-validation (TOCTOU guard). Matching
      // nothing (used/expired in the window) mutates nothing.
      const { count } = await tx.accountToken.updateMany({
        where: { tokenHash, type: "email_verify", usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });

      if (count === 0) {
        return false;
      }

      // Idempotent: only stamp the FIRST verification. An already-verified user
      // keeps their original timestamp (the token is still consumed above).
      if (record.user.emailVerifiedAt === null) {
        await tx.user.update({
          where: { id: record.userId },
          data: { emailVerifiedAt: now },
        });
      }

      return true;
    });

    if (!succeeded) {
      return invalidTokenResponse();
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    logger.error("[POST /api/auth/verify-email] Unexpected error", { error });
    return NextResponse.json({ error: "Failed to verify email." }, { status: 500 });
  }
}
