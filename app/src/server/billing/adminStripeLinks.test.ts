import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { workspace: { findUnique: m.findUnique } } }));

import { periodEndLabel, stripeLinkFlags } from "./adminStripeLinks";

beforeEach(() => {
  m.findUnique.mockReset();
});

describe("stripeLinkFlags", () => {
  it("says yes or no for each Stripe id, never the id", async () => {
    m.findUnique.mockResolvedValue({ stripeCustomerId: "cus_secret_looking", stripeSubscriptionId: null });
    const flags = await stripeLinkFlags("ws_1");
    expect(flags).toEqual({ hasCustomer: true, hasSubscription: false });
    expect(JSON.stringify(flags)).not.toContain("cus_");
    expect(m.findUnique).toHaveBeenCalledWith({
      where: { id: "ws_1" },
      select: { stripeCustomerId: true, stripeSubscriptionId: true },
    });
  });

  it("no workspace: both no", async () => {
    m.findUnique.mockResolvedValue(null);
    expect(await stripeLinkFlags("ws_1")).toEqual({ hasCustomer: false, hasSubscription: false });
  });
});

/** Fix round 2: for past_due the stored date is the end of the last paid period. */
describe("periodEndLabel", () => {
  it("says Last paid period ended for past_due, Period ends otherwise", () => {
    expect(periodEndLabel("past_due")).toBe("Last paid period ended");
    for (const status of ["active", "trialing", "canceled", null]) expect(periodEndLabel(status)).toBe("Period ends");
  });
});
