/**
 * UI audit (task A2): a stand-in for Stripe's price reads, for the billing
 * pass only. Loaded into that pass's processes with
 * NODE_OPTIONS=--import=<this file> (.github/workflows/ui-audit.yml), so it
 * wraps globalThis.fetch before Next loads; Next's own fetch patch then wraps
 * this one.
 *
 * It answers only GET https://api.stripe.com/v1/prices/<id> for the six dummy
 * price ids the pass sets, with the fields src/server/billing/planPrices.ts
 * reads. Every other request goes to the real fetch unchanged, so checkout and
 * portal calls are still refused by Stripe, as before.
 */

const PRICES = {
  price_dummy_ui_audit_starter: [1900, "month"],
  price_dummy_ui_audit_starter_yearly: [19000, "year"],
  price_dummy_ui_audit_growth: [3900, "month"],
  price_dummy_ui_audit_growth_yearly: [39000, "year"],
  price_dummy_ui_audit_pro: [7900, "month"],
  price_dummy_ui_audit_pro_yearly: [79000, "year"],
};

const PREFIX = "https://api.stripe.com/v1/prices/";
const realFetch = globalThis.fetch;

function addressOf(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input?.url ?? "";
}

function methodOf(input, init) {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

globalThis.fetch = function uiAuditStripeStub(input, init) {
  const address = addressOf(input);
  if (address.startsWith(PREFIX) && methodOf(input, init) === "GET") {
    const id = decodeURIComponent(address.slice(PREFIX.length).split(/[?#]/)[0]);
    const price = Object.hasOwn(PRICES, id) ? PRICES[id] : null;
    if (price) {
      const [amount, interval] = price;
      const body = {
        id,
        object: "price",
        active: true,
        unit_amount: amount,
        currency: "usd",
        recurring: { interval, interval_count: 1 },
      };
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
      );
    }
  }
  return realFetch(input, init);
};
