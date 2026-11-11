import type { BillingEnv } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { sendEmail } from "@/server/notifications/email";

import { buildPaymentFailedEmail } from "./billingEmails";
import { reportDuplicatePriceIds } from "./priceConfig";
import {
  listAllCustomerSubscriptions,
  retrieveSubscription,
  StripeApiError,
  type StripeId,
  type StripeSubscription,
} from "./stripeApi";
import { isInUse, stripeIdOf, syncFromCustomerList, type CheckoutClaim } from "./subscriptionSync";

/**
 * What POST /api/webhooks/stripe does with an event whose signature has been
 * verified (21b). Returns the status to answer: 200 when handled or ignored,
 * 400 for a body that is not an event, 500 when Stripe should send it again.
 *
 * Stripe sends events more than once and out of order, so an event's payload
 * is never trusted for a subscription's state: it gives only the subscription
 * id. For a subscription event (fix round 4):
 *   1. Outside any transaction, the subscription is fetched once only to learn
 *      which workspace its metadata names.
 *   2. One transaction then locks that workspace's row (FOR NO KEY UPDATE), records
 *      the event id (already there: stop), fetches the subscription again and
 *      lists the customer's subscriptions, and writes what
 *      syncFromCustomerList decides. Handlers for one workspace therefore run
 *      one after another, each reading Stripe while it holds the lock, so the
 *      last one to run writes Stripe's latest state whatever order the events
 *      were created or delivered in.
 * A Stripe or database failure inside rolls everything back, records nothing
 * and answers 500, so Stripe sends the event again.
 */

type StripeEventBody = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

const SNAPSHOT_REQUIRED =
  "[stripe webhook] Event without a usable object: the endpoint must send snapshot payloads, not thin ones";

/**
 * Long enough for the calls made under the lock: one fetch and up to three
 * list pages, each bounded as a whole (headers and body) to 10 seconds by
 * stripeApi, so at most 40 seconds of Stripe. maxWait covers waiting for the
 * connection, not the lock (that wait is inside the timeout).
 */
export const SYNC_TRANSACTION_OPTIONS = { timeout: 50_000, maxWait: 10_000 } as const;

/** Prisma's unique-constraint failure, without importing its runtime class. */
const isUniqueCollision = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

/** A failed-payment notice is keyed on the invoice, whichever event carried it. */
const paymentFailedMarker = (invoiceId: string) => `invoice.payment_failed:${invoiceId}`;

function asEvent(value: unknown): StripeEventBody | null {
  if (!value || typeof value !== "object") return null;
  const event = value as { id?: unknown; type?: unknown; data?: { object?: unknown } };
  if (typeof event.id !== "string" || !event.id || typeof event.type !== "string" || !event.type) return null;
  const object = event.data?.object;
  return {
    id: event.id,
    type: event.type,
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
  reportDuplicatePriceIds("webhook", env);
  // 1. Which workspace: read only to know which row to lock.
  let identified: StripeSubscription;
  try {
    identified = await retrieveSubscription(subscriptionId, env);
  } catch (error) {
    logger.error("[stripe webhook] Could not fetch the subscription; Stripe will send the event again", {
      eventId: event.id,
      type: event.type,
      error: errorFields(error),
    });
    return 500;
  }
  const workspaceId = identified.metadata?.workspaceId;
  if (!workspaceId) {
    logger.error("[stripe webhook] Subscription not written", {
      eventId: event.id,
      type: event.type,
      workspaceId: null,
      reason: "the subscription names no workspace",
    });
    return recordOnly(event);
  }

  // 2. Everything else under the workspace's row lock.
  try {
    await prisma.$transaction(async (tx) => {
      // FOR NO KEY UPDATE, not FOR UPDATE: handlers for this workspace still
      // queue behind each other (and behind updates of the row), but inserts of
      // rows that reference the workspace (a post, a media item, a member) take
      // only FOR KEY SHARE on it and are not blocked while this waits on Stripe.
      await tx.$executeRaw`SELECT 1 FROM "Workspace" WHERE "id" = ${workspaceId} FOR NO KEY UPDATE`;
      if (!(await record(tx, event))) return;

      const workspace = await tx.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, stripeCustomerId: true, stripeSubscriptionId: true, billingExempt: true },
      });

      // Read Stripe now, while no other handler for this workspace can run.
      const subscription = await retrieveSubscription(subscriptionId, env);
      const customer = stripeIdOf(subscription.customer);
      let list: StripeSubscription[] = [];
      let complete = true;
      if (customer) {
        try {
          ({ data: list, complete } = await listAllCustomerSubscriptions(customer, env));
        } catch (error) {
          // An ended subscription's cancel must not be lost to a failed list:
          // it is written from that subscription alone. One in use needs the
          // list (another could rank ahead of it), so the event comes back.
          if (isInUse(subscription.status)) throw error;
          logger.warn("[stripe webhook] Could not list the customer's subscriptions; syncing the ended one alone", {
            eventId: event.id,
            error: errorFields(error),
          });
          list = [subscription];
        }
      }

      const result = syncFromCustomerList(subscription, workspace, claim, list, env, complete);
      for (const { subscriptionId: unknownId, priceId } of result.unconfigured) {
        logger.error("[stripe webhook] A subscription in use has a price that is none of the plan prices; nothing written", {
          eventId: event.id,
          workspaceId,
          subscriptionId: unknownId,
          priceId,
        });
      }
      if (!result.ok) {
        const log = result.level === "error" ? logger.error : logger.info;
        log("[stripe webhook] Subscription not written", {
          eventId: event.id,
          type: event.type,
          workspaceId,
          reason: result.reason,
        });
        return;
      }
      await tx.workspace.update({ where: { id: workspace!.id }, data: result.data });
      if (result.liveCandidateIds.length > 1) {
        logger.error("[stripe webhook] The customer has more than one live subscription; cancel the extra one in Stripe", {
          eventId: event.id,
          workspaceId: workspace!.id,
          liveSubscriptionIds: result.liveCandidateIds,
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
    }, SYNC_TRANSACTION_OPTIONS);
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
    logger.error("[stripe webhook] Could not sync the subscription; Stripe will send the event again", {
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
