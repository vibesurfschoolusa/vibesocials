import { priceIdForPlan, type BillingEnv, type BillingInterval } from "@/lib/billing";
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

type PriceAmount = Pick<StripePrice, "unit_amount" | "currency" | "recurring">;

// P1: the amount is kept beside the label, so the yearly saving is computed from Stripe's numbers.
const cache = new Map<string, { label: string | null; price: PriceAmount | null; expiresAt: number }>();

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

async function readPrice(
  priceId: string,
  env: BillingEnv,
  now: number,
): Promise<{ label: string | null; price: PriceAmount | null }> {
  const hit = cache.get(priceId);
  if (hit && hit.expiresAt > now) return hit;
  try {
    const price = await retrievePrice(priceId, env);
    const entry = { label: formatPriceLabel(price), price, expiresAt: now + PRICE_TTL_MS };
    cache.set(priceId, entry);
    return entry;
  } catch (error) {
    logger.warn("[billing] Could not read a plan price from Stripe; showing the plan without it", {
      status: error instanceof StripeApiError ? error.status : null,
      code: error instanceof StripeApiError ? error.code : null,
    });
    const entry = { label: null, price: null, expiresAt: now + FAILURE_TTL_MS };
    cache.set(priceId, entry);
    return entry;
  }
}

export type PlanOffer = { plan: PlanKey; name: string; price: string | null };

function pricedPlans(plans: PlanKey[], env: BillingEnv, interval: BillingInterval) {
  return plans.flatMap((plan) => {
    const priceId = priceIdForPlan(plan, env, interval);
    return priceId ? [{ plan, priceId }] : [];
  });
}

/** The plans given that have a monthly price id, each with Stripe's price as words (null when unknown). */
export async function getPlanOffers(
  plans: PlanKey[],
  env: BillingEnv = process.env,
  now: number = Date.now(),
): Promise<PlanOffer[]> {
  reportDuplicatePriceIds("settings prices", env);
  return Promise.all(
    pricedPlans(plans, env, "month").map(async ({ plan, priceId }) => ({
      plan,
      name: PLANS[plan].name,
      price: (await readPrice(priceId, env, now)).label,
    })),
  );
}

/**
 * P1: "Two months free compared with monthly" is true of a yearly price that
 * is at most ten times the monthly one, both as Stripe has them: whole
 * amounts, the same currency, one month against one year. Anything that
 * cannot be compared that way claims no saving.
 */
export function yearlySavingTrue(monthly: PriceAmount | null, yearly: PriceAmount | null): boolean {
  if (!monthly || !yearly) return false;
  if (typeof monthly.unit_amount !== "number" || typeof yearly.unit_amount !== "number") return false;
  if (monthly.currency.toLowerCase() !== yearly.currency.toLowerCase()) return false;
  const isOne = (price: PriceAmount, interval: string) =>
    price.recurring?.interval === interval && (price.recurring.interval_count ?? 1) === 1;
  if (!isOne(monthly, "month") || !isOne(yearly, "year")) return false;
  return yearly.unit_amount <= 10 * monthly.unit_amount;
}

export type YearlyPlanOffer = PlanOffer & { twoMonthsFree: boolean };

/**
 * P1: the plans given that have a yearly price id, each with Stripe's yearly
 * price as words and whether the saving line is true. Read through the same
 * cache as the monthly prices.
 */
export async function getYearlyPlanOffers(
  plans: PlanKey[],
  env: BillingEnv = process.env,
  now: number = Date.now(),
): Promise<YearlyPlanOffer[]> {
  const yearly = pricedPlans(plans, env, "year");
  if (yearly.length === 0) return [];
  reportDuplicatePriceIds("yearly prices", env);
  return Promise.all(
    yearly.map(async ({ plan, priceId }) => {
      const monthlyId = priceIdForPlan(plan, env, "month");
      const [year, month] = await Promise.all([
        readPrice(priceId, env, now),
        monthlyId ? readPrice(monthlyId, env, now) : Promise.resolve(null),
      ]);
      return {
        plan,
        name: PLANS[plan].name,
        price: year.label,
        twoMonthsFree: yearlySavingTrue(month?.price ?? null, year.price),
      };
    }),
  );
}
