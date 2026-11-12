"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { planChoiceView, type BillingChoice } from "@/components/planChoiceButtons";
import type { PlanKey } from "@/lib/plans";

/**
 * Settings → Plan buttons (21b): one per offered plan, which opens Stripe
 * Checkout, and "Manage plan, card and invoices", which opens the Stripe
 * customer portal. The server answers the Stripe address; the browser goes
 * there. Nothing here changes the plan: Stripe's webhook does that.
 */

/** twoMonthsFree: a yearly offer's saving, from getYearlyPlanOffers (the pricing page's rule). */
export type PlanOfferView = { plan: PlanKey; name: string; price: string | null; twoMonthsFree?: boolean };

async function openStripe(url: string, body?: unknown): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
    if (response.ok && data?.url) {
      window.location.assign(data.url);
      return null;
    }
    return data?.error ?? "That did not work. Reload the page and try again.";
  } catch {
    return "Couldn't reach the server. Check the connection and try again.";
  }
}

export function PlanActions({
  offers,
  manage,
  yearlyOffers = [],
}: {
  offers: PlanOfferView[];
  manage: boolean;
  /** P1: the plans with a yearly price; Q1: their buttons show under Yearly. */
  yearlyOffers?: PlanOfferView[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Q1: Monthly first, as on the pricing page.
  const [interval, setBillingInterval] = useState<BillingChoice>("month");
  const choice = planChoiceView(offers, yearlyOffers, interval);

  async function run(key: string, url: string, body?: unknown) {
    setBusy(key);
    setError(null);
    const message = await openStripe(url, body);
    // On success the page is leaving; keep the button busy until it does.
    if (message) {
      setError(message);
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {choice.showSwitch ? (
        <div role="group" aria-label="Billing period" className="flex gap-2">
          {(
            [
              { value: "month", label: "Monthly" },
              { value: "year", label: "Yearly" },
            ] as const
          ).map((option) => (
            <Button
              key={option.value}
              aria-pressed={choice.interval === option.value}
              variant={choice.interval === option.value ? "primary" : "outline"}
              size="sm"
              disabled={busy !== null}
              onClick={() => setBillingInterval(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : null}
      {offers.length > 0 || yearlyOffers.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {choice.buttons.map((button) => {
            const choose = (
              <Button
                key={button.key}
                variant="primary"
                disabled={busy !== null}
                onClick={() => run(button.key, "/api/billing/checkout", button.body)}
              >
                {button.label}
              </Button>
            );
            return button.twoMonthsFree ? (
              <div key={button.key} className="flex flex-col gap-1">
                {choose}
                <p className="text-sm text-muted-foreground">Two months free compared with monthly</p>
              </div>
            ) : (
              choose
            );
          })}
        </div>
      ) : null}
      {manage ? (
        <div>
          <Button variant="outline" disabled={busy !== null} onClick={() => run("portal", "/api/billing/portal")}>
            Manage plan, card and invoices
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
