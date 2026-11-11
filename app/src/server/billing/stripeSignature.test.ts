import crypto from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { STRIPE_SIGNATURE_TOLERANCE_SECONDS, verifyStripeSignature } from "./stripeSignature";

const SECRET = "whsec_example";
const NOW = 1798765432;
const BODY = '{\n  "id": "evt_example",\n  "object": "event",\n  "type": "customer.subscription.updated"\n}';

/** Stripe's documented recipe, written out independently: HMAC-SHA256 of "t.body", hex. */
function sign(body: string, t: number, secret = SECRET): string {
  return crypto.createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyStripeSignature", () => {
  it("accepts the documented header shape (t, v1, v1, v0 and the debug entries)", () => {
    const header = [
      `t=${NOW}`,
      `v1=${sign(BODY, NOW, "whsec_old_example")}`,
      `v1=${sign(BODY, NOW)}`,
      `v0=6ffbb59b2300aae63f272406069a9788598b792a944a07aba816edb039989a39`,
      "secret=whsec_****************************PzVt",
      "destination=we_example",
      "payload=a25aefc6",
    ].join(",");
    expect(verifyStripeSignature(BODY, header, SECRET, NOW)).toBe(true);
  });

  it("accepts a fixed vector, so the recipe itself is pinned", () => {
    // Computed once from the recipe above for t=1798765432, BODY and whsec_example.
    const v1 = "8fbaa558a040c9f279404a87da8d91b0d86cf9100a7d8f283ebe5e790cec88e6";
    expect(sign(BODY, NOW)).toBe(v1);
    expect(verifyStripeSignature(BODY, `t=${NOW},v1=${v1}`, SECRET, NOW)).toBe(true);
  });

  it("refuses a signature made with another secret", () => {
    expect(verifyStripeSignature(BODY, `t=${NOW},v1=${sign(BODY, NOW, "whsec_other")}`, SECRET, NOW)).toBe(false);
  });

  it("refuses a changed body", () => {
    const header = `t=${NOW},v1=${sign(BODY, NOW)}`;
    expect(verifyStripeSignature(BODY.replace("updated", "deleted"), header, SECRET, NOW)).toBe(false);
  });

  it("signs the raw body: the same JSON serialised again fails", () => {
    const header = `t=${NOW},v1=${sign(BODY, NOW)}`;
    const reserialised = JSON.stringify(JSON.parse(BODY));
    expect(reserialised).not.toBe(BODY);
    expect(verifyStripeSignature(reserialised, header, SECRET, NOW)).toBe(false);
  });

  it("refuses a missing or empty header", () => {
    expect(verifyStripeSignature(BODY, null, SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(BODY, "", SECRET, NOW)).toBe(false);
  });

  it("refuses a header with no timestamp, a bad timestamp, or no v1", () => {
    const v1 = sign(BODY, NOW);
    expect(verifyStripeSignature(BODY, `v1=${v1}`, SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(BODY, `t=abc,v1=${v1}`, SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(BODY, `t=${NOW}`, SECRET, NOW)).toBe(false);
  });

  it("never accepts a v0 signature, even a correct one", () => {
    expect(verifyStripeSignature(BODY, `t=${NOW},v0=${sign(BODY, NOW)}`, SECRET, NOW)).toBe(false);
  });

  it("accepts any one matching v1 among several", () => {
    const header = `t=${NOW},v1=${"0".repeat(64)},v1=short,v1=${sign(BODY, NOW)}`;
    expect(verifyStripeSignature(BODY, header, SECRET, NOW)).toBe(true);
  });

  it("refuses a timestamp more than 5 minutes old or ahead, and accepts one at the edge", () => {
    expect(STRIPE_SIGNATURE_TOLERANCE_SECONDS).toBe(300);
    const at = (t: number) => verifyStripeSignature(BODY, `t=${t},v1=${sign(BODY, t)}`, SECRET, NOW);
    expect(at(NOW - 301)).toBe(false);
    expect(at(NOW + 301)).toBe(false);
    expect(at(NOW - 300)).toBe(true);
    expect(at(NOW + 300)).toBe(true);
  });

  it("compares with crypto.timingSafeEqual", () => {
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    verifyStripeSignature(BODY, `t=${NOW},v1=${sign(BODY, NOW)}`, SECRET, NOW);
    expect(spy).toHaveBeenCalled();
  });

  it("refuses without a secret", () => {
    expect(verifyStripeSignature(BODY, `t=${NOW},v1=${sign(BODY, NOW, "")}`, "", NOW)).toBe(false);
  });
});
