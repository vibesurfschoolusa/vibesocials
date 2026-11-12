import type { Platform } from "@prisma/client";

import { PLATFORM_ORDER, platformLabel } from "@/lib/platforms";
import { SUPPORT_EMAIL } from "@/lib/siteInfo";

/**
 * What each platform needs before it can be connected, what the user sees
 * while connecting, and what to know afterwards: the facts behind /help.
 * Display-only, safe to import into client components.
 */
export interface PlatformGuide {
  /** The element id of the platform's section on /help. */
  anchor: string;
  /** What must be true before connecting. */
  needs: string[];
  /** What the user does and sees. */
  steps: string[];
  tips: string[];
  /**
   * A platform review that is still open. Kept here so that one edit removes
   * the note once the review finishes.
   */
  status?: string;
}

const META_REVIEW = `Meta is reviewing Vibe Socials. Until the review finishes, connecting Facebook and Instagram is not open to every account yet. Write to ${SUPPORT_EMAIL} and we will help you get set up.`;

const GOOGLE_VERIFICATION =
  'Google is still verifying Vibe Socials. Until then Google shows a screen saying it has not verified this app. Choose "Advanced", then "Go to vibesocials.wtf", to continue.';

export const PLATFORM_GUIDES: Record<Platform, PlatformGuide> = {
  facebook_page: {
    anchor: "facebook-page",
    needs: [
      'You manage the Page (full control, or content access under the Page\'s "Page access" settings).',
    ],
    steps: [
      "In Settings, under Connections, click Connect.",
      "Facebook asks which Pages to share and to confirm the permissions.",
      "If you manage several Pages, Vibe Socials asks which one to post to.",
    ],
    tips: [
      "If the Page you want is not offered: on Facebook open Settings, Business integrations, remove Vibe Socials, then connect again. Facebook then asks which Pages to share.",
      "Photos and videos are supported; videos are posted as Reels.",
    ],
    status: META_REVIEW,
  },
  instagram: {
    anchor: "instagram",
    needs: [
      "A professional (business) Instagram account that is linked to a Facebook Page you manage.",
      'To switch: in the Instagram app, Settings, "Account type and tools".',
    ],
    steps: [
      "Connecting goes through Facebook's sign-in.",
      "If several Instagram accounts qualify, Vibe Socials asks which one.",
    ],
    tips: [
      "A personal Instagram account cannot be connected.",
      "Photos are fitted to Instagram's allowed shapes automatically.",
    ],
    status: META_REVIEW,
  },
  youtube: {
    anchor: "youtube",
    needs: ["A YouTube channel on the Google account you sign in with."],
    steps: ["Choose the Google account and channel, then allow access."],
    tips: [
      "Videos only.",
      "To post to a channel you do not own, its owner adds your Google account as a manager (this works for Brand Account channels).",
    ],
  },
  google_business_profile: {
    anchor: "google-business-profile",
    needs: ["You are an owner or manager of the Business Profile."],
    steps: [
      "Sign in with Google and allow access.",
      "Then, back in Settings, choose the Maps location to post to.",
    ],
    tips: [
      "Posts appear on the Maps listing.",
      "Replies to Google reviews are on the Reviews page.",
    ],
    status: GOOGLE_VERIFICATION,
  },
  linkedin: {
    anchor: "linkedin",
    needs: ["You are a Super admin of the company page."],
    steps: [
      "Vibe Socials first offers to open LinkedIn's sign-out page, so that you can sign in as the right person.",
      "If you administer several pages, it asks which one.",
    ],
    tips: ["Posts go out as the company.", "Personal profiles are not supported."],
    status: `LinkedIn is reviewing Vibe Socials. If connecting your company page fails before the review finishes, write to ${SUPPORT_EMAIL}.`,
  },
  x: {
    anchor: "x",
    needs: ["The X account you want to post from."],
    steps: ["Sign in to that account on X and authorize."],
    tips: [
      "X refuses posts from apps that @mention accounts, so Vibe Socials removes @mentions from the X version of a post.",
    ],
  },
  tiktok: {
    anchor: "tiktok",
    needs: ["A TikTok account."],
    steps: [
      "Sign in on TikTok and allow access.",
      "Each time you post, you choose who can see the video and the other TikTok settings shown on the Create page.",
    ],
    tips: ["Videos only."],
    status:
      "TikTok is reviewing Vibe Socials. Until the review finishes, posts can only go to TikTok accounts that are set to private.",
  },
  pinterest: {
    anchor: "pinterest",
    needs: ["A Pinterest account with at least one board that is not secret."],
    steps: [
      "Sign in on Pinterest and allow access.",
      "If you have several boards, choose the one to pin to.",
    ],
    tips: ["Every Pin goes on that board."],
  },
};

/** The platform's section of the setup guide. */
export function platformHelpHref(platform: Platform): string {
  return `/help#${PLATFORM_GUIDES[platform].anchor}`;
}

/**
 * The dashboard's first step, before its link to the setup guide: which of
 * the offered platforms have no review open, so a newcomer starts with one
 * that works. Null when none does. Pinterest is never named: its app access
 * is still on trial and untested against the live API (it stays on the
 * Connections list where configured).
 */
const NOT_YET_PROMISED: readonly Platform[] = ["pinterest"];

export function readyToConnectSentence(available: readonly Platform[]): string | null {
  const ready = PLATFORM_ORDER.filter(
    (platform) => available.includes(platform) && !PLATFORM_GUIDES[platform].status && !NOT_YET_PROMISED.includes(platform),
  ).map(
    platformLabel,
  );
  if (ready.length === 0) return null;
  const names = ready.length === 1 ? ready[0] : `${ready.slice(0, -1).join(", ")} and ${ready[ready.length - 1]}`;
  return `${names} ${ready.length === 1 ? "connects" : "connect"} right away today; the others are explained in the`;
}
