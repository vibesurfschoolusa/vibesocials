"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { planChoiceButtons } from "@/components/planChoiceButtons";
import type { PlanKey } from "@/lib/plans";

/**
 * Settings → Plan buttons (21b): one per offered plan, which opens Stripe
 * Checkout, and "Manage plan, card and invoices", which opens the Stripe
 * customer portal. The server answers the Stripe address; the browser goes
 * there. Nothing here changes the plan: Stripe's webhook does that.
 */

export type PlanOfferView = { plan: PlanKey; name: string; price: string | null };

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
  /** P1: the plans with a yearly price; a button each, after the monthly ones. */
  yearlyOffers?: PlanOfferView[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      {offers.length > 0 || yearlyOffers.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {planChoiceButtons(offers, yearlyOffers).map((button) => (
            <Button
              key={button.key}
              variant="primary"
              disabled={busy !== null}
              onClick={() => run(button.key, "/api/billing/checkout", button.body)}
            >
              {button.label}
            </Button>
          ))}
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
