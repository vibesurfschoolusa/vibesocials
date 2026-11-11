import type { BillingEnv } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { sendEmail } from "@/server/notifications/email";

import { buildPaymentFailedEmail } from "./billingEmails";
import {
  listCustomerSubscriptions,
  retrieveSubscription,
  StripeApiError,
  type StripeId,
  type StripeSubscription,
} from "./stripeApi";
import { isLiveSubscriptionStatus, stripeIdOf, subscriptionWrite, type CheckoutClaim } from "./subscriptionSync";

/**
 * What POST /api/webhooks/stripe does with an event whose signature has been
 * verified (21b). Returns the status to answer: 200 when handled or ignored,
 * 400 for a body that is not an event, 500 when Stripe should send it again.
 *
 * Stripe sends events more than once and out of order, so an event's payload
 * is never trusted for a subscription's state: it gives only the subscription
 * id, and the subscription is fetched from Stripe now. The fetch (and the
 * failed-payment emails) come first; then one transaction records the event id
 * in StripeEvent and writes the workspace. The insert skips an id already
 * there, and then nothing is written. Anything that throws before the commit
 * leaves the event unrecorded and answers 500.
 */

type StripeEventBody = {
  id: string;
  type: string;
  /** When Stripe created the event; orders two deliveries that commit out of order. */
  createdAt: Date | null;
  data: { object: Record<string, unknown> };
};

/** Statuses that end a plan for the workspace (planState reads them as ended). */
const ENDED_FOR_THE_WORKSPACE = new Set(["canceled", "unpaid", "incomplete_expired"]);

const SNAPSHOT_REQUIRED =
  "[stripe webhook] Event without a usable object: the endpoint must send snapshot payloads, not thin ones";

/** Prisma's unique-constraint failure, without importing its runtime class. */
const isUniqueCollision = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

/** A failed-payment notice is keyed on the invoice, whichever event carried it. */
const paymentFailedMarker = (invoiceId: string) => `invoice.payment_failed:${invoiceId}`;

function asEvent(value: unknown): StripeEventBody | null {
  if (!value || typeof value !== "object") return null;
  const event = value as { id?: unknown; type?: unknown; created?: unknown; data?: { object?: unknown } };
  if (typeof event.id !== "string" || !event.id || typeof event.type !== "string" || !event.type) return null;
  const object = event.data?.object;
  const createdAt = typeof event.created === "number" && Number.isFinite(event.created) ? new Date(event.created * 1000) : null;
  return {
    id: event.id,
    type: event.type,
    createdAt,
    data: { object: object && typeof object === "object" ? (object as Record<string, unknown>) : {} },
  };
}

const errorFields = (error: unknown) =>
  error instanceof StripeApiError
    ? { name: error.name, status: error.status, code: error.code }
    : { name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) };

/** Records the ids; true when the event's own id was new. */
async function record(
  tx: Pick<typeof prisma, "stripeEvent">,
  event: StripeEventBody,
  extra: Array<{ id: string; type: string }> = [],
): Promise<boolean> {
  const { count } = await tx.stripeEvent.createMany({ data: [{ id: event.id, type: event.type }], skipDuplicates: true });
  if (extra.length > 0) await tx.stripeEvent.createMany({ data: extra, skipDuplicates: true });
  return count === 1;
}

async function recordOnly(event: StripeEventBody): Promise<200 | 500> {
  try {
    await prisma.$transaction((tx) => record(tx, event));
    return 200;
  } catch (error) {
    logger.error("[stripe webhook] Could not record an event", { eventId: event.id, type: event.type, error: errorFields(error) });
    return 500;
  }
}

async function syncSubscription(
  event: StripeEventBody,
  subscriptionId: string,
  claim: CheckoutClaim | null,
  env: BillingEnv,
): Promise<200 | 500> {
  let subscription: StripeSubscription;
  try {
    subscription = await retrieveSubscription(subscriptionId, env);
  } catch (error) {
    logger.error("[stripe webhook] Could not fetch the subscription; Stripe will send the event again", {
      eventId: event.id,
      type: event.type,
      error: errorFields(error),
    });
    return 500;
  }

  // The customer's other subscriptions. A customer should never have two
  // live plans, so more than one is logged for the operator (fix round 1).
  // And when this one has ended while another live one names the same
  // workspace, the workspace takes the live one (fix round 2), so cancelling
  // the extra plan cannot end a workspace that is still paying. Not reading
  // the list leaves the write as it would have been.
  let liveSubscriptions: number | null = null;
  let replacement: StripeSubscription | null = null;
  const ended = ENDED_FOR_THE_WORKSPACE.has(subscription.status);
  const customer = stripeIdOf(subscription.customer);
  if (customer) {
    try {
      const all = await listCustomerSubscriptions(customer, env);
      liveSubscriptions = all.filter((s) => isLiveSubscriptionStatus(s.status)).length;
      const workspaceId = subscription.metadata?.workspaceId;
      if (ended && workspaceId) {
        replacement =
          all.find(
            (s) =>
              s.id !== subscription.id &&
              isLiveSubscriptionStatus(s.status) &&
              !ENDED_FOR_THE_WORKSPACE.has(s.status) &&
              s.metadata?.workspaceId === workspaceId,
          ) ?? null;
      }
    } catch (error) {
      (ended ? logger.error : logger.warn)("[stripe webhook] Could not list the customer's subscriptions", {
        eventId: event.id,
        error: errorFields(error),
      });
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (!(await record(tx, event))) return;

      const workspaceId = subscription.metadata?.workspaceId;
      const workspace = workspaceId
        ? await tx.workspace.findUnique({
            where: { id: workspaceId },
            select: {
              id: true,
              stripeCustomerId: true,
              stripeSubscriptionId: true,
              billingExempt: true,
              stripeLastEventAt: true,
            },
          })
        : null;
      // Only in place of the subscription the workspace is using; an ended
      // extra one changes nothing either way.
      const chosen = replacement && workspace?.stripeSubscriptionId === subscription.id ? replacement : subscription;
      const result = subscriptionWrite(chosen, workspace, claim, env, event.createdAt);
      if (!result.ok) {
        const log = result.level === "error" ? logger.error : logger.info;
        log("[stripe webhook] Subscription not written", {
          eventId: event.id,
          type: event.type,
          workspaceId: workspaceId ?? null,
          reason: result.reason,
        });
        return;
      }
      await tx.workspace.update({ where: { id: workspace!.id }, data: result.data });
      if (liveSubscriptions !== null && liveSubscriptions > 1) {
        logger.error("[stripe webhook] The customer has more than one live subscription; cancel the extra one in Stripe", {
          eventId: event.id,
          workspaceId: workspace!.id,
          liveSubscriptions,
          storedSubscriptionId: workspace!.stripeSubscriptionId,
          usingSubscriptionId: result.data.stripeSubscriptionId,
        });
      }
      for (const warning of result.warnings) {
        logger.error("[stripe webhook] Subscription written onto an exempt workspace", {
          eventId: event.id,
          workspaceId: workspace!.id,
          reason: warning,
        });
      }
    });
    return 200;
  } catch (error) {
    if (isUniqueCollision(error)) {
      // Another workspace already holds this Stripe id: every retry would fail
      // the same way for days, so answer 200 and leave it to the operator.
      logger.error("[stripe webhook] A Stripe id in this subscription is already on another workspace (unique column); not written", {
        eventId: event.id,
        type: event.type,
        target: (error as { meta?: { target?: unknown } }).meta?.target ?? null,
      });
      return 200;
    }
    logger.error("[stripe webhook] Could not write the subscription; Stripe will send the event again", {
      eventId: event.id,
      type: event.type,
      error: errorFields(error),
    });
    return 500;
  }
}

async function notifyPaymentFailed(event: StripeEventBody): Promise<200 | 500> {
  const invoiceId = typeof event.data.object.id === "string" ? event.data.object.id : null;
  const customer = stripeIdOf(event.data.object.customer as StripeId | null | undefined);
  if (!invoiceId || !customer) {
    logger.error(SNAPSHOT_REQUIRED, { eventId: event.id, type: event.type });
    return recordOnly(event);
  }
  const marker = paymentFailedMarker(invoiceId);

  try {
    if (await prisma.stripeEvent.findUnique({ where: { id: marker } })) return recordOnly(event);

    const workspace = await prisma.workspace.findUnique({
      where: { stripeCustomerId: customer },
      select: {
        id: true,
        name: true,
        members: { where: { role: "owner" }, select: { userId: true, user: { select: { email: true } } } },
      },
    });
    if (!workspace) {
      logger.error("[stripe webhook] invoice.payment_failed for a customer no workspace has", { eventId: event.id });
      return recordOnly(event);
    }

    // Sent before the event is recorded, so a failed send is sent again with
    // Stripe's retry; the per-invoice key stops Resend sending one twice.
    const email = buildPaymentFailedEmail({ workspaceName: workspace.name });
    for (const owner of workspace.members) {
      await sendEmail(
        { to: owner.user.email, ...email },
        { idempotencyKey: `stripe-payment-failed/${invoiceId}/${owner.userId}`, throwOnRetryable: true },
      );
    }

    await prisma.$transaction((tx) => record(tx, event, [{ id: marker, type: "invoice.payment_failed.notice" }]));
    return 200;
  } catch (error) {
    logger.error("[stripe webhook] Could not send the failed-payment email; Stripe will send the event again", {
      eventId: event.id,
      error: errorFields(error),
    });
    return 500;
  }
}

export async function handleStripeEvent(body: unknown, env: BillingEnv = process.env): Promise<200 | 400 | 500> {
  const event = asEvent(body);
  if (!event) return 400;

  try {
    // Saves a Stripe fetch on a repeat; the insert in the transaction is what decides.
    if (await prisma.stripeEvent.findUnique({ where: { id: event.id } })) return 200;
  } catch (error) {
    logger.error("[stripe webhook] Could not read the event table", { eventId: event.id, error: errorFields(error) });
    return 500;
  }

  const object = event.data.object;
  const handled =
    event.type === "checkout.session.completed" ||
    event.type.startsWith("customer.subscription.") ||
    event.type === "invoice.payment_failed";
  if (handled && typeof object.id !== "string") {
    // A thin payload names the object elsewhere; there is nothing to fetch.
    logger.error(SNAPSHOT_REQUIRED, { eventId: event.id, type: event.type });
    return recordOnly(event);
  }
  if (event.type === "checkout.session.completed") {
    const subscriptionId = stripeIdOf(object.subscription as StripeId | null | undefined);
    if (object.mode !== "subscription" || !subscriptionId) return recordOnly(event);
    const claim: CheckoutClaim = {
      workspaceId: typeof object.client_reference_id === "string" ? object.client_reference_id : null,
      customer: stripeIdOf(object.customer as StripeId | null | undefined),
      subscription: subscriptionId,
    };
    return syncSubscription(event, subscriptionId, claim, env);
  }
  if (event.type.startsWith("customer.subscription.")) {
    const subscriptionId = typeof object.id === "string" ? object.id : null;
    if (!subscriptionId) return recordOnly(event);
    return syncSubscription(event, subscriptionId, null, env);
  }
  if (event.type === "invoice.payment_failed") return notifyPaymentFailed(event);
  return recordOnly(event);
}
