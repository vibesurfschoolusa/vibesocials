import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One page of the YouTube metrics sync (2026-11-01 scale audit, jobs): select
// the least-recently-checked results, group them per workspace connection,
// fetch 50 ids per videos.list call within a unit budget, upsert what was found
// and stamp every attempted result. vi.mock is hoisted above the imports: no
// database, YouTube API or token endpoint is reached.
const {
  selectMock,
  fetchBatchMock,
  findUniqueMock,
  upsertMock,
  updateManyMock,
  executeRawMock,
  refreshConnectionTokenMock,
  refreshGoogleTokenMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  fetchBatchMock: vi.fn(),
  findUniqueMock: vi.fn(),
  upsertMock: vi.fn(),
  updateManyMock: vi.fn(),
  executeRawMock: vi.fn(),
  refreshConnectionTokenMock: vi.fn(),
  refreshGoogleTokenMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { findUnique: findUniqueMock },
    postMetric: { upsert: upsertMock },
    postJobResult: { updateMany: updateManyMock },
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
// The lock helper has its own suite (connectionRefresh.test.ts).
vi.mock("@/server/platforms/connectionRefresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/platforms/connectionRefresh")>()),
  refreshConnectionToken: refreshConnectionTokenMock,
}));
vi.mock("@/server/platforms/googleTokens", () => ({ refreshGoogleToken: refreshGoogleTokenMock }));

import { METRICS_PAGE_SIZE } from "@/server/jobs/metricsScanner";
import { METRICS_PAGE_BUDGET_MS, syncYouTubeMetricsPage } from "@/server/jobs/youtubeMetricsSync";

const NOW = new Date("2026-11-02T13:00:00.000Z");
const FUTURE = new Date("2099-01-01T00:00:00.000Z");

type Eligible = {
  resultId: string;
  userId: string;
  workspaceId: string;
  platform: "youtube";
  externalPostId: string;
};

/** `count` eligible results of one workspace, ids `<ws>-v0` ... */
function results(workspaceId: string, count: number): Eligible[] {
  return Array.from({ length: count }, (_, i) => ({
    resultId: `r-${workspaceId}-${i}`,
    userId: `poster-${workspaceId}`,
    workspaceId,
    platform: "youtube" as const,
    externalPostId: `${workspaceId}-v${i}`,
  }));
}

/** A found video with the given counts, as the batch fetch returns it. */
const found = (id: string, stats = { views: 10, likes: 2, comments: 1 }) => ({
  stats,
  raw: { id, statistics: { viewCount: String(stats.views) } },
});

/** Batch fetch where every requested id exists. */
function everyIdFound() {
  fetchBatchMock.mockImplementation(async (ids: string[]) => ({
    ok: true,
    byId: new Map(ids.map((id) => [id, found(id)])),
  }));
}

/** A usable connection per workspace: token `token-<ws>`, connected by `connector-<ws>`. */
function connectionsFor() {
  findUniqueMock.mockImplementation(async ({ where }: { where: { workspaceId_platform: { workspaceId: string } } }) => {
    const ws = where.workspaceId_platform.workspaceId;
    return {
      id: `conn-${ws}`,
      userId: `connector-${ws}`,
      platform: "youtube",
      accessToken: `token-${ws}`,
      refreshToken: `refresh-${ws}`,
      expiresAt: FUTURE,
      needsReconnect: false,
    };
  });
}

/**
 * The stamp is ONE raw `UPDATE ... WHERE id = ANY(...)` (tagged template: the
 * mock receives (strings, now, ids)), not `updateMany`: Prisma's `@updatedAt`
 * would bump PostJobResult.updatedAt on every hourly stamp, and publish-health
 * (/api/insights/publish-health) reads that column as "when the result finished".
 */
const stampedIds = (): string[] => executeRawMock.mock.calls.flatMap((call) => call[2] as string[]);
const idsPerCall = () => fetchBatchMock.mock.calls.map((call) => (call[0] as string[]).length);

beforeEach(() => {
  for (const mock of [
    selectMock,
    fetchBatchMock,
    findUniqueMock,
    upsertMock,
    updateManyMock,
    executeRawMock,
    refreshConnectionTokenMock,
    refreshGoogleTokenMock,
  ]) {
    mock.mockReset();
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  connectionsFor();
  everyIdFound();
  upsertMock.mockResolvedValue({});
  executeRawMock.mockResolvedValue(0);
  // Pass-through lock: the refresher runs on the snapshot.
  refreshConnectionTokenMock.mockImplementation(
    (snapshot: unknown, refresh: (current: unknown) => Promise<unknown>) => refresh(snapshot),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("syncYouTubeMetricsPage — batching and stamping", () => {
  // Workspace A has 70 results and B has 50, interleaved the way a staleness
  // order mixes them.
  const interleaved = () => {
    const a = results("A", 70);
    const b = results("B", 50);
    const mixed: Eligible[] = [];
    for (let i = 0; i < 70; i++) {
      mixed.push(a[i]);
      if (i < 50) mixed.push(b[i]);
    }
    return mixed;
  };

  it("selects one page of METRICS_PAGE_SIZE results as of `now`", async () => {
    selectMock.mockResolvedValue([]);

    await syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });

    expect(selectMock).toHaveBeenCalledWith(METRICS_PAGE_SIZE, NOW);
  });

  it("120 results of two workspaces: 3 calls (50, 20, 50), 3 units, one stamp of all 120 ids, one upsert per found video", async () => {
    const eligible = interleaved();
    selectMock.mockResolvedValue(eligible);

    const page = await syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });

    expect(idsPerCall()).toEqual([50, 20, 50]);
    // Each workspace's ids are fetched with ITS connection's token.
    expect(fetchBatchMock.mock.calls.map((call) => call[1])).toEqual(["token-A", "token-A", "token-B"]);
    expect(page).toEqual({ attempted: 120, updated: 120, notFound: 0, errors: 0, unitsUsed: 3, stop: false });
    expect(upsertMock).toHaveBeenCalledTimes(120);

    expect(executeRawMock).toHaveBeenCalledTimes(1);
    const [strings, stamp, ids] = executeRawMock.mock.calls[0] as [string[], Date, string[]];
    expect(stamp).toBe(NOW);
    expect([...ids].sort()).toEqual(eligible.map((item) => item.resultId).sort());
    // Only metricsCheckedAt is written: a check must not look like the result
    // "finishing" again to publish-health, which reads PostJobResult.updatedAt.
    const sql = strings.join("?");
    expect(sql).toContain('UPDATE "PostJobResult"');
    expect(sql).toContain(`SET "metricsCheckedAt" = (?::timestamptz AT TIME ZONE 'UTC')`);
    expect(sql).not.toContain("updatedAt");
    // Scoped to the attempted ids: without this clause a regression would stamp
    // the whole table.
    expect(sql).toContain('WHERE "id" = ANY(?::text[])');
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("upserts on (platform, externalPostId), stamped with the connector, the workspace, the result link and null shares", async () => {
    selectMock.mockResolvedValue(results("A", 1));
    fetchBatchMock.mockResolvedValue({
      ok: true,
      byId: new Map([["A-v0", found("A-v0", { views: 10, likes: 2, comments: 1 })]]),
    });

    await syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });

    const raw = { id: "A-v0", statistics: { viewCount: "10" } };
    expect(upsertMock).toHaveBeenCalledWith({
      where: { platform_externalPostId: { platform: "youtube", externalPostId: "A-v0" } },
      create: {
        userId: "connector-A",
        workspaceId: "A",
        platform: "youtube",
        externalPostId: "A-v0",
        postJobResultId: "r-A-0",
        views: 10,
        likes: 2,
        comments: 1,
        shares: null,
        raw,
        fetchedAt: NOW,
      },
      update: {
        userId: "connector-A",
        postJobResultId: "r-A-0",
        views: 10,
        likes: 2,
        comments: 1,
        shares: null,
        raw,
        fetchedAt: NOW,
      },
    });
  });

  it("a found video whose statistics are all null is not upserted (it would wipe a good snapshot), but is stamped", async () => {
    selectMock.mockResolvedValue(results("A", 2));
    fetchBatchMock.mockResolvedValue({
      ok: true,
      byId: new Map([
        ["A-v0", found("A-v0", { views: null as unknown as number, likes: null as unknown as number, comments: null as unknown as number })],
        ["A-v1", found("A-v1")],
      ]),
    });

    const page = await syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });

    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock.mock.calls[0][0].where.platform_externalPostId.externalPostId).toBe("A-v1");
    expect(page).toMatchObject({ attempted: 2, updated: 1, notFound: 1, errors: 0 });
    expect(stampedIds().sort()).toEqual(["r-A-0", "r-A-1"]);
  });

  it("an id missing from the response (deleted or private video) is not upserted but IS stamped, so it cannot starve the queue", async () => {
    selectMock.mockResolvedValue(results("A", 3));
    fetchBatchMock.mockResolvedValue({
      ok: true,
      byId: new Map([["A-v1", found("A-v1")]]),
    });

    const page = await syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });

    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(page).toMatchObject({ attempted: 3, updated: 1, notFound: 2, errors: 0, stop: false });
    expect(stampedIds().sort()).toEqual(["r-A-0", "r-A-1", "r-A-2"]);
  });

  it("an empty page attempts nothing, spends nothing and stamps nothing", async () => {
    selectMock.mockResolvedValue([]);

    const page = await syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });

    expect(page).toEqual({ attempted: 0, updated: 0, notFound: 0, errors: 0, unitsUsed: 0, stop: false });
    expect(fetchBatchMock).not.toHaveBeenCalled();
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it("with no units left it does not even select a page", async () => {
    const page = await syncYouTubeMetricsPage({ unitsLeft: 0, now: NOW });

    expect(page).toEqual({ attempted: 0, updated: 0, notFound: 0, errors: 0, unitsUsed: 0, stop: false });
    expect(selectMock).not.toHaveBeenCalled();
    expect(fetchBatchMock).not.toHaveBeenCalled();
  });
});

describe("syncYouTubeMetricsPage — unit budget", () => {
  it("unitsLeft 2 makes 2 calls and stamps only the attempted ids", async () => {
    selectMock.mockResolvedValue([...results("A", 70), ...results("B", 50)]);

    const page = await syncYouTubeMetricsPage({ unitsLeft: 2, now: NOW });

    expect(idsPerCall()).toEqual([50, 20]);
    expect(page).toEqual({ attempted: 70, updated: 70, notFound: 0, errors: 0, unitsUsed: 2, stop: false });
    const stamped = stampedIds();
    expect(stamped).toHaveLength(70);
    expect(stamped.every((id) => id.startsWith("r-A-"))).toBe(true);
    expect(stamped.some((id) => id.startsWith("r-B-"))).toBe(false);
  });

  it("a workspace without a connection costs no unit, so the budget still reaches the next workspace", async () => {
    selectMock.mockResolvedValue([...results("GONE", 120), ...results("B", 50)]);
    findUniqueMock.mockImplementation(async ({ where }: { where: { workspaceId_platform: { workspaceId: string } } }) =>
      where.workspaceId_platform.workspaceId === "GONE"
        ? null
        : {
            id: "conn-B",
            userId: "connector-B",
            accessToken: "token-B",
            expiresAt: FUTURE,
            needsReconnect: false,
          },
    );

    const page = await syncYouTubeMetricsPage({ unitsLeft: 1, now: NOW });

    expect(idsPerCall()).toEqual([50]);
    expect(page.unitsUsed).toBe(1);
    expect(page.updated).toBe(50);
  });
});

describe("syncYouTubeMetricsPage — time budget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops between calls once the page's time budget is used up, stamping only what it reached (the next page resumes)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    selectMock.mockResolvedValue(results("A", 200));
    // Each call takes 100 s: the third call would start 200 s into a 150 s budget.
    fetchBatchMock.mockImplementation(async (ids: string[]) => {
      vi.setSystemTime(Date.now() + 100_000);
      return { ok: true, byId: new Map(ids.map((id) => [id, found(id)])) };
    });

    const page = await syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });

    expect(METRICS_PAGE_BUDGET_MS).toBe(150_000);
    expect(fetchBatchMock).toHaveBeenCalledTimes(2);
    expect(page).toEqual({ attempted: 100, updated: 100, notFound: 0, errors: 0, unitsUsed: 2, stop: false });
    expect(stampedIds()).toHaveLength(100);
  });
});

describe("syncYouTubeMetricsPage — quota", () => {
  it("quotaExceeded stops the run: stop true, later chunks are not called and the refused chunk is not stamped", async () => {
    selectMock.mockResolvedValue([...results("A", 70), ...results("B", 50)]);
    fetchBatchMock
      .mockImplementationOnce(async (ids: string[]) => ({
        ok: true,
        byId: new Map(ids.map((id) => [id, found(id)])),
      }))
      .mockResolvedValueOnce({ ok: false, code: "YOUTUBE_METRICS_QUOTA_EXCEEDED", quotaExceeded: true });

    const page = await syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });

    expect(fetchBatchMock).toHaveBeenCalledTimes(2);
    // The refused call is a unit spent (conservative); it was not a check.
    expect(page).toEqual({ attempted: 50, updated: 50, notFound: 0, errors: 0, unitsUsed: 2, stop: true });
    expect(stampedIds()).toHaveLength(50);
  });

  it("quotaExceeded on the first call stamps nothing (those videos are still the stalest)", async () => {
    selectMock.mockResolvedValue(results("A", 5));
    fetchBatchMock.mockResolvedValue({ ok: false, code: "YOUTUBE_METRICS_QUOTA_EXCEEDED", quotaExceeded: true });

    const page = await syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });

    expect(page).toEqual({ attempted: 0, updated: 0, notFound: 0, errors: 0, unitsUsed: 1, stop: true });
    expect(executeRawMock).not.toHaveBeenCalled();
  });
});

describe("syncYouTubeMetricsPage — failures are isolated", () => {
  it("a failed call counts its ids as errors and stamps them, then the next workspace is still fetched", async () => {
    selectMock.mockResolvedValue([...results("A", 3), ...results("B", 2)]);
    fetchBatchMock
      .mockResolvedValueOnce({ ok: false, code: "YOUTUBE_METRICS_HTTP_ERROR", quotaExceeded: false })
      .mockImplementationOnce(async (ids: string[]) => ({
        ok: true,
        byId: new Map(ids.map((id) => [id, found(id)])),
      }));

    const page = await syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });

    expect(page).toEqual({ attempted: 5, updated: 2, notFound: 0, errors: 3, unitsUsed: 2, stop: false });
    expect(stampedIds().sort()).toEqual(["r-A-0", "r-A-1", "r-A-2", "r-B-0", "r-B-1"]);
  });

  it("an upsert that throws counts one error, is stamped, and does not stop the rest", async () => {
    selectMock.mockResolvedValue(results("A", 3));
    upsertMock.mockRejectedValueOnce(new Error("integer out of range")).mockResolvedValue({});

    const page = await syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });

    expect(upsertMock).toHaveBeenCalledTimes(3);
    expect(page).toMatchObject({ attempted: 3, updated: 2, errors: 1, stop: false });
    expect(stampedIds()).toHaveLength(3);
  });

  it("a workspace with no connection, or one flagged needsReconnect, costs no call; its results are stamped and counted as errors", async () => {
    selectMock.mockResolvedValue([...results("GONE", 2), ...results("FLAGGED", 1), ...results("B", 1)]);
    findUniqueMock.mockImplementation(async ({ where }: { where: { workspaceId_platform: { workspaceId: string } } }) => {
      const ws = where.workspaceId_platform.workspaceId;
      if (ws === "GONE") return null;
      return {
        id: `conn-${ws}`,
        userId: `connector-${ws}`,
        accessToken: `token-${ws}`,
        expiresAt: FUTURE,
        needsReconnect: ws === "FLAGGED",
      };
    });

    const page = await syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });

    expect(fetchBatchMock).toHaveBeenCalledTimes(1);
    expect(fetchBatchMock.mock.calls[0][1]).toBe("token-B");
    expect(page).toEqual({ attempted: 4, updated: 1, notFound: 0, errors: 3, unitsUsed: 1, stop: false });
    // Stamped, or they would sort first on every run and starve everyone else.
    expect(stampedIds().sort()).toEqual(["r-B-0", "r-FLAGGED-0", "r-GONE-0", "r-GONE-1"]);
  });

  it("resolves each workspace's connection once per page", async () => {
    selectMock.mockResolvedValue(results("A", 120));

    await syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });

    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { workspaceId_platform: { workspaceId: "A", platform: "youtube" } },
    });
  });
});

describe("syncYouTubeMetricsPage — connection resolve refreshes under the lock", () => {
  const expired = {
    id: "conn-yt",
    userId: "connector-1",
    platform: "youtube",
    accessToken: "expired-token",
    refreshToken: "refresh-token",
    expiresAt: new Date("2020-01-01T00:00:00Z"),
    needsReconnect: false,
  };

  beforeEach(() => {
    selectMock.mockResolvedValue(results("A", 1));
  });

  it("an expired YouTube token goes through refreshConnectionToken, and the refreshed token is used", async () => {
    findUniqueMock.mockResolvedValue(expired);
    refreshConnectionTokenMock.mockResolvedValue({ ...expired, accessToken: "fresh-token" });

    const page = await syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });

    expect(refreshConnectionTokenMock).toHaveBeenCalledTimes(1);
    expect(refreshConnectionTokenMock.mock.calls[0][0]).toBe(expired);
    // The callback is the shared Google refresh, run on the row the lock re-read.
    const reread = { ...expired };
    refreshGoogleTokenMock.mockResolvedValue(reread);
    await refreshConnectionTokenMock.mock.calls[0][1](reread);
    expect(refreshGoogleTokenMock).toHaveBeenCalledWith(reread);
    expect(fetchBatchMock).toHaveBeenCalledWith(["A-v0"], "fresh-token");
    expect(page.updated).toBe(1);
  });

  it("a fresh token is used as is, without taking the lock", async () => {
    findUniqueMock.mockResolvedValue({ ...expired, accessToken: "good-token", expiresAt: FUTURE });

    await syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });

    expect(refreshConnectionTokenMock).not.toHaveBeenCalled();
    expect(fetchBatchMock).toHaveBeenCalledWith(["A-v0"], "good-token");
  });

  it("a refresh that fails (flagged, gone, busy) skips the workspace instead of failing the page", async () => {
    findUniqueMock.mockResolvedValue(expired);
    refreshConnectionTokenMock.mockRejectedValue(
      Object.assign(new Error("busy"), { code: "CONNECTION_REFRESH_BUSY", status: 503 }),
    );

    const page = await syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });

    expect(fetchBatchMock).not.toHaveBeenCalled();
    expect(page).toMatchObject({ attempted: 1, updated: 0, errors: 1, unitsUsed: 0 });
  });

  it("a connection lookup that throws skips the workspace instead of failing the page", async () => {
    findUniqueMock.mockRejectedValue(new Error("db down"));

    const page = await syncYouTubeMetricsPage({ unitsLeft: 300, now: NOW });

    expect(fetchBatchMock).not.toHaveBeenCalled();
    expect(page).toMatchObject({ attempted: 1, errors: 1, unitsUsed: 0 });
  });
});
