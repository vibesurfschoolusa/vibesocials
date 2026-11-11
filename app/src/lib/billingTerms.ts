// DRAFT. The operator must read, correct and approve this text before switching billing on. It was written by an AI assistant, not a lawyer.

/**
 * The payment wording of the public pages (23), in one place so the operator
 * can read and approve it together. Nothing here is rendered with billing off:
 * every page that uses it shows its existing text then.
 */

import { PAST_DUE_GRACE_DAYS } from "./billing";

/** The Terms' "Last updated" date with billing on. The operator sets it when approving this text. */
export const BILLING_TERMS_LAST_UPDATED = "November 10, 2026";

/** Terms, section 7, with billing on. The first sentence is split around its link to the pricing page. */
export const TERMS_FEES_PRICING = { before: "Our plans and their prices are on the ", link: "pricing page", after: "." } as const;

export function termsFeesTrial(days: number): string {
  return `A new account starts with a ${days}-day free trial. No card is needed to start it.`;
}

export const TERMS_FEES_RENEWAL = "A paid plan renews at the end of each billing period until you cancel it.";

export const TERMS_FEES_CANCEL =
  "You can cancel any time in Settings, under Plan. You keep access until the end of the period you have paid for.";

export const TERMS_FEES_FAILED_PAYMENT = `If a payment fails, we try again. If it still fails, posting stops ${PAST_DUE_GRACE_DAYS} days after the period ends.`;

export const TERMS_FEES_REFUNDS = "We do not refund a period that has already started, except where the law requires it.";

export const TERMS_FEES_PRICE_CHANGES =
  "We may change our prices. We will tell you by email at least 30 days before a new price applies to you.";

export const TERMS_FEES_TAXES = "Taxes may be added to the price where they apply.";

/** Terms, section 10, with billing on: today's sentence without "(currently zero)". */
export const TERMS_LIABILITY =
  "The Service is provided \"as is\". To the extent the law allows, we are not liable for indirect or consequential losses, lost data, or a platform's actions on your account, and our total liability is limited to the amount you paid us in the 12 months before the claim.";

/** Privacy, section 5 (who processes your information), with billing on. */
export const PRIVACY_PAYMENTS =
  "Card payments are handled by Stripe. We never see or store your card number. We store your plan, its status and its dates, and the customer and subscription identifiers Stripe gives us.";

/** Register, under the button, with billing on. Split around its two links. */
export const REGISTER_AGREEMENT = {
  before: "By creating an account you agree to the ",
  terms: "Terms",
  between: " and the ",
  privacy: "Privacy Policy",
  after: ".",
} as const;

/** The pricing page, under the plans. */
export const PRICING_CANCEL = "Cancel any time in Settings. You keep access until the end of the period you paid for.";
