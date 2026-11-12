import type { PlanKey } from "@/lib/plans";

// Imports nothing at run time: the Plan buttons (a client component) use it.
type ChoiceOffer = { plan: PlanKey; name: string; price: string | null };

export type PlanChoiceButton = { key: string; label: string; body: { plan: PlanKey; interval?: "year" } };

/**
 * The plan buttons (21b), and P1's yearly ones after them. The monthly buttons
 * and the bodies they send are exactly today's; a yearly button sends
 * `interval: "year"`. With no yearly offers, only today's buttons.
 */
export function planChoiceButtons(monthly: ChoiceOffer[], yearly: ChoiceOffer[]): PlanChoiceButton[] {
  return [
    ...monthly.map((offer) => ({
      key: offer.plan,
      label: offer.price ? `Choose ${offer.name}, ${offer.price}` : `Choose ${offer.name}`,
      body: { plan: offer.plan },
    })),
    ...yearly.map((offer) => ({
      key: `${offer.plan}-year`,
      label: offer.price ? `Choose ${offer.name}, ${offer.price}` : `Choose ${offer.name} yearly`,
      body: { plan: offer.plan, interval: "year" as const },
    })),
  ];
}
