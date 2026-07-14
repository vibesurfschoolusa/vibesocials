import crypto from "crypto";

import type { AccountTokenType, PrismaClient } from "@prisma/client";

/**
 * Account lifecycle (scale-readiness spec §A). Short-lived, single-use tokens
 * for password reset and email verification. Storage model mirrors
 * `inviteToken.ts` (deliberately duplicated, NOT sharing an abstraction): a raw
 * 43-character base64url token (32 random bytes — base64url-without-padding of
 * 32 bytes is always 43 chars) is emailed to the user exactly once, inside a
 * URL FRAGMENT. Only its SHA-256 hex digest is persisted (`AccountToken.tokenHash`)
 * — the raw value is never stored or logged, so a database read can never
 * reveal a live token.
 */

/** Password-reset token lifetime: 60 minutes. Short by design (SEC-1). */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/** Email-verification token lifetime: 7 days (matches invite-link generosity). */
export const EMAIL_VERIFY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Exhaustive over AccountTokenType, so adding a third token kind forces a TTL
// decision here at compile time rather than silently defaulting.
const TTL_MS_BY_TYPE: Record<AccountTokenType, number> = {
  password_reset: PASSWORD_RESET_TTL_MS,
  email_verify: EMAIL_VERIFY_TTL_MS,
};

/** SHA-256 hex digest of a raw account token — the only form ever persisted. */
export function hashAccountToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Generates a new account-token pair: `raw` (returned to the caller exactly
 * once, for building the emailed link fragment) and `hash` (persisted to
 * `AccountToken.tokenHash`).
 */
export function generateAccountToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("base64url");
  return { raw, hash: hashAccountToken(raw) };
}

/**
 * Minimal Prisma surface {@link issueAccountToken} needs — just the two calls
 * it makes, not the full `AccountTokenDelegate`. Structural, mirroring
 * `lib/workspace.ts`'s `PrismaClientLike`: both the top-level `prisma` singleton
 * and a `$transaction(async (tx) => ...)` callback's `tx` structurally qualify,
 * and tests can pass a plain object exposing only `deleteMany`/`create`.
 */
export type PrismaClientLike2 = {
  accountToken: {
    deleteMany: PrismaClient["accountToken"]["deleteMany"];
    create: PrismaClient["accountToken"]["create"];
  };
};

/**
 * Issues a fresh single-use token of `type` for `userId`, returning the RAW
 * token (the caller emails it once, in a link fragment — never persists it).
 *
 * First deletes any still-UNUSED token of the same type for the user, so
 * re-requesting (e.g. a second password reset) invalidates the older link and
 * only the newest one works. Already-used tokens are left untouched as an audit
 * trail. Runs the delete + create against the caller-supplied `tx` so a route
 * can wrap issuance in a larger transaction.
 */
export async function issueAccountToken(
  tx: PrismaClientLike2,
  userId: string,
  type: AccountTokenType,
  now: Date = new Date(),
): Promise<string> {
  const { raw, hash } = generateAccountToken();

  await tx.accountToken.deleteMany({ where: { userId, type, usedAt: null } });

  await tx.accountToken.create({
    data: {
      userId,
      type,
      tokenHash: hash,
      expiresAt: new Date(now.getTime() + TTL_MS_BY_TYPE[type]),
    },
  });

  return raw;
}
