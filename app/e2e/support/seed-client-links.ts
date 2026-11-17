import crypto from "node:crypto";

import { PrismaClient, type Platform } from "@prisma/client";

/**
 * Hotfix (digest 2711503741) E2E seed: one client review link and one client
 * connect link on a test user's personal workspace, so the specs can open
 * /v/[token]/report and /c/[token] as the client would.
 *
 * Seeded in the database rather than through the owner's create routes: those
 * seal the raw token with TOKEN_ENCRYPTION_KEY, which the E2E server does not
 * have, and the connect-link route also refuses platforms without app
 * credentials. The pages under test only ever look a link up by the SHA-256 of
 * its token (src/lib/inviteToken.ts), so the sealed copy is a placeholder.
 *
 * SAFETY: as seed-connection.ts, refuses to run unless E2E_DATABASE_URL is set,
 * and builds its OWN PrismaClient on that URL (never src/lib/db.ts).
 */

/** A raw link token and its stored hash, the shape the app makes (32 random bytes, base64url). */
function newLinkToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("base64url");
  return { raw, hash: crypto.createHash("sha256").update(raw).digest("hex") };
}

async function withTestDb<T>(run: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) {
    throw new Error(
      "seed-client-links: E2E_DATABASE_URL is not set — refusing to seed. " +
        "This helper must only ever run against a throwaway, migrated test database.",
    );
  }
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    return await run(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

/** The user's id and personal workspace: the oldest owned membership, as seed-connection.ts. */
async function ownerAndWorkspace(prisma: PrismaClient, email: string): Promise<{ userId: string; workspaceId: string }> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`seed-client-links: no user found for ${email}`);
  const membership = await prisma.workspaceMember.findFirst({
    where: { userId: user.id, role: "owner" },
    orderBy: { createdAt: "asc" },
    select: { workspaceId: true },
  });
  if (!membership) throw new Error(`seed-client-links: no owned workspace for ${email}`);
  return { userId: user.id, workspaceId: membership.workspaceId };
}

/** Seeds an active client review link; returns the raw token for /v/<token>. */
export async function seedReviewLink(email: string): Promise<string> {
  return withTestDb(async (prisma) => {
    const { userId, workspaceId } = await ownerAndWorkspace(prisma, email);
    const { raw, hash } = newLinkToken();
    await prisma.workspaceReviewLink.create({
      data: { workspaceId, tokenHash: hash, tokenSealed: "e2e-not-sealed", createdById: userId },
    });
    return raw;
  });
}

/** Seeds an active client connect link offering `platforms`; returns the raw token for /c/<token>. */
export async function seedConnectLink(email: string, platforms: Platform[]): Promise<string> {
  return withTestDb(async (prisma) => {
    const { userId, workspaceId } = await ownerAndWorkspace(prisma, email);
    const { raw, hash } = newLinkToken();
    await prisma.workspaceConnectLink.create({
      data: {
        workspaceId,
        tokenHash: hash,
        tokenSealed: "e2e-not-sealed",
        createdById: userId,
        platforms,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    return raw;
  });
}
