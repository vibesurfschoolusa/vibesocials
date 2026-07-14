import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";

import { prisma } from "./db";
import { normalizeEmail } from "./email";

export const authOptions: NextAuthOptions = {
  session: {
    strategy: "jwt",
    // Bound stolen-session lifetime; password reset also bumps sessionVersion
    // so outstanding JWTs are rejected by getCurrentUser before maxAge.
    maxAge: 30 * 24 * 60 * 60,
  },
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const email = normalizeEmail(credentials.email);

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
          // Carried into the JWT so getCurrentUser can reject sessions issued
          // before a password reset (sessionVersion bump).
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
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token?.id) {
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
