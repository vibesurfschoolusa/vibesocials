import type { User } from "@prisma/client";

import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/email";

/**
 * Google SSO is env-gated exactly like email (RESEND_API_KEY): with no
 * GOOGLE_SSO_CLIENT_ID / GOOGLE_SSO_CLIENT_SECRET set (the default today) the
 * provider is never registered, the login/register pages render no Google
 * button (they read /api/auth/providers), and nothing below runs. These are
 * deliberately SEPARATE vars from the platform-connection GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET (YouTube/GBP publishing) — the SSO OAuth client has
 * different redirect URIs and a much smaller scope (openid email profile).
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
 * - Existing user (any email casing — normalizeEmail matches the stored
 *   form): returned as-is, stamping `emailVerifiedAt` if still null (the
 *   Google sign-in IS proof of mailbox ownership, same standard as our own
 *   verify link).
 * - New user: created with `passwordHash: null` (SSO-only until they run the
 *   forgot-password flow) and `emailVerifiedAt` stamped. No workspace is
 *   provisioned here — `getWorkspaceContext`'s advisory-locked self-heal
 *   provisions the personal workspace on first touch (see lib/workspace.ts).
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
    if (!existing.emailVerifiedAt) {
      return prisma.user.update({
        where: { id: existing.id },
        data: { emailVerifiedAt: new Date() },
      });
    }
    return existing;
  }

  try {
    return await prisma.user.create({
      data: {
        email,
        name: input.name?.trim() || null,
        passwordHash: null,
        emailVerifiedAt: new Date(),
      },
    });
  } catch (error) {
    // Unique-email race: a concurrent first sign-in created the row between
    // our find and create. Adopt it; rethrow anything else.
    const raced = await prisma.user.findUnique({ where: { email } });
    if (raced) return raced;
    throw error;
  }
}
