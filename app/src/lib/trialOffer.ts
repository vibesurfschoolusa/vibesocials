import { offeredPlans, paymentsConfigured } from "@/lib/billing";
import { getPlanOffers } from "@/server/billing/planPrices";

/**
 * What the landing and About pages offer once payments are configured (S1):
 * the trial instead of a "free account", and the price it leads to. With
 * payments not configured nothing here is shown.
 */

export function trialButtonLabel(days: number): string {
  return `Start your ${days}-day free trial`;
}

/** Never a made-up price: without one from Stripe, only the card line. */
export function trialPriceLine(price: string | null): string {
  return price ? `From ${price} after the trial. No card needed to start.` : "No card needed to start.";
}

/**
 * The lowest offered plan's price as Stripe gives it ("$19 a month"),
 * through the pricing page's hour-long cache; null when payments are not
 * configured (no Stripe call) or Stripe gave none.
 */
export async function startingPrice(): Promise<string | null> {
  if (!paymentsConfigured()) return null;
  const [lowest] = offeredPlans();
  if (!lowest) return null;
  const [offer] = await getPlanOffers([lowest]);
  return offer?.price ?? null;
}
