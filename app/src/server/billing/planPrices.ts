import { priceIdForPlan, type BillingEnv } from "@/lib/billing";
import { logger } from "@/lib/logger";
import { PLANS, type PlanKey } from "@/lib/plans";

import { reportDuplicatePriceIds } from "./priceConfig";
import { retrievePrice, StripeApiError, type StripePrice } from "./stripeApi";

/**
 * The plan prices Settings shows (21b), as Stripe has them, so the page
 * never states a price Stripe would not charge. Read on the server and kept
 * in this instance's memory for an hour; a failed read is kept for five
 * minutes, so an unreachable Stripe costs one slow render, not every one.
 * Without a price the button still shows, with the plan's name only.
 */

const PRICE_TTL_MS = 60 * 60 * 1000;
const FAILURE_TTL_MS = 5 * 60 * 1000;

/** Currencies whose amounts Stripe gives in whole units, not hundredths. */
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);

const cache = new Map<string, { label: string | null; expiresAt: number }>();

/** For tests. */
export function resetPlanPriceCache(): void {
  cache.clear();
}

/** "$99 a month", "$169.50 a month", "$990 a year", "$99 every 3 months"; null without an amount. */
export function formatPriceLabel(price: Pick<StripePrice, "unit_amount" | "currency" | "recurring">): string | null {
  if (typeof price.unit_amount !== "number") return null;
  const currency = price.currency.toLowerCase();
  const amount = ZERO_DECIMAL.has(currency) ? price.unit_amount : price.unit_amount / 100;
  const whole = Number.isInteger(amount);
  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount);
  const recurring = price.recurring;
  if (!recurring) return money;
  const count = recurring.interval_count ?? 1;
  return count === 1 ? `${money} a ${recurring.interval}` : `${money} every ${count} ${recurring.interval}s`;
}

async function priceLabel(priceId: string, env: BillingEnv, now: number): Promise<string | null> {
  const hit = cache.get(priceId);
  if (hit && hit.expiresAt > now) return hit.label;
  try {
    const label = formatPriceLabel(await retrievePrice(priceId, env));
    cache.set(priceId, { label, expiresAt: now + PRICE_TTL_MS });
    return label;
  } catch (error) {
    logger.warn("[billing] Could not read a plan price from Stripe; showing the plan without it", {
      status: error instanceof StripeApiError ? error.status : null,
      code: error instanceof StripeApiError ? error.code : null,
    });
    cache.set(priceId, { label: null, expiresAt: now + FAILURE_TTL_MS });
    return null;
  }
}

export type PlanOffer = { plan: PlanKey; name: string; price: string | null };

/** The plans given that have a price id, each with Stripe's price as words (null when unknown). */
export async function getPlanOffers(
  plans: PlanKey[],
  env: BillingEnv = process.env,
  now: number = Date.now(),
): Promise<PlanOffer[]> {
  reportDuplicatePriceIds("settings prices", env);
  const priced = plans.flatMap((plan) => {
    const priceId = priceIdForPlan(plan, env);
    return priceId ? [{ plan, priceId }] : [];
  });
  return Promise.all(
    priced.map(async ({ plan, priceId }) => ({ plan, name: PLANS[plan].name, price: await priceLabel(priceId, env, now) })),
  );
}
