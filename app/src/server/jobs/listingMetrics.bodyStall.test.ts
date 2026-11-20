import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";
import { abortSignalTimeoutOnFakeClock, bodyNeverEnds } from "@/lib/stallingFetch.testkit";

// R48 platform L2: the listing-numbers read's limit covers the body too. A
// stalled body is that listing's failure: it is stamped like any other failure
// (so it goes behind the others next time) and the sync goes on to the next.
// The real fetch helpers run here over a stubbed global fetch; no database.

// A missing bound must be a quick red test, never a hung run.
const STALL_TEST_TIMEOUT_MS = 5_000;

const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  upsert: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
}));
const loggerMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { findMany: db.findMany, findUnique: db.findUnique, update: vi.fn() },
    locationMetricDaily: { findFirst: db.findFirst, upsert: db.upsert },
    $transaction: db.transaction,
    $executeRaw: db.executeRaw,
  },
}));
vi.mock("@/lib/logger", () => ({ logger: loggerMock }));
vi.mock("@/server/platforms/gbpLocation", () => ({
  resolveGbpLocationName: async (_token: string, name: string) => name,
}));

import { LISTING_METRICS_TIMEOUT_MS, syncListingMetrics } from "./listingMetrics";

const NOW = new Date("2026-11-10T09:30:00.000Z");

function row(id: string, location: string) {
  return {
    id,
    workspaceId: `ws-${id}`,
    platform: "google_business_profile",
    accessToken: "gbp-access",
    refreshToken: "gbp-refresh",
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    needsReconnect: false,
    metadata: { locationName: location },
  };
}

const answer = {
  multiDailyMetricTimeSeries: [
    {
      dailyMetricTimeSeries: [
        {
          dailyMetric: "CALL_CLICKS",
          timeSeries: { datedValues: [{ date: { year: 2026, month: 11, day: 9 }, value: "1" }] },
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  abortSignalTimeoutOnFakeClock();
  const rows = [row("c-stall", "accounts/1/locations/22"), row("c-ok", "accounts/1/locations/33")];
  db.findMany.mockResolvedValue(rows.map((r) => ({ id: r.id, metadata: r.metadata })));
  db.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null);
  db.findFirst.mockResolvedValue({ day: new Date("2026-11-09T00:00:00.000Z") });
  db.upsert.mockImplementation((args: unknown) => args);
  db.transaction.mockImplementation(async (ops: unknown[]) => ops);
  db.executeRaw.mockResolvedValue(1);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const mock of [...Object.values(db), ...Object.values(loggerMock)]) mock.mockReset();
});

describe("syncListingMetrics: a listing whose answer never ends", () => {
  it("counts it as failed within the limit, stamps it, and reads the next listing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL, init?: RequestInit) =>
        String(input).includes("/locations/22:")
          ? bodyNeverEnds(input, init)
          : Promise.resolve(new Response(JSON.stringify(answer), { status: 200 })),
      ),
    );

    const settled = syncListingMetrics(NOW, () => 0).then(
      (value) => value,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(LISTING_METRICS_TIMEOUT_MS);
    const out = await Promise.race([settled, Promise.resolve("still waiting")]);

    expect(out).toEqual({ connections: 2, checked: 2, skipped: 0, failed: 1, left: 0, days: 1 });
    expect(JSON.stringify(loggerMock.warn.mock.calls)).toContain(FETCH_TIMEOUT_CODE);
    // Both stamped: the stalled one goes behind the others on the next run.
    const stamped = db.executeRaw.mock.calls.map((call) => call[3]);
    expect(stamped).toEqual(["c-stall", "c-ok"]);
  }, STALL_TEST_TIMEOUT_MS);
});
