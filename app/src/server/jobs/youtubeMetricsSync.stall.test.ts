import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_FETCH_TIMEOUT_MS } from "@/lib/fetchWithTimeout";
import { abortSignalTimeoutOnFakeClock, bodyNeverEnds } from "@/lib/stallingFetch.testkit";

// A missing bound must be a quick red test, never a hung run.
const STALL_TEST_TIMEOUT_MS = 5_000;

// R47 platform L1: the hourly page refreshes a token through the real
// refreshGoogleToken (fetchWithinLimit). When Google's token endpoint answers
// headers and stalls the body, that workspace counts as errors within the
// limit and the page goes on to the next workspace. No database, no network.
const { selectMock, fetchBatchMock, findUniqueMock, upsertMock, executeRawMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  fetchBatchMock: vi.fn(),
  findUniqueMock: vi.fn(),
  upsertMock: vi.fn(),
  executeRawMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { findUnique: findUniqueMock, update: vi.fn() },
    postMetric: { upsert: upsertMock },
    postJobResult: { updateMany: vi.fn() },
    $executeRaw: executeRawMock,
  },
}));
vi.mock("@/server/jobs/metricsScanner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/jobs/metricsScanner")>()),
  selectYouTubeMetricEligibleResults: selectMock,
}));
vi.mock("@/server/platforms/youtubeMetrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/platforms/youtubeMetrics")>()),
  fetchYouTubeVideoStatisticsBatch: fetchBatchMock,
}));
// The lock needs a database (its own suite covers it); here the refresher just runs.
vi.mock("@/server/platforms/connectionRefresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/platforms/connectionRefresh")>()),
  refreshConnectionToken: (snapshot: unknown, refresh: (current: unknown) => Promise<unknown>) => refresh(snapshot),
}));

import { syncYouTubeMetricsPage } from "@/server/jobs/youtubeMetricsSync";

const NOW = new Date("2026-11-02T13:00:00.000Z");

const eligible = (workspaceId: string) => ({
  resultId: `r-${workspaceId}`,
  userId: `poster-${workspaceId}`,
  workspaceId,
  platform: "youtube" as const,
  externalPostId: `${workspaceId}-v0`,
  socialConnectionId: `conn-${workspaceId}`,
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  abortSignalTimeoutOnFakeClock();
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => undefined);
  }
  vi.stubEnv("GOOGLE_GBP_CLIENT_ID", "test-client-id");
  vi.stubEnv("GOOGLE_GBP_CLIENT_SECRET", "test-client-secret");
  // Workspace A's token has expired (it must be refreshed); B's is fresh.
  findUniqueMock.mockImplementation(async ({ where }: { where: { workspaceId_platform: { workspaceId: string } } }) => {
    const ws = where.workspaceId_platform.workspaceId;
    return {
      id: `conn-${ws}`,
      userId: `connector-${ws}`,
      platform: "youtube",
      accessToken: `token-${ws}`,
      refreshToken: `refresh-${ws}`,
      expiresAt: ws === "A" ? new Date(NOW.getTime() - 60_000) : new Date("2099-01-01T00:00:00.000Z"),
      needsReconnect: false,
    };
  });
  selectMock.mockResolvedValue([eligible("A"), eligible("B")]);
  fetchBatchMock.mockImplementation(async (ids: string[]) => ({
    ok: true,
    byId: new Map(ids.map((id) => [id, { stats: { views: 1, likes: 0, comments: 0 }, raw: { id } }])),
  }));
  upsertMock.mockResolvedValue({});
  executeRawMock.mockResolvedValue(0);
  vi.stubGlobal("fetch", vi.fn(bodyNeverEnds));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("syncYouTubeMetricsPage: a token refresh whose body stalls", () => {
  it("counts that workspace as an error within the limit and goes on to the next", async () => {
    const page = syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });
    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_TIMEOUT_MS);

    const out = await Promise.race([page, Promise.resolve("still waiting" as const)]);

    expect(out).toMatchObject({ attempted: 2, updated: 1, errors: 1 });
    expect(fetchBatchMock.mock.calls.map((call) => call[1])).toEqual(["token-B"]);
  }, STALL_TEST_TIMEOUT_MS);
});
