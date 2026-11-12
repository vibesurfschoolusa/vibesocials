import { PRICING_CANCEL, TERMS_FEES_REFUNDS } from "@/lib/billingTerms";

/**
 * The pricing page's words around the cards (S1). Each claim is something the
 * app does for every plan today; each answer is what the code does, or the
 * owner's Terms text (lib/billingTerms.ts) where it is a promise.
 */

/** Above the cards. */
export const PRICING_INCLUDES_HEADING = "Every plan includes:";

export const PRICING_INCLUDES = [
  // googlePostOptions.ts: call-to-action buttons, offers and events.
  "Google Business Profile posts with buttons, offers and events.",
  // The Reviews page drafts a reply with AI.
  "AI drafts of replies to your Google reviews.",
  // The upload (/u), review (/v) and connect (/c) links open without signing in.
  "Links your clients use to send photos, approve posts and connect their accounts, without an account of their own.",
  // The monthly report reads the listing's stored daily numbers.
  "A monthly report with the calls, direction requests and website clicks from your Google listing.",
] as const;

/**
 * Under the cards. The trial answer follows workspaceStatus.ts: an ended trial
 * refuses new work, and the publish job fails a due post with PLAN_ENDED,
 * which Activity can retry once a plan is active. Nothing deletes data when a
 * trial or plan ends.
 */
export const PRICING_FAQ: readonly { question: string; answer: string }[] = [
  {
    question: "What is a workspace?",
    answer: "A workspace is one business: its connected accounts, posts, media and team.",
  },
  {
    question: "What happens when the trial ends?",
    answer:
      "Posting stops until you choose a plan. Nothing is deleted. A scheduled post that comes due fails, and you can retry it from Activity once you have chosen a plan.",
  },
  {
    question: "How do I cancel?",
    answer: `${PRICING_CANCEL} After that, the workspace works as after a trial: posting stops and nothing is deleted.`,
  },
  { question: "Do you give refunds?", answer: TERMS_FEES_REFUNDS },
];

/** The last question; the page links the address. */
export const PRICING_CONTACT_QUESTION = "Who do I write to?";
