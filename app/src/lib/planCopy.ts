/**
 * Plan wording shared by the pricing page, Settings and the New workspace
 * form (S1). True to lib/billing.ts and server/billing/newWorkspaceTrial.ts:
 * a plan belongs to one workspace, and a person has one trial window that
 * every workspace they create shares.
 */
export const WORKSPACE_PLAN_SENTENCE =
  "Each plan covers one workspace: one business with its own connected accounts. A second workspace needs its own plan once your trial ends.";

/**
 * The delete confirmations with a paid plan. True to cancelOnDelete.ts (the
 * subscription is cancelled at Stripe at once, before anything is deleted, with
 * no refund issued) and to the Terms' refund sentence (lib/billingTerms.ts).
 */
export const PAID_PLAN_WORKSPACE_DELETE_SENTENCE =
  "This workspace's paid plan is cancelled at once when you delete it. The period you have already paid for is not refunded, except where the law requires it.";

export const PAID_PLAN_ACCOUNT_DELETE_SENTENCE =
  "Paid plans on the workspaces deleted with your account are cancelled at once. The period already paid for is not refunded, except where the law requires it.";
