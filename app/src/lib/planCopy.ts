import { billingEnabled, planState, type BillingEnv, type BillingFields } from "@/lib/billing";

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

/**
 * S1 fix round 1: the one-workspace sentence is true of a screen only for a
 * workspace on a trial or plan. An exempt workspace (by its flag, or created
 * with billing off) never needs a plan, so it is not told one.
 */
export function workspacePlanNoteShown(workspace: BillingFields, now: Date, env: BillingEnv = process.env): boolean {
  return billingEnabled(env) && planState(workspace, now) !== "exempt";
}
