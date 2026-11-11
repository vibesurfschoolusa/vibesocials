import { beforeEach, describe, expect, it, vi } from "vitest";

// The cron's wiring only: the sync has its own suite (listingMetrics.test.ts).
// No database, Google or Inngest is reached.
const { syncMock } = vi.hoisted(() => ({ syncMock: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));
vi.mock("@/server/jobs/listingMetrics", () => ({ syncListingMetrics: syncMock }));

import { googleListingMetricsSync, inngestFunctions } from "./inngest-functions";

/** Runs each step inline and JSON-round-trips its output, as Inngest's memoization does. */
function fakeStep() {
  const order: string[] = [];
  return {
    order,
    run: vi.fn(async (id: string, cb: () => unknown) => {
      order.push(id);
      const out = await cb();
      return out === undefined ? undefined : JSON.parse(JSON.stringify(out));
    }),
  };
}

function registeredTriggers(): unknown {
  const { getConfig } = googleListingMetricsSync as unknown as {
    getConfig(opts: { baseUrl: URL; appPrefix: string }): Array<{ id: string; triggers: unknown }>;
  };
  return getConfig
    .call(googleListingMetricsSync, { baseUrl: new URL("https://app.example/api/inngest"), appPrefix: "vibe-socials" })
    .find((config) => config.id === "vibe-socials-google-listing-metrics-sync")?.triggers;
}

beforeEach(() => {
  syncMock.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("googleListingMetricsSync (google-listing-metrics-sync)", () => {
  it("is registered with its id and runs daily at 09:30 UTC", () => {
    expect(inngestFunctions).toContain(googleListingMetricsSync);
    expect((googleListingMetricsSync as unknown as { opts: { id: string } }).opts.id).toBe(
      "google-listing-metrics-sync",
    );
    expect(registeredTriggers()).toEqual([{ cron: "30 9 * * *" }]);
  });

  it("runs the sync in one step and returns its counts", async () => {
    const counts = { connections: 2, checked: 2, skipped: 0, failed: 0, left: 0, days: 20 };
    syncMock.mockResolvedValue(counts);
    const step = fakeStep();

    const handler = (googleListingMetricsSync as unknown as { fn: (args: unknown) => Promise<unknown> }).fn;
    const result = await handler({ event: {}, step, runId: "run-1" });

    expect(step.order).toEqual(["sync"]);
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncMock.mock.calls[0][0]).toBeInstanceOf(Date);
    expect(result).toEqual(counts);
  });
});
