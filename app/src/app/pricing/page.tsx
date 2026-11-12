import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { SiteLinks } from "@/components/legal-page";
import { buttonVariants } from "@/components/ui/button";
import { offeredPlans, paymentsConfigured, trialDays } from "@/lib/billing";
import { PRICING_CANCEL } from "@/lib/billingTerms";
import { WORKSPACE_PLAN_SENTENCE } from "@/lib/planCopy";
import { PLANS } from "@/lib/plans";
import { PRODUCT_NAME } from "@/lib/siteInfo";
import { getPlanOffers } from "@/server/billing/planPrices";

import { planLimitLines } from "./planWords";

// Prices come from Stripe through 21b's hour-long cache, read per request, and
// the page must answer the 404 the moment payments are not configured.
export const dynamic = "force-dynamic";

/**
 * /pricing (23): the offered plans with Stripe's prices. Until payments are
 * configured it is an address that does not exist, also in its metadata, so
 * nothing about it shows while platform reviewers read the site.
 */
export async function generateMetadata(): Promise<Metadata> {
  if (!paymentsConfigured()) notFound();
  return {
    title: `Pricing | ${PRODUCT_NAME}`,
    description: `The plans of ${PRODUCT_NAME}, what each allows, and what each costs.`,
  };
}

export default async function PricingPage() {
  if (!paymentsConfigured()) notFound();

  const offers = await getPlanOffers(offeredPlans());
  // Never a made-up price: a plan whose price Stripe did not give shows without one.
  const pricesMissing = offers.some((offer) => offer.price === null);

  return (
    <div className="flex min-h-screen justify-center bg-background px-4 py-10 text-foreground">
      <div className="w-full max-w-5xl">
        <div className="mb-6 flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold text-foreground">Pricing</h1>
          <Link
            href="/"
            className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Back to {PRODUCT_NAME}
          </Link>
        </div>

        <p className="text-base text-foreground">{trialDays()}-day free trial. No card needed to start.</p>
        <p className="mt-2 text-sm text-muted-foreground">{WORKSPACE_PLAN_SENTENCE}</p>
        {pricesMissing ? (
          <p className="mt-2 text-sm text-muted-foreground">Prices are unavailable right now. Try again in a minute.</p>
        ) : null}

        <ul className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          {offers.map((offer) => (
            <li key={offer.plan} className="flex flex-col rounded-xl border border-border bg-card p-5 text-card-foreground">
              <h2 className="text-lg font-semibold text-foreground">{offer.name}</h2>
              {offer.price ? <p className="mt-1 text-2xl font-bold text-foreground">{offer.price}</p> : null}
              <ul className="mt-4 flex-1 space-y-1 text-sm text-muted-foreground">
                {planLimitLines(PLANS[offer.plan].limits).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <Link href="/register" className={buttonVariants({ variant: "primary", className: "mt-5 w-full" })}>
                Start your free trial
              </Link>
            </li>
          ))}
        </ul>

        <div className="mt-6 space-y-1 text-sm text-muted-foreground">
          <p>{PRICING_CANCEL}</p>
          <p>
            <Link href="/terms" className="underline underline-offset-2 hover:text-foreground">
              Read the Terms of Service
            </Link>
          </p>
        </div>

        <SiteLinks />
      </div>
    </div>
  );
}
