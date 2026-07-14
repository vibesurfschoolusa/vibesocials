import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";

import { prisma } from "./db";
import { normalizeEmail } from "./email";
import { checkRateLimit } from "./rateLimit";

const LOGIN_EMAIL_LIMIT = {
  route: "auth/login",
  limit: 10,
  windowMs: 15 * 60 * 1000,
} as const;
const LOGIN_IP_LIMIT = {
  route: "auth/login-ip",
  limit: 30,
  windowMs: 15 * 60 * 1000,
} as const;

function clientIpFromAuthReq(req: { headers?: Headers | Record<string, string | string[] | undefined> } | undefined): string {
  if (!req?.headers) return "unknown";
  const headers = req.headers;
  const raw =
    typeof (headers as Headers).get === "function"
      ? (headers as Headers).get("x-forwarded-for")
      : (headers as Record<string, string | string[] | undefined>)["x-forwarded-for"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? "unknown").split(",")[0].trim() || "unknown";
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
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const email = normalizeEmail(credentials.email);

        // Fail-closed throttles: online password guessing + cost amplification.
        // Exhausted limits return null (same as bad credentials — no oracle).
        const emailLimit = await checkRateLimit({
          userId: `email:${email}`,
          ...LOGIN_EMAIL_LIMIT,
          failClosed: true,
        });
        if (!emailLimit.allowed) {
          return null;
        }
        const ipLimit = await checkRateLimit({
          userId: `ip:${clientIpFromAuthReq(req)}`,
          ...LOGIN_IP_LIMIT,
          failClosed: true,
        });
        if (!ipLimit.allowed) {
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { email },
        });

        if (!user || !user.passwordHash) {
          return null;
        }

        const isValid = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!isValid) {
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
      },
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
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
