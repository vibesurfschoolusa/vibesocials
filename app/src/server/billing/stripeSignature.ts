import crypto from "node:crypto";

/**
 * Stripe webhook signatures, verified by hand as Stripe documents
 * (https://docs.stripe.com/webhooks#verify-manually). The Stripe-Signature
 * header is comma-separated `key=value` entries in any order: one `t` (the
 * signing time, Unix seconds) and one or more `v1` (hex HMAC-SHA256 of
 * `${t}.${raw body}` with the endpoint's secret; several while a rolled
 * secret is still active). `v0` and the debug entries (secret, destination,
 * payload) are not covered by the HMAC and are ignored.
 */

/** Stripe's libraries default to 5 minutes; a timestamp further from now either way is refused. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!header || !secret) return false;

  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const entry of header.split(",")) {
    const at = entry.indexOf("=");
    if (at <= 0) continue;
    const key = entry.slice(0, at).trim();
    const value = entry.slice(at + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") signatures.push(value);
  }
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;

  const expected = Buffer.from(
    crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex"),
    "utf8",
  );
  // Every candidate is compared, so the time taken does not say which one matched.
  let matched = false;
  for (const signature of signatures) {
    const given = Buffer.from(signature, "utf8");
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) matched = true;
  }
  if (!matched) return false;

  return Math.abs(nowSeconds - Number(timestamp)) <= STRIPE_SIGNATURE_TOLERANCE_SECONDS;
}
