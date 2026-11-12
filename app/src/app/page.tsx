import { DashboardHome } from "@/components/dashboard/dashboard-home";
import { Landing } from "@/components/landing";
import { advertisedPlatforms } from "@/lib/advertisedPlatforms";
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
export default async function HomePage() {
  const user = await getCurrentUser();
  if (user) {
    return <DashboardHome availablePlatforms={advertisedPlatforms()} setup={await loadWorkspaceSetup()} />;
  }
  // S1: null without a Stripe call while payments are not configured.
  return <Landing startingPrice={await startingPrice()} />;
}

/**
 * What the Get started steps need from the active workspace (S2): whether the
 * footer and brand voice are set and, for an owner, whether a client link is
 * on. Null when it cannot be read: the dashboard then hides the steps, as it
 * does when its own fetches fail, instead of the page failing.
 */
async function loadWorkspaceSetup(): Promise<WorkspaceSetup | null> {
  try {
    const context = await getWorkspaceContext();
    if (!context) return null;
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
    return workspaceSetupFrom(context.workspace, context.role, hasClientLink);
  } catch (error) {
    logger.error("[dashboard] Couldn't read the workspace setup", { error: error instanceof Error ? error.name : typeof error });
    return null;
  }
}
