import Link from "next/link";

import { trialPriceLine } from "@/lib/trialOffer";

/** The price line under a trial button (S1), with its link to Pricing. */
export function TrialPriceLine({ price, className }: { price: string | null; className?: string }) {
  return (
    <p className={className}>
      {trialPriceLine(price)}{" "}
      <Link href="/pricing" className="font-medium text-primary underline-offset-4 hover:underline">
        See pricing
      </Link>
    </p>
  );
}
