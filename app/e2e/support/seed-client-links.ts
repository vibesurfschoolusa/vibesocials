import crypto from "node:crypto";

import { PrismaClient, type Platform } from "@prisma/client";

/**
 * Hotfix (digest 2711503741) E2E seed: a client review link or a client
 * connect link, each on its own new owner and workspace, so the specs can open
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

/**
 * A fresh owner with one workspace, written straight into the test database.
 * Not through POST /api/auth/register: that route allows only a few accounts
 * per network an hour, and the earlier core flows already use them up (429 on
 * PR #217). The owner never signs in; the link pages only need the rows.
 */
async function newOwnerWorkspace(prisma: PrismaClient, label: string): Promise<{ userId: string; workspaceId: string }> {
  const suffix = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const user = await prisma.user.create({
    data: { email: `e2e-${suffix}@example.test`, name: `E2E ${label}` },
    select: { id: true },
  });
  const workspace = await prisma.workspace.create({
    data: {
      name: `E2E ${label} workspace`,
      members: { create: { userId: user.id, role: "owner" } },
    },
    select: { id: true },
  });
  return { userId: user.id, workspaceId: workspace.id };
}

/** Seeds an owner, a workspace and an active client review link; returns the raw token for /v/<token>. */
export async function seedReviewLink(label: string): Promise<string> {
  return withTestDb(async (prisma) => {
    const { userId, workspaceId } = await newOwnerWorkspace(prisma, label);
    const { raw, hash } = newLinkToken();
    await prisma.workspaceReviewLink.create({
      data: { workspaceId, tokenHash: hash, tokenSealed: "e2e-not-sealed", createdById: userId },
    });
    return raw;
  });
}

/** Seeds an owner, a workspace and an active client connect link offering `platforms`; returns the raw token for /c/<token>. */
export async function seedConnectLink(label: string, platforms: Platform[]): Promise<string> {
  return withTestDb(async (prisma) => {
    const { userId, workspaceId } = await newOwnerWorkspace(prisma, label);
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
