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

/**
 * Resolve a Google sign-in to OUR User row, creating one on first sign-in.
 * Returns `null` to REFUSE the sign-in (NextAuth signIn callback → false):
 *
 * - No email, or `email_verified` !== true → refused. Linking by email is only
 *   safe because Google attests mailbox ownership; an unverified email could
 *   take over an existing password account.
 * - Existing UNVERIFIED account WITH a password → refused (pre-hijack guard):
 *   registration doesn't require email verification, so that row may have
 *   been seeded by someone else who knows its password — silently linking
 *   would hand the mailbox owner an account with a password backdoor. The
 *   mailbox owner's recovery is the forgot-password flow (which proves the
 *   mailbox, replaces the password, and bumps sessionVersion).
 * - Existing verified account (or passwordless row): linked by normalized
 *   email; `emailVerifiedAt` stamped if still null (a Google sign-in is proof
 *   of mailbox ownership, same standard as our own verify link).
 * - New user: created with `passwordHash: null` (SSO-only until they run the
 *   forgot-password flow), atomically with their personal workspace — same
 *   transaction shape as the register route (design doc §2), so
 *   getWorkspaceContext's self-heal stays the backstop, not the normal path.
 */
export async function findOrCreateGoogleSsoUser(input: {
  email?: string | null;
  name?: string | null;
  emailVerified?: boolean;
}): Promise<User | null> {
  if (!input.email || input.emailVerified !== true) {
    return null;
  }
  const email = normalizeEmail(input.email);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (!existing.emailVerifiedAt && existing.passwordHash) {
      // Pre-hijack guard — see the doc comment above.
      return null;
    }
    if (!existing.emailVerifiedAt) {
      return prisma.user.update({
        where: { id: existing.id },
        data: { emailVerifiedAt: new Date() },
      });
    }
    return existing;
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          name: input.name?.trim() || null,
          passwordHash: null,
          emailVerifiedAt: new Date(),
        },
      });
      await provisionPersonalWorkspace(tx, created);
      return created;
    });
  } catch (error) {
    // Unique-email race (P2002, same detection as the register route): a
    // concurrent sign-in — or a concurrent password REGISTRATION — created
    // the row between our find and create. Re-run the resolution so the
    // winner's row goes through the exact linking rules above (a concurrent
    // unverified password registration must still be refused, not adopted).
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
