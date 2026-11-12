import { duplicatePriceIds, type BillingEnv } from "@/lib/billing";
import { logger } from "@/lib/logger";

/**
 * Logs, once per call, a price id listed under two plans' variables (fix
 * round 7). Each request path that reads the price lists (the webhook, a
 * checkout, the Settings price reader) calls this once; planForPriceId and
 * priceIdForPlan already treat such an id as mapping to no plan.
 */
export function reportDuplicatePriceIds(path: string, env: BillingEnv = process.env): void {
  const priceIds = duplicatePriceIds(env);
  if (priceIds.length === 0) return;
  logger.error("[billing] A Stripe price id is listed under two plans or intervals; it maps to no plan until one list drops it", {
    path,
    priceIds,
  });
}
