import { beforeEach, describe, expect, it, vi } from "vitest";

// The cron's wiring only: the sync has its own suite (socialMetricsSync.test.ts).
// No database, platform or Inngest is reached.
const { syncMock } = vi.hoisted(() => ({ syncMock: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));
vi.mock("@/server/jobs/socialMetricsSync", () => ({ syncSocialPostMetrics: syncMock }));

import { inngestFunctions, socialPostMetricsSync, youtubePostMetricsSync } from "./inngest-functions";

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

function registeredTriggers(fn: unknown, id: string): unknown {
  const { getConfig } = fn as {
    getConfig(opts: { baseUrl: URL; appPrefix: string }): Array<{ id: string; triggers: unknown }>;
  };
  return getConfig
    .call(fn, { baseUrl: new URL("https://app.example/api/inngest"), appPrefix: "vibe-socials" })
    .find((config) => config.id === `vibe-socials-${id}`)?.triggers;
}

beforeEach(() => {
  syncMock.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("socialPostMetricsSync (social-post-metrics-sync)", () => {
  it("is registered with its id, runs daily at 10:45 UTC, and skips a run while one is going", () => {
    expect(inngestFunctions).toContain(socialPostMetricsSync);
    const opts = (socialPostMetricsSync as unknown as { opts: { id: string; singleton?: unknown } }).opts;
    expect(opts.id).toBe("social-post-metrics-sync");
    expect(opts.singleton).toEqual({ mode: "skip" });
    expect(registeredTriggers(socialPostMetricsSync, "social-post-metrics-sync")).toEqual([{ cron: "45 10 * * *" }]);
  });

  it("runs the sync in one step and returns its counts", async () => {
    const counts = {
      selected: 3,
      attempted: 3,
      updated: 2,
      notFound: 1,
      errors: 0,
      skippedConnections: 0,
      left: 0,
      rateLimitedPlatforms: 0,
    };
    syncMock.mockResolvedValue(counts);
    const step = fakeStep();

    const handler = (socialPostMetricsSync as unknown as { fn: (args: unknown) => Promise<unknown> }).fn;
    const result = await handler({ event: {}, step, runId: "run-1" });

    expect(step.order).toEqual(["sync"]);
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncMock.mock.calls[0][0]).toBeInstanceOf(Date);
    expect(result).toEqual(counts);
  });

  it("leaves the hourly YouTube function as it was", () => {
    expect(registeredTriggers(youtubePostMetricsSync, "youtube-post-metrics-sync")).toEqual([{ cron: "0 * * * *" }]);
  });
});
