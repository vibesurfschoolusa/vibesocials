import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ logger: m.logger }));

import { reportDuplicatePriceIds } from "./priceConfig";

beforeEach(() => {
  for (const fn of Object.values(m.logger)) fn.mockReset();
});

describe("reportDuplicatePriceIds", () => {
  it("logs one error naming the path and the ids listed under two plans", () => {
    reportDuplicatePriceIds("webhook", {
      STRIPE_PRICE_STARTER: "price_example_shared",
      STRIPE_PRICE_PRO: "price_example_pro, price_example_shared",
    });
    expect(m.logger.error).toHaveBeenCalledTimes(1);
    expect(m.logger.error).toHaveBeenCalledWith(expect.stringContaining("two plans"), {
      path: "webhook",
      priceIds: ["price_example_shared"],
    });
  });

  it("logs nothing when every id is in one list", () => {
    reportDuplicatePriceIds("checkout", { STRIPE_PRICE_STARTER: "a, b", STRIPE_PRICE_PRO: "c" });
    expect(m.logger.error).not.toHaveBeenCalled();
  });
});
