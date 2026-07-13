import { NextResponse } from "next/server";

import { buildPasswordResetEmail, deliverAccountEmail } from "@/lib/accountEmails";
import { issueAccountToken } from "@/lib/accountToken";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";

/**
 * POST /api/auth/reset-password's sibling — the request half of the password
 * reset flow (scale-readiness spec §A). Anonymous (no session): a user who
 * can't sign in asks for a reset link by email.
 *
 * SEC-1 — NO USER-EXISTENCE ORACLE. The response is byte-identical whether or
 * not an account exists for the address: the ONLY non-200 outcomes are a 400
 * for a malformed email (independent of existence) and a 429 when rate limited.
 * A matched account additionally issues a token and sends an email, but that
 * extra work NEVER changes the status/body — even an issuance/delivery failure
 * is swallowed to a 200 (see the try/catch below). `deliverAccountEmail` is
 * itself fail-safe and returns a boolean we deliberately ignore.
 *
 * DOCUMENTED RESIDUAL: the matched path does strictly more DB work (token
 * issuance) than the unmatched path, so a determined attacker with a precise
 * clock could in principle distinguish the two by TIMING. This is an accepted
 * limitation — a timing side-channel is far weaker than a response oracle, and
 * the per-email (3/15min) + per-ip (10/15min) throttles below bound how much an
 * attacker can probe. The raw token is emailed exactly once, inside a URL
 * FRAGMENT, and only its sha256 hash is ever persisted.
 */

const EMAIL_RATE_LIMIT = { route: "auth/forgot", limit: 3, windowMs: 15 * 60 * 1000 } as const;
const IP_RATE_LIMIT = { route: "auth/forgot-ip", limit: 10, windowMs: 15 * 60 * 1000 } as const;

/** Uniform "rate limited" envelope, byte-identical to the posts pattern. */
function tooManyRequests(retryAfterSeconds: number | undefined) {
  return NextResponse.json(
    { error: "Too many requests. Please slow down.", retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds ?? 1) } },
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const email = (body as { email?: unknown } | null)?.email;

  // Validate BEFORE rate limiting so the per-email throttle key is well-formed.
  // A malformed email reveals nothing about account existence, so returning 400
  // here is not an oracle. Rule byte-matches the register route.
  if (typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  // Rate limits FIRST, before any DB read. Per-email caps how often one address
  // can be targeted; per-ip caps enumeration across many addresses from one host.
  const emailLimit = await checkRateLimit({ userId: `email:${email}`, ...EMAIL_RATE_LIMIT });
  if (!emailLimit.allowed) {
    return tooManyRequests(emailLimit.retryAfterSeconds);
  }

  const ip = (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim() || "unknown";
  const ipLimit = await checkRateLimit({ userId: `ip:${ip}`, ...IP_RATE_LIMIT });
  if (!ipLimit.allowed) {
    return tooManyRequests(ipLimit.retryAfterSeconds);
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true },
    });

    if (user) {
      // Issue a fresh single-use token (invalidating any older unused one) and
      // create it atomically via issueAccountToken's delete+create.
      const rawToken = await prisma.$transaction((tx) =>
        issueAccountToken(tx, user.id, "password_reset"),
      );
      const resetEmail = buildPasswordResetEmail({
        to: user.email,
        rawToken,
        baseUrl: process.env.NEXTAUTH_URL ?? "",
      });
      // Best-effort; the boolean is intentionally not branched on (no oracle).
      await deliverAccountEmail(user.email, resetEmail);
    }
  } catch (error) {
    // Never surface issuance/delivery failures to the caller — doing so would
    // turn a DB/transport error on the matched path into an existence oracle.
    // Log for ops visibility and fall through to the same uniform 200.
    logger.error("[POST /api/auth/forgot-password] issuance/delivery error", { error });
  }

  // Uniform success — identical for matched and unmatched addresses.
  return NextResponse.json({ ok: true }, { status: 200 });
}
