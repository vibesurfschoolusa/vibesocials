import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import bcrypt from "bcryptjs";

import { prisma } from "./db";
import { normalizeEmail } from "./email";
import { findOrCreateGoogleSsoUser, googleSsoConfig } from "./googleSso";
import { GOOGLE_PASSWORD_ACCOUNT_ERROR } from "./loginOAuthError";
import { checkRateLimit } from "./rateLimit";

// Login throttles (all fail-closed). Keyed per (email, IP) rather than per
// email so one IP guessing at a victim's address exhausts only ITS bucket —
// the victim, from their own IP, can still sign in. The per-IP limit caps
// spraying many addresses from one host, and the per-email hourly backstop
// caps a distributed attack on one account (one IP alone can reach at most
// 40/hour against it: 10 per 15-minute bucket).
const LOGIN_EMAIL_IP_LIMIT = {
  route: "auth/login",
  limit: 10,
  windowMs: 15 * 60 * 1000,
} as const;
const LOGIN_IP_LIMIT = {
  route: "auth/login-ip",
  limit: 30,
  windowMs: 15 * 60 * 1000,
} as const;
const LOGIN_EMAIL_LIMIT = {
  route: "auth/login-email",
  limit: 100,
  windowMs: 60 * 60 * 1000,
} as const;

// Evaluated once at module load (authOptions is a module-level const anyway);
// env vars are fixed for a deployment's lifetime.
const googleSso = googleSsoConfig();

type AuthorizeRequest =
  | { headers?: Headers | Record<string, string | string[] | undefined> }
  | undefined;

function clientIpFromAuthReq(req: AuthorizeRequest): string {
  if (!req?.headers) return "unknown";
  const headers = req.headers;
  const raw =
    typeof (headers as Headers).get === "function"
      ? (headers as Headers).get("x-forwarded-for")
      : (headers as Record<string, string | string[] | undefined>)["x-forwarded-for"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? "unknown").split(",")[0].trim() || "unknown";
}

/**
 * A fixed bcrypt hash (cost 10, same as register/reset) of a random string
 * nobody knows. Compared against when the email has no account or the account
 * has no password, so every login attempt pays one bcrypt.compare and the
 * response time doesn't reveal which emails are registered.
 */
export const LOGIN_DUMMY_PASSWORD_HASH =
  "$2b$10$q6MrNNSuZd96xoBcyDM4fOwEYlaaK9ofCxe.2kWdoXNQQJ1jGtipW";

/** The Credentials provider's `authorize` (exported for tests). */
export async function authorizeCredentials(
  credentials: Record<"email" | "password", string> | undefined,
  req: AuthorizeRequest,
) {
  if (!credentials?.email || !credentials?.password) {
    return null;
  }

  const email = normalizeEmail(credentials.email);
  const ip = clientIpFromAuthReq(req);

  // Fail-closed throttles: online password guessing + cost amplification.
  // Exhausted limits return null (same as bad credentials — no oracle).
  // Checked in order and short-circuited, so attempts an IP makes after its
  // own buckets are exhausted never count toward the per-email backstop.
  const limits = [
    { userId: `email-ip:${email}|${ip}`, ...LOGIN_EMAIL_IP_LIMIT },
    { userId: `ip:${ip}`, ...LOGIN_IP_LIMIT },
    { userId: `email:${email}`, ...LOGIN_EMAIL_LIMIT },
  ];
  for (const limit of limits) {
    const result = await checkRateLimit({ ...limit, failClosed: true });
    if (!result.allowed) {
      return null;
    }
  }

  const user = await prisma.user.findUnique({
    where: { email },
  });

  // Always exactly one bcrypt.compare — see LOGIN_DUMMY_PASSWORD_HASH.
  const isValid = await bcrypt.compare(
    credentials.password,
    user?.passwordHash || LOGIN_DUMMY_PASSWORD_HASH,
  );
  if (!user || !user.passwordHash || !isValid) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name ?? undefined,
    // Carried into the JWT so getCurrentUser / jwt re-check can reject
    // sessions issued before a password reset (sessionVersion bump).
    sessionVersion: user.sessionVersion,
  };
}

export const authOptions: NextAuthOptions = {
  session: {
    strategy: "jwt",
    // Bound stolen-session lifetime; password reset also bumps sessionVersion
    // so outstanding JWTs are rejected by getCurrentUser / jwt re-check before maxAge.
    maxAge: 30 * 24 * 60 * 60,
  },
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "text" },
        password: { label: "Password", type: "password" },
      },
      authorize: (credentials, req) => authorizeCredentials(credentials, req),
    }),
    // Env-gated (like RESEND_API_KEY): registered only when the owner has
    // configured a Google OAuth client — see lib/googleSso.ts. With it absent
    // (the default today) /api/auth/providers reports credentials only and the
    // login/register pages render no Google button.
    ...(googleSso
      ? [
          GoogleProvider({
            clientId: googleSso.clientId,
            clientSecret: googleSso.clientSecret,
          }),
        ]
      : []),
  ],
  pages: {
    signIn: "/login",
    // Also route NextAuth's error redirects to /login: a refused signIn
    // callback raises AccessDenied, which v4 does NOT forward to pages.signIn
    // (only OAuthSignin/OAuthCallback/... are) — without this, a refused
    // Google sign-in lands on the unbranded /api/auth/error page. The login
    // page maps ?error= codes to copy (lib/loginOAuthError.ts).
    error: "/login",
  },
  callbacks: {
    // Google sign-ins resolve to OUR User row (created on first sign-in) or
    // are refused — see lib/googleSso.ts for the verified-email linking
    // rules. A refusal to link into a password account redirects to the
    // login page's specific copy (a signIn callback may return a URL); any
    // other refusal returns false (AccessDenied → generic copy).
    // On success the resolved row's id/sessionVersion are
    // stamped ONTO `user`: NextAuth v4 hands this same object to the jwt
    // callback below, so the one generic `if (user)` branch mints the token
    // from OUR prisma id (raw OAuth `user.id` is Google's subject, and the
    // sessionVersion-revocation design depends on token.id being a prisma
    // User id). Single resolution, no second lookup, no divergence.
    // Credentials sign-ins pass straight through (authorize() did the work).
    async signIn({ user, account, profile }) {
      if (account?.provider !== "google") return true;
      const oidc = profile as
        | { email?: string; name?: string; email_verified?: boolean }
        | undefined;
      const result = await findOrCreateGoogleSsoUser({
        email: oidc?.email,
        name: oidc?.name,
        emailVerified: oidc?.email_verified,
      });
      if (!result.ok) {
        return result.reason === "password_account"
          ? `/login?error=${GOOGLE_PASSWORD_ACCOUNT_ERROR}`
          : false;
      }
      const mutable = user as { id?: string; sessionVersion?: number };
      mutable.id = result.user.id;
      mutable.sessionVersion = result.user.sessionVersion;
      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = (user as { id: string }).id;
        token.sessionVersion =
          (user as { sessionVersion?: number }).sessionVersion ?? 0;
        return token;
      }

      // Re-check sessionVersion on every JWT access (getSession / getServerSession).
      // Password reset increments the DB value; returning null clears the cookie
      // so client useSession flips to unauthenticated (not only API 401s).
      if (typeof token.id === "string") {
        try {
          const dbUser = await prisma.user.findUnique({
            where: { id: token.id },
            select: { sessionVersion: true },
          });
          const claimed =
            typeof token.sessionVersion === "number" ? token.sessionVersion : 0;
          if (!dbUser || dbUser.sessionVersion !== claimed) {
            return null as unknown as typeof token;
          }
        } catch {
          // DB blip: keep the token; getCurrentUser still enforces on API/page paths.
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (!token?.id) {
        // Cleared JWT / invalid sessionVersion. Expire immediately so the
        // client SessionProvider treats this as unauthenticated (a bare
        // `user: undefined` with a future `expires` can still look signed-in).
        return {
          ...session,
          user: undefined as unknown as typeof session.user,
          expires: new Date(0).toISOString(),
        };
      }
      if (session.user) {
        (session.user as { id?: string; sessionVersion?: number }).id =
          token.id as string;
        (session.user as { id?: string; sessionVersion?: number }).sessionVersion =
          typeof token.sessionVersion === "number" ? token.sessionVersion : 0;
      }
      return session;
    },
  },
};

export async function getCurrentUser() {
  const session = await getServerSession(authOptions);
  if (!session?.user || !(session.user as { id?: string }).id) {
    return null;
  }

  const userId = (session.user as { id?: string }).id as string;
  const sessionVersion =
    (session.user as { sessionVersion?: number }).sessionVersion ?? 0;

  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    return null;
  }

  // Password reset (and any future force-logout) increments sessionVersion.
  // JWTs issued before the bump still pass NextAuth's signature check but
  // fail here, so getServerSession alone is not enough — every API/page path
  // that uses getCurrentUser / getWorkspaceContext is covered.
  if (user.sessionVersion !== sessionVersion) {
    return null;
  }

  return user;
}
