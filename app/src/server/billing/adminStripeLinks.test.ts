import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { workspace: { findUnique: m.findUnique } } }));

import { stripeLinkFlags } from "./adminStripeLinks";

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
