"use client";

import { useEffect, useState } from "react";

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

/**
 * Unconfirmed in R7-new-customer: Back from Stripe Checkout can restore this
 * page from the browser's back-forward cache with the buttons still busy (the
 * page was leaving when they were pressed). `reset` runs when the page is
 * shown again that way. Answers the function that stops listening.
 */
export function onReturnFromCache(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  reset: () => void,
): () => void {
  const listener = (event: PageTransitionEvent) => {
    if (event.persisted) reset();
  };
  target.addEventListener("pageshow", listener);
  return () => target.removeEventListener("pageshow", listener);
}

export function PlanActions({
  workspaceId,
  offers,
  manage,
  yearlyOffers = [],
  manageLabel = "Manage plan, card and invoices",
}: {
  /** The workspace this page was rendered for; the billing routes refuse any other (F3). */
  workspaceId: string;
  offers: PlanOfferView[];
  manage: boolean;
  /** P1: the plans with a yearly price; Q1: their buttons show under Yearly. */
  yearlyOffers?: PlanOfferView[];
  /** Review of R5-security L2: "Manage your payment" for a payer who is not an owner. */
  manageLabel?: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Q1: Monthly first, as on the pricing page.
  const [interval, setBillingInterval] = useState<BillingChoice>("month");
  const choice = planChoiceView(offers, yearlyOffers, interval);

  useEffect(() => onReturnFromCache(window, () => setBusy(null)), []);

  async function run(key: string, url: string, body?: unknown) {
    if (busy !== null) return;
    setBusy(key);
    setError(null);
    const message = await openStripe(url, { ...(body as Record<string, unknown> | undefined), workspaceId });
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
              aria-disabled={busy !== null || undefined}
              onClick={() => {
                if (busy === null) setBillingInterval(option.value);
              }}
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
                loading={busy === button.key}
                aria-disabled={busy !== null || undefined}
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
          <Button
            variant="outline"
            loading={busy === "portal"}
            aria-disabled={busy !== null || undefined}
            onClick={() => run("portal", "/api/billing/portal")}
          >
            {manageLabel}
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
