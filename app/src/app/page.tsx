import { DashboardHome } from "@/components/dashboard/dashboard-home";
import { Landing } from "@/components/landing";
import { advertisedPlatforms } from "@/lib/advertisedPlatforms";
import { getCurrentUser } from "@/lib/auth";
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
  if (user) return <DashboardHome availablePlatforms={advertisedPlatforms()} />;
  // S1: null without a Stripe call while payments are not configured.
  return <Landing startingPrice={await startingPrice()} />;
}
