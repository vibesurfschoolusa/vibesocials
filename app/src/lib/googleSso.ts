import type { User } from "@prisma/client";

import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/email";
import { provisionPersonalWorkspace } from "@/lib/workspace";

/**
 * Google SSO is env-gated exactly like email (RESEND_API_KEY): with no
 * GOOGLE_SSO_CLIENT_ID / GOOGLE_SSO_CLIENT_SECRET set (the default today) the
 * provider is never registered, the login/register pages render no Google
 * button (they read /api/auth/providers), and nothing below runs. These are
 * deliberately SEPARATE vars from the platform-connection GOOGLE_GBP_*
 * credentials (YouTube/GBP publishing) — the SSO OAuth client has different
 * redirect URIs and a much smaller scope (openid email profile).
 */
export function googleSsoConfig(): {
  clientId: string;
  clientSecret: string;
} | null {
  const clientId = process.env.GOOGLE_SSO_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_SSO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

type GoogleSsoLinkCandidate = Pick<User, "passwordHash" | "googleLinkedAt" | "emailVerifiedAt">;
type GoogleSsoCreatePlan = {
  action: "create";
  data: { googleLinkedAt: Date; emailVerifiedAt: Date };
};
type GoogleSsoExistingPlan =
  | { action: "allow" }
  | { action: "link"; data: { googleLinkedAt: Date; emailVerifiedAt?: Date } };

/**
 * What a VERIFIED Google sign-in may do with the account (if any) that owns
 * its normalized email. Pure: `findOrCreateGoogleSsoUser` applies the result.
 *
 * - No account: create one, linked and verified now.
 * - Already linked (`googleLinkedAt` set): allow, no write.
 * - Not linked, no password: link — stamp `googleLinkedAt`, and
 *   `emailVerifiedAt` if still null (a Google sign-in proves the mailbox, the
 *   same standard as our own verify link).
 * - Not linked, WITH a password: refuse (`null`). Auto-linking would let
 *   whoever controls the Google account into a password account it never
 *   proved it owns — and registration needs no email verification, so that
 *   row may have been seeded by someone else (pre-hijack). The owner signs in
 *   with their password instead; a mailbox owner who doesn't know it uses
 *   forgot-password, which proves the mailbox and replaces the password.
 */
export function planGoogleSsoLink(existing: null, now: Date): GoogleSsoCreatePlan;
export function planGoogleSsoLink(
  existing: GoogleSsoLinkCandidate,
  now: Date,
): GoogleSsoExistingPlan | null;
export function planGoogleSsoLink(
  existing: GoogleSsoLinkCandidate | null,
  now: Date,
): GoogleSsoCreatePlan | GoogleSsoExistingPlan | null;
export function planGoogleSsoLink(
  existing: GoogleSsoLinkCandidate | null,
  now: Date,
): GoogleSsoCreatePlan | GoogleSsoExistingPlan | null {
  if (!existing) {
    return { action: "create", data: { googleLinkedAt: now, emailVerifiedAt: now } };
  }
  if (existing.googleLinkedAt) {
    return { action: "allow" };
  }
  if (existing.passwordHash) {
    return null;
  }
  return {
    action: "link",
    data: existing.emailVerifiedAt
      ? { googleLinkedAt: now }
      : { googleLinkedAt: now, emailVerifiedAt: now },
  };
}

/** Why a Google sign-in was refused (drives the login page copy). */
export type GoogleSsoRefusal =
  /** No email, or Google doesn't attest it (`email_verified` !== true). */
  | "unverified_email"
  /** The email belongs to a password account never linked to Google. */
  | "password_account";

export type GoogleSsoResult =
  | { ok: true; user: User }
  | { ok: false; reason: GoogleSsoRefusal };

/**
 * Resolve a Google sign-in to OUR User row, creating one on first sign-in, or
 * refuse it (NextAuth signIn callback → false / a login-page redirect):
 *
 * - No email, or `email_verified` !== true → refused (`unverified_email`).
 *   Linking by email is only safe because Google attests mailbox ownership.
 * - Otherwise the linking rules of `planGoogleSsoLink`, applied to the row
 *   that owns the normalized email (`password_account` when it refuses).
 * - New user: created with `passwordHash: null` (SSO-only until they run the
 *   forgot-password flow), atomically with their personal workspace — same
 *   transaction shape as the register route (design doc §2), so
 *   getWorkspaceContext's self-heal stays the backstop, not the normal path.
 */
export async function findOrCreateGoogleSsoUser(input: {
  email?: string | null;
  name?: string | null;
  emailVerified?: boolean;
}): Promise<GoogleSsoResult> {
  if (!input.email || input.emailVerified !== true) {
    return { ok: false, reason: "unverified_email" };
  }
  const email = normalizeEmail(input.email);
  const now = new Date();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    const plan = planGoogleSsoLink(existing, now);
    if (!plan) {
      return { ok: false, reason: "password_account" };
    }
    if (plan.action === "allow") {
      return { ok: true, user: existing };
    }
    const linked = await prisma.user.update({
      where: { id: existing.id },
      data: plan.data,
    });
    return { ok: true, user: linked };
  }

  const plan = planGoogleSsoLink(null, now);
  try {
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          name: input.name?.trim() || null,
          passwordHash: null,
          ...plan.data,
        },
      });
      await provisionPersonalWorkspace(tx, user);
      return user;
    });
    return { ok: true, user: created };
  } catch (error) {
    // Unique-email race (P2002, same detection as the register route): a
    // concurrent sign-in — or a concurrent password REGISTRATION — created
    // the row between our find and create. Re-run the resolution so the
    // winner's row goes through the exact linking rules above (a concurrent
    // password registration must still be refused, not adopted).
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "P2002") {
      return findOrCreateGoogleSsoUser(input);
    }
    throw error;
  }
}
