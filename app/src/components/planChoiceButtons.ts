import type { PlanKey } from "@/lib/plans";

// Imports nothing at run time: the Plan buttons (a client component) use it.
type ChoiceOffer = { plan: PlanKey; name: string; price: string | null };
// The yearly offers come from getYearlyPlanOffers, which runs yearlySavingTrue, the pricing page's rule.
type YearlyChoiceOffer = ChoiceOffer & { twoMonthsFree?: boolean };

export type BillingChoice = "month" | "year";

export type PlanChoiceButton = {
  key: string;
  label: string;
  body: { plan: PlanKey; interval?: "year" };
  /** Yearly only: whether "Two months free compared with monthly" goes under it. */
  twoMonthsFree?: boolean;
};

/**
 * Q1: the plan buttons for one interval, so a phone shows three buttons under
 * one Monthly / Yearly choice instead of six. The switch shows only when both
 * intervals have a plan; otherwise the one that has. The monthly buttons and
 * their bodies are exactly 21b's; a yearly one sends `interval: "year"`.
 */
export function planChoiceView(
  monthly: ChoiceOffer[],
  yearly: YearlyChoiceOffer[],
  chosen: BillingChoice,
): { showSwitch: boolean; interval: BillingChoice; buttons: PlanChoiceButton[] } {
  const showSwitch = monthly.length > 0 && yearly.length > 0;
  const interval: BillingChoice = showSwitch ? chosen : monthly.length > 0 ? "month" : yearly.length > 0 ? "year" : "month";
  const buttons: PlanChoiceButton[] =
    interval === "month"
      ? monthly.map((offer) => ({
          key: offer.plan,
          label: offer.price ? `Choose ${offer.name}, ${offer.price}` : `Choose ${offer.name}`,
          body: { plan: offer.plan },
        }))
      : yearly.map((offer) => ({
          key: `${offer.plan}-year`,
          label: offer.price ? `Choose ${offer.name}, ${offer.price}` : `Choose ${offer.name} yearly`,
          body: { plan: offer.plan, interval: "year" as const },
          // As the pricing card: never a saving beside a price Stripe did not give.
          twoMonthsFree: Boolean(offer.price && offer.twoMonthsFree),
        }));
  return { showSwitch, interval, buttons };
}
