import { DashboardHome } from "@/components/dashboard/dashboard-home";
import { Landing } from "@/components/landing";
import { ServerSignedOutSync } from "@/components/server-signed-out-sync";
import { advertisedPlatforms } from "@/lib/advertisedPlatforms";
import { homeNotice } from "@/app/go/notice";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { workspaceSetupFrom, type WorkspaceSetup } from "@/lib/gettingStarted";
import { logger } from "@/lib/logger";
import { getWorkspaceContext } from "@/lib/workspace";
import { startingPrice } from "@/lib/trialOffer";

export const metadata = {
  title: "Vibe Socials | Upload once, post everywhere",
  description:
    "Vibe Socials lets small businesses and creators publish one photo or video to TikTok, Instagram, Facebook, YouTube, LinkedIn, X and Google Business Profile at once.",
};

/**
 * `/`: the marketing page when signed out, the dashboard when signed in.
 * Decided on the server (2026-11) so a signed-out visitor, a platform app
 * reviewer or a search engine gets the page's text in the HTML, instead of a
 * spinner waiting for a client-side session check.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const user = await getCurrentUser();
  if (user) {
    const { notice } = (await searchParams) ?? {};
    const { workspaceId, setup } = await loadDashboardWorkspace();
    return (
      <DashboardHome
        availablePlatforms={advertisedPlatforms()}
        workspaceId={workspaceId}
        setup={setup}
        notice={homeNotice(notice, user.email)}
      />
    );
  }
  // S1: null without a Stripe call while payments are not configured. R19: a
  // tab whose cached session still names someone follows this answer; the sync
  // renders nothing, so the HTML is the Landing's alone.
  return (
    <>
      <Landing startingPrice={await startingPrice()} />
      <ServerSignedOutSync />
    </>
  );
}

/**
 * The active workspace's id, which the dashboard's reads send (R32: a tab left
 * on it after another tab switched gets the switch sentence, not the other
 * workspace's posts), and what the Get started steps need from it (S2):
 * whether the footer and brand voice are set and, for an owner, whether a
 * client link is on. The setup is null when it cannot be read: the dashboard
 * then hides the steps, as it does when its own fetches fail, instead of the
 * page failing.
 */
async function loadDashboardWorkspace(): Promise<{ workspaceId: string | null; setup: WorkspaceSetup | null }> {
  let workspaceId: string | null = null;
  try {
    const context = await getWorkspaceContext();
    if (!context) return { workspaceId, setup: null };
    workspaceId = context.workspace.id;
    let hasClientLink = false;
    if (context.role === "owner") {
      // Active as each link's own page counts it: not revoked, and a connect
      // link also not expired (upload and review links do not expire).
      const active = { where: { revokedAt: null } };
      const row = await prisma.workspace.findUnique({
        where: { id: context.workspace.id },
        select: {
          _count: {
            select: {
              uploadLinks: active,
              reviewLinks: active,
              connectLinks: { where: { revokedAt: null, expiresAt: { gt: new Date() } } },
            },
          },
        },
      });
      const count = row?._count;
      hasClientLink = Boolean(count && count.uploadLinks + count.reviewLinks + count.connectLinks > 0);
    }
    return { workspaceId, setup: workspaceSetupFrom(context.workspace, context.role, hasClientLink) };
  } catch (error) {
    logger.error("[dashboard] Couldn't read the workspace setup", { error: error instanceof Error ? error.name : typeof error });
    return { workspaceId, setup: null };
  }
}
