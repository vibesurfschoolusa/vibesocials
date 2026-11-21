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
 * Minimal Prisma surface the functions below need — just the two calls they
 * make, not the full `AccountTokenDelegate`. Structural, mirroring
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
 * Stores a fresh single-use token of `type` for `userId` and returns the RAW
 * token (the caller emails it once, in a link fragment — never persists it).
 * Deletes nothing: a caller that emails the link uses {@link issueAccountToken},
 * which retires the older links once the email is accepted.
 */
export async function createAccountToken(
  tx: PrismaClientLike2,
  userId: string,
  type: AccountTokenType,
  now: Date = new Date(),
): Promise<{ raw: string; id: string; createdAt: Date }> {
  const { raw, hash } = generateAccountToken();
  const created = await tx.accountToken.create({
    data: {
      userId,
      type,
      tokenHash: hash,
      expiresAt: new Date(now.getTime() + TTL_MS_BY_TYPE[type]),
    },
    select: { id: true, createdAt: true },
  });
  return { raw, id: created.id, createdAt: created.createdAt };
}

/**
 * Issues a fresh token of `type` for `userId` and hands the raw token to
 * `deliver`, which emails it and says whether the email service accepted it.
 *
 * R56 new-customer L1: only the newest link works, but an older unused link is
 * retired only once the new one's email is accepted. Deleting first left a
 * person whose send failed with no working link at all. So: create, deliver,
 * then on acceptance delete the unused tokens of the type created BEFORE this
 * one (by createdAt, so two concurrent sends can't retire each other's links
 * and the newest wins); on refusal or a throw, delete only the new one, which
 * nobody received. Used tokens are never touched (an audit trail).
 */
export async function issueAccountToken(
  db: PrismaClientLike2,
  userId: string,
  type: AccountTokenType,
  deliver: (rawToken: string) => Promise<boolean>,
  now: Date = new Date(),
): Promise<boolean> {
  const issued = await createAccountToken(db, userId, type, now);
  let delivered = false;
  try {
    delivered = await deliver(issued.raw);
  } finally {
    if (!delivered) {
      await db.accountToken.deleteMany({ where: { id: issued.id, usedAt: null } });
    }
  }
  if (!delivered) return false;
  await db.accountToken.deleteMany({
    where: { userId, type, usedAt: null, createdAt: { lt: issued.createdAt } },
  });
  return true;
}
