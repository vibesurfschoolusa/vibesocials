import crypto from "node:crypto";

import { planState, priceIdForPlan, toBillingDate, type BillingEnv } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { PlanKey } from "@/lib/plans";

import {
  createCheckoutSession,
  createCustomer,
  createPortalSession,
  expireCheckoutSession,
  listCustomerSubscriptions,
  listCheckoutSessions,
  stripeIdempotencyKey,
  StripeApiError,
} from "./stripeApi";
import { isLiveSubscriptionStatus } from "./subscriptionSync";

/**
 * Starting a Stripe Checkout for a plan, and opening the customer portal
 * (21b). The routes check the owner, the rate limit and that payments are
 * configured; these decide and call Stripe. Neither writes a plan column:
 * only the webhook does that. The only write is the new customer's id.
 */

export const CHECKOUT_MESSAGES = {
  notOffered: "This plan is not offered. Choose another plan.",
  exempt: "This workspace is billed by invoice.",
  subscribed: "Use Manage plan to change it.",
  noCustomer: "This workspace has no plan to manage yet. Choose a plan first.",
  noWorkspace: "This workspace no longer exists.",
  stripeDown: "We could not reach the payment page. Nothing was charged. Try again in a minute.",
  alreadyPaid: "You already have a plan. It appears here within a minute.",
} as const;

/**
 * Stripe accepts `subscription_data[trial_end]` only at least 48 hours ahead;
 * an hour more covers the time between this request and Stripe's check.
 */
export const MIN_TRIAL_LEAD_MS = 49 * 60 * 60 * 1000;

/** A double click or retry within this window reuses the same Checkout Session. */
const CHECKOUT_KEY_BUCKET_MS = 10 * 60 * 1000;
/** Portal sessions are short-lived, so their repeat window is short too. */
const PORTAL_KEY_BUCKET_MS = 60 * 1000;

export type CheckoutResult = { ok: true; url: string } | { ok: false; status: number; error: string };

const stripeDown = (): CheckoutResult => ({ ok: false, status: 502, error: CHECKOUT_MESSAGES.stripeDown });

function logStripeFailure(what: string, workspaceId: string, error: unknown) {
  logger.error(`[billing] ${what} failed`, {
    workspaceId,
    status: error instanceof StripeApiError ? error.status : null,
    code: error instanceof StripeApiError ? error.code : null,
    name: error instanceof Error ? error.name : typeof error,
  });
}

/**
 * Order: refuse (no price, exempt by flag, a live subscription stored or at
 * Stripe), then the customer (created once and saved only where none is
 * saved), then expire the customer's open Checkout sessions, then the new
 * Checkout Session. Expiring first (fix round 1) means an abandoned page or a
 * second tab can no longer be paid for a second subscription. A failure after the customer is saved
 * leaves just that id, which the next attempt reuses.
 */
export async function startCheckout(
  input: { workspaceId: string; ownerEmail: string; plan: PlanKey; now: Date; baseUrl: string },
  env: BillingEnv = process.env,
): Promise<CheckoutResult> {
  const priceId = priceIdForPlan(input.plan, env);
  if (!priceId) return { ok: false, status: 400, error: CHECKOUT_MESSAGES.notOffered };

  const select = {
    billingExempt: true,
    plan: true,
    planStatus: true,
    trialEndsAt: true,
    currentPeriodEnd: true,
    stripeCustomerId: true,
    stripeSubscriptionId: true,
  } as const;
  const workspace = await prisma.workspace.findUnique({ where: { id: input.workspaceId }, select });
  if (!workspace) return { ok: false, status: 404, error: CHECKOUT_MESSAGES.noWorkspace };

  // Only the flag: a workspace exempt merely for having no plan and no trial may buy one.
  if (workspace.billingExempt) return { ok: false, status: 409, error: CHECKOUT_MESSAGES.exempt };
  if (workspace.stripeSubscriptionId && isLiveSubscriptionStatus(workspace.planStatus)) {
    return { ok: false, status: 409, error: CHECKOUT_MESSAGES.subscribed };
  }

  let customer = workspace.stripeCustomerId;
  try {
    if (customer) {
      // The webhook may not have written a subscription paid for a moment ago.
      const subscriptions = await listCustomerSubscriptions(customer, env);
      if (subscriptions.some((s) => isLiveSubscriptionStatus(s.status))) {
        return { ok: false, status: 409, error: CHECKOUT_MESSAGES.subscribed };
      }
    } else {
      const created = await createCustomer(
        { workspaceId: input.workspaceId, email: input.ownerEmail },
        stripeIdempotencyKey(["customer", input.workspaceId]),
        env,
      );
      const saved = await prisma.workspace.updateMany({
        where: { id: input.workspaceId, stripeCustomerId: null },
        data: { stripeCustomerId: created.id },
      });
      if (saved.count === 1) {
        customer = created.id;
      } else {
        // Another request saved one first; use it so the workspace keeps one customer.
        const again = await prisma.workspace.findUnique({ where: { id: input.workspaceId }, select });
        customer = again?.stripeCustomerId ?? null;
        if (!customer) return { ok: false, status: 404, error: CHECKOUT_MESSAGES.noWorkspace };
      }
    }

    const trialEndsAt = toBillingDate(workspace.trialEndsAt);
    const keepTrial =
      planState(workspace, input.now) === "trial" &&
      trialEndsAt !== null &&
      trialEndsAt.getTime() - input.now.getTime() >= MIN_TRIAL_LEAD_MS;

    // Every session of the customer, any status: the open ones are expired,
    // and the whole list goes into the idempotency key below.
    const listed = await listCheckoutSessions(customer, env);
    const expired: string[] = [];
    for (const stale of listed.filter((s) => s.status === "open")) {
      try {
        await expireCheckoutSession(stale.id, stripeIdempotencyKey(["expire", stale.id]), env);
      } catch (error) {
        // Only an open session can be expired: one paid a moment ago is no
        // longer open, so its subscription may exist already (fix round 2).
        if (!(error instanceof StripeApiError)) throw error;
        const subscriptions = await listCustomerSubscriptions(customer, env).catch(() => []);
        if (subscriptions.some((s) => isLiveSubscriptionStatus(s.status))) {
          return { ok: false, status: 409, error: CHECKOUT_MESSAGES.alreadyPaid };
        }
        throw error;
      }
      expired.push(stale.id);
    }
    // Stripe replays the saved answer for a repeated key, and that answer can
    // be a session expired since. So the key names what this request saw and
    // did: the count and ids of the customer's sessions and the ids it
    // expired (fix round 2). Any session made or expired in between changes
    // the key; two clicks that saw the same sessions and expired none share
    // one key and so one session.
    const seen = `${listed.map((s) => s.id).sort().join(",")}|${expired.sort().join(",")}`;
    const keyParts = [
      "checkout",
      input.workspaceId,
      input.plan,
      `n${listed.length}`,
      crypto.createHash("sha256").update(seen).digest("hex").slice(0, 16),
    ];

    const session = await createCheckoutSession(
      {
        customer,
        priceId,
        workspaceId: input.workspaceId,
        trialEnd: keepTrial ? Math.floor(trialEndsAt!.getTime() / 1000) : null,
        successUrl: `${input.baseUrl}/settings?billing=success#plan`,
        cancelUrl: `${input.baseUrl}/settings#plan`,
      },
      stripeIdempotencyKey(keyParts, CHECKOUT_KEY_BUCKET_MS, input.now.getTime()),
      env,
    );
    if (!session.url) return stripeDown();
    return { ok: true, url: session.url };
  } catch (error) {
    if (!(error instanceof StripeApiError)) throw error;
    logStripeFailure("Starting a checkout", input.workspaceId, error);
    return stripeDown();
  }
}

/** The customer portal for the workspace's Stripe customer; refused when it has none. */
export async function openPortal(
  input: { workspaceId: string; now: Date; baseUrl: string },
  env: BillingEnv = process.env,
): Promise<CheckoutResult> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { stripeCustomerId: true },
  });
  if (!workspace?.stripeCustomerId) return { ok: false, status: 409, error: CHECKOUT_MESSAGES.noCustomer };

  try {
    const session = await createPortalSession(
      { customer: workspace.stripeCustomerId, returnUrl: `${input.baseUrl}/settings#plan` },
      stripeIdempotencyKey(["portal", input.workspaceId], PORTAL_KEY_BUCKET_MS, input.now.getTime()),
      env,
    );
    return { ok: true, url: session.url };
  } catch (error) {
    if (!(error instanceof StripeApiError)) throw error;
    logStripeFailure("Opening the customer portal", input.workspaceId, error);
    return stripeDown();
  }
}
