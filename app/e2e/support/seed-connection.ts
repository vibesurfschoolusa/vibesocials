import { PrismaClient, type Platform } from "@prisma/client";

/**
 * Health track H3 — E2E connection seed (Task F / PR-3).
 *
 * Seeds one shared `SocialConnection` row onto a test user's personal
 * workspace, so the composer treats a platform as connected (see
 * `GET /api/connections`, which reports a platform "connected" iff a row exists
 * for the active workspace). Without it the composer renders the "Connect a
 * platform to start posting" empty state and disables the submit button, so a
 * freshly-registered user could not even SCHEDULE a post — see
 * `create-post-form.tsx`'s zero-connection gate.
 *
 * Why a helper called from the spec (not a standalone pre-seed script): every
 * test in `core-flows.spec.ts` provisions its OWN user via the register API
 * with a random email (`registerViaApi`), so the connection must attach to that
 * just-created user at test time — a fixed pre-seed can't know the id. Runs
 * inside the Playwright process, against a throwaway test Postgres only.
 *
 * SAFETY: refuses to run unless `E2E_DATABASE_URL` is set, and constructs its
 * OWN PrismaClient pointed explicitly at that URL — it never imports
 * `src/lib/db.ts` (whose client reads `DATABASE_URL`, which in a real
 * deployment is production). The schedule test additionally only calls this
 * behind the `E2E_UPLOAD_STUBS_READY` gate.
 */
export async function seedWorkspaceConnection(
  email: string,
  platform: Platform = "instagram",
): Promise<void> {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) {
    throw new Error(
      "seedWorkspaceConnection: E2E_DATABASE_URL is not set — refusing to seed. " +
        "This helper must only ever run against a throwaway, migrated test database.",
    );
  }

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!user) {
      throw new Error(`seedWorkspaceConnection: no user found for ${email}`);
    }

    // The personal workspace is the oldest OWNED membership (mirrors
    // resolveActiveMembershipId / ensurePersonalWorkspace in src/lib/workspace.ts).
    const membership = await prisma.workspaceMember.findFirst({
      where: { userId: user.id, role: "owner" },
      orderBy: { createdAt: "asc" },
      select: { workspaceId: true },
    });
    if (!membership) {
      throw new Error(`seedWorkspaceConnection: no owned workspace for ${email}`);
    }

    // Idempotent on the (workspaceId, platform) unique — re-running a test's
    // login/seed never trips a duplicate. The token/identifier are inert
    // placeholders: no lit flow ever publishes with them (publishing is an
    // async Inngest step no worker runs here — see e2e/README.md).
    await prisma.socialConnection.upsert({
      where: {
        workspaceId_platform: { workspaceId: membership.workspaceId, platform },
      },
      create: {
        userId: user.id,
        workspaceId: membership.workspaceId,
        platform,
        accessToken: "e2e-mock-access-token",
        accountIdentifier: `e2e-${platform}-account`,
      },
      update: {},
    });
  } finally {
    await prisma.$disconnect();
  }
}
