import type { BillingEnv } from "@/lib/billing";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

/**
 * Every call the app makes to Stripe (21b, 2026-11-10), and the only place a
 * Stripe URL is built. No SDK: form-encoded bodies, the secret key as a bearer
 * token, one pinned API version, and an idempotency key on every POST, so a
 * double click or a retry creates one object.
 *
 * The secret is read from the environment per call and only ever goes into
 * the Authorization header: never a URL, a body, an error or a log line.
 *
 * Fields relied on are the ones documented for STRIPE_API_VERSION; the
 * report for 21b lists each one with its page.
 */

/** Pinned so a change to the account's default version cannot change these shapes. */
export const STRIPE_API_VERSION = "2026-10-28.endive";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

/** Webhook handling and page renders wait on these calls, so they must not hang. */
export const STRIPE_TIMEOUT_MS = 10_000;

/** A Stripe refusal or an unreachable Stripe. `status` 0 means no answer arrived. */
export class StripeApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly type: string | null;

  constructor(message: string, status: number, code: string | null = null, type: string | null = null) {
    super(message);
    this.name = "StripeApiError";
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

export type StripeId = string | { id: string };

/** The Subscription fields the app reads. */
export interface StripeSubscription {
  id: string;
  status: string;
  customer: StripeId;
  metadata?: Record<string, string> | null;
  trial_end?: number | null;
  cancel_at_period_end?: boolean;
  /** A set date the subscription will be cancelled at. */
  cancel_at?: number | null;
  /** Unix seconds: when it was created, ended and (last) cancelled; they rank candidates. */
  created?: number;
  ended_at?: number | null;
  canceled_at?: number | null;
  items?: {
    data: Array<{
      price?: { id: string } | null;
      // In this API version the period lives on each item, not the subscription.
      current_period_start?: number | null;
      current_period_end?: number | null;
    }>;
  };
}

export interface StripePrice {
  id: string;
  unit_amount: number | null;
  currency: string;
  recurring?: { interval: string; interval_count: number } | null;
}

type FormValue = string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue };

/** Stripe's form encoding: nested keys in brackets, arrays by index; null and undefined are left out. */
export function encodeForm(params: Record<string, FormValue>): URLSearchParams {
  const form = new URLSearchParams();
  const add = (key: string, value: FormValue) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => add(`${key}[${index}]`, item));
    } else if (typeof value === "object") {
      for (const [child, childValue] of Object.entries(value)) add(`${key}[${child}]`, childValue);
    } else {
      form.append(key, String(value));
    }
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return form;
}

/**
 * An idempotency key from what the request is for. With `bucketMs`, the
 * current time slice is part of it, so repeats within the slice are one
 * request and a later, deliberate retry is a new one. Stripe keeps a key for
 * at least 24 hours and refuses the same key with different parameters.
 */
export function stripeIdempotencyKey(parts: string[], bucketMs?: number, now: number = Date.now()): string {
  const all = bucketMs ? [...parts, String(Math.floor(now / bucketMs))] : parts;
  return `vs-${all.join("-")}`.slice(0, 255);
}

function secretKey(env: BillingEnv): string {
  const secret = env.STRIPE_SECRET_KEY?.trim();
  if (!secret) throw new StripeApiError("Stripe is not configured", 0);
  return secret;
}

/**
 * Runs one Stripe call, headers and body read together, within `limitMs`.
 * fetchWithTimeout bounds only the wait for headers; this signal, passed as
 * the request's own signal, bounds the whole request including the body, so
 * a caller can add up its calls' limits (the webhook holds a row lock across
 * them).
 */
async function withCallDeadline<T>(limitMs: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limitMs);
  try {
    return await call(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function stripeRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  options: {
    form?: URLSearchParams;
    query?: URLSearchParams;
    idempotencyKey?: string;
    env: BillingEnv;
    /** Shorter than the default when the caller has a budget of its own. */
    timeoutMs?: number;
  },
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey(options.env)}`,
    "Stripe-Version": STRIPE_API_VERSION,
  };
  if (options.form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  const url = `${STRIPE_API_BASE}${path}${options.query ? `?${options.query.toString()}` : ""}`;
  const limitMs = Math.max(1, Math.min(options.timeoutMs ?? STRIPE_TIMEOUT_MS, STRIPE_TIMEOUT_MS));
  const { response, body } = await withCallDeadline(limitMs, async (signal) => {
    let answer: Response;
    try {
      answer = await fetchWithTimeout(
        url,
        { method, headers, body: options.form ? options.form.toString() : undefined, cache: "no-store", signal },
        limitMs,
      );
    } catch (error) {
      // The cause can carry the request; only its name is kept.
      throw new StripeApiError(`Stripe could not be reached (${error instanceof Error ? error.name : "error"})`, 0);
    }
    let parsed: unknown = null;
    try {
      parsed = await answer.json();
    } catch {
      parsed = null;
    }
    if (signal.aborted) throw new StripeApiError(`Stripe took longer than ${limitMs} ms`, 0);
    return { response: answer, body: parsed };
  });

  if (!response.ok) {
    // Stripe's message can quote what was sent (an email address), so only its code is kept.
    const detail = (body as { error?: { code?: string; type?: string } } | null)?.error;
    throw new StripeApiError(
      `Stripe answered ${response.status}${detail?.code ? ` (${detail.code})` : ""}`,
      response.status,
      detail?.code ?? null,
      detail?.type ?? null,
    );
  }
  if (!body || typeof body !== "object") {
    throw new StripeApiError("Stripe answered with no readable body", response.status);
  }
  return body as T;
}

const segment = (id: string) => encodeURIComponent(id);

/** POST /v1/customers: the workspace's customer, carrying the workspace id and the owner's email. */
export function createCustomer(
  input: { workspaceId: string; email: string },
  idempotencyKey: string,
  env: BillingEnv = process.env,
): Promise<{ id: string }> {
  return stripeRequest("POST", "/customers", {
    form: encodeForm({ email: input.email, metadata: { workspaceId: input.workspaceId } }),
    idempotencyKey,
    env,
  });
}

/** POST /v1/checkout/sessions in subscription mode, for one plan's price. */
export function createCheckoutSession(
  input: {
    customer: string;
    priceId: string;
    workspaceId: string;
    /** Unix seconds; Stripe needs it at least 48 hours ahead. Null: no trial. */
    trialEnd: number | null;
    successUrl: string;
    cancelUrl: string;
  },
  idempotencyKey: string,
  env: BillingEnv = process.env,
): Promise<{ id: string; url: string | null }> {
  return stripeRequest("POST", "/checkout/sessions", {
    form: encodeForm({
      mode: "subscription",
      customer: input.customer,
      line_items: [{ price: input.priceId, quantity: 1 }],
      client_reference_id: input.workspaceId,
      subscription_data: { metadata: { workspaceId: input.workspaceId }, trial_end: input.trialEnd },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    }),
    idempotencyKey,
    env,
  });
}

/** POST /v1/billing_portal/sessions: the customer portal, with the account's default configuration. */
export function createPortalSession(
  input: { customer: string; returnUrl: string },
  idempotencyKey: string,
  env: BillingEnv = process.env,
): Promise<{ id: string; url: string }> {
  return stripeRequest("POST", "/billing_portal/sessions", {
    form: encodeForm({ customer: input.customer, return_url: input.returnUrl }),
    idempotencyKey,
    env,
  });
}

/** GET /v1/subscriptions/:id: what Stripe says about the subscription now. */
export function retrieveSubscription(
  id: string,
  env: BillingEnv = process.env,
  timeoutMs?: number,
): Promise<StripeSubscription> {
  return stripeRequest("GET", `/subscriptions/${segment(id)}`, { env, timeoutMs });
}

/** GET /v1/subscriptions?customer=&status=all: every subscription of the customer, ended ones included. */
export async function listCustomerSubscriptions(
  customer: string,
  env: BillingEnv = process.env,
  timeoutMs?: number,
): Promise<StripeSubscription[]> {
  const list = await stripeRequest<{ data: StripeSubscription[] }>("GET", "/subscriptions", {
    query: new URLSearchParams({ customer, status: "all", limit: "100" }),
    env,
    timeoutMs,
  });
  return list.data;
}

/** The webhook reads at most this many pages of 100 subscriptions. */
export const SUBSCRIPTION_LIST_MAX_PAGES = 3;

/**
 * Every subscription of the customer, following has_more with starting_after
 * for at most SUBSCRIPTION_LIST_MAX_PAGES pages. `complete` is false when
 * Stripe had more than that.
 */
export async function listAllCustomerSubscriptions(
  customer: string,
  env: BillingEnv = process.env,
  timeoutMs?: number,
): Promise<{ data: StripeSubscription[]; complete: boolean }> {
  const data: StripeSubscription[] = [];
  let startingAfter: string | null = null;
  for (let page = 0; page < SUBSCRIPTION_LIST_MAX_PAGES; page++) {
    const query = new URLSearchParams({ customer, status: "all", limit: "100" });
    if (startingAfter) query.set("starting_after", startingAfter);
    const list: { data: StripeSubscription[]; has_more?: boolean } = await stripeRequest("GET", "/subscriptions", {
      query,
      env,
      timeoutMs,
    });
    data.push(...list.data);
    if (!list.has_more || list.data.length === 0) return { data, complete: true };
    startingAfter = list.data[list.data.length - 1].id;
  }
  return { data, complete: false };
}

/** DELETE /v1/subscriptions/:id: cancels now. Stripe ignores idempotency keys on DELETE. */
export function cancelSubscription(
  id: string,
  env: BillingEnv = process.env,
  timeoutMs?: number,
): Promise<StripeSubscription> {
  return stripeRequest("DELETE", `/subscriptions/${segment(id)}`, { env, timeoutMs });
}

/** GET /v1/prices/:id: the amount Settings shows. */
export function retrievePrice(id: string, env: BillingEnv = process.env): Promise<StripePrice> {
  return stripeRequest("GET", `/prices/${segment(id)}`, { env });
}

/** GET /v1/checkout/sessions?customer=: the customer's Checkout sessions of every status, newest first, at most 100. */
export async function listCheckoutSessions(
  customer: string,
  env: BillingEnv = process.env,
): Promise<Array<{ id: string; status: string }>> {
  const list = await stripeRequest<{ data: Array<{ id: string; status: string }> }>("GET", "/checkout/sessions", {
    query: new URLSearchParams({ customer, limit: "100" }),
    env,
  });
  return list.data;
}

/** POST /v1/checkout/sessions/:id/expire: only an open session can be expired; anything else is an error. */
export function expireCheckoutSession(
  id: string,
  idempotencyKey: string,
  env: BillingEnv = process.env,
): Promise<{ id: string; status: string }> {
  return stripeRequest("POST", `/checkout/sessions/${segment(id)}/expire`, { idempotencyKey, env });
}
