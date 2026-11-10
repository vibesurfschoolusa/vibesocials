import type { SocialConnection } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  findManyMock,
  findUniqueMock,
  updateMock,
  fetchMock,
  refreshConnectionTokenMock,
  resolveGbpLocationNameMock,
} = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  findUniqueMock: vi.fn(),
  updateMock: vi.fn(),
  fetchMock: vi.fn(),
  refreshConnectionTokenMock: vi.fn(),
  resolveGbpLocationNameMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { findMany: findManyMock, findUnique: findUniqueMock, update: updateMock },
  },
}));

vi.mock("@/lib/fetchWithTimeout", async () => {
  const actual = await vi.importActual<typeof import("@/lib/fetchWithTimeout")>(
    "@/lib/fetchWithTimeout",
  );
  return { ...actual, fetchWithTimeout: fetchMock };
});

vi.mock("@/server/platforms/connectionRefresh", () => ({
  refreshConnectionToken: refreshConnectionTokenMock,
}));

vi.mock("@/server/platforms/googleTokens", () => ({
  refreshGoogleToken: vi.fn(),
}));

vi.mock("@/server/platforms/gbpLocation", () => ({
  resolveGbpLocationName: resolveGbpLocationNameMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  GBP_TITLE_BACKFILL_BUDGET_MS,
  GBP_TITLE_BACKFILL_MAX_PER_RUN,
  backfillGbpLocationTitles,
} from "./gbpLocationTitle";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function connection(over: Partial<SocialConnection> = {}): SocialConnection {
  return {
    id: "conn-1",
    platform: "google_business_profile",
    accessToken: "gbp-access",
    refreshToken: "gbp-refresh",
    expiresAt: new Date(NOW.getTime() + HOUR),
    needsReconnect: false,
    metadata: { locationName: "accounts/1/locations/22" },
    ...over,
  } as SocialConnection;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The rows the run starts from; the re-read before each write sees the same row unless told otherwise. */
function useRows(rows: SocialConnection[]) {
  findManyMock.mockResolvedValue(rows);
  findUniqueMock.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const row = rows.find((r) => r.id === where.id);
    return row ? { metadata: row.metadata, needsReconnect: row.needsReconnect } : null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockResolvedValue({});
  resolveGbpLocationNameMock.mockImplementation(async (_token: string, name: string) => name);
});

// 2026-11-09 (PR #64): Settings names a Business Profile connection by its
// location's title, saved when the location is picked. A location picked before
// that has none, and Settings read "choose the Maps location" although one was
// chosen. Once a day the missing title is read from Google and saved.
describe("backfillGbpLocationTitles", () => {
  it("reads the title of a chosen location that has none, and saves it beside the location", async () => {
    useRows([connection()]);
    fetchMock.mockResolvedValue(json({ title: "  Vibe Surf School  " }));

    const result = await backfillGbpLocationTitles(NOW);

    expect(result).toEqual({ named: 1, failed: 0, flagged: [] });
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(String(url)).toBe(
      "https://mybusinessbusinessinformation.googleapis.com/v1/locations/22?readMask=title",
    );
    expect(init.headers.Authorization).toBe("Bearer gbp-access");
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: { metadata: { locationName: "accounts/1/locations/22", locationTitle: "Vibe Surf School" } },
    });
  });

  it("only looks at working Business Profile connections, oldest first", async () => {
    useRows([]);

    await backfillGbpLocationTitles(NOW);

    expect(findManyMock).toHaveBeenCalledWith({
      where: { platform: "google_business_profile", needsReconnect: false },
      orderBy: { updatedAt: "asc" },
    });
  });

  it("leaves alone a connection that already has a title, and one with no location chosen", async () => {
    useRows([
      connection({ id: "a", metadata: { locationName: "accounts/1/locations/22", locationTitle: "Named" } }),
      connection({ id: "b", metadata: { locationName: null } }),
      connection({ id: "c", metadata: null }),
    ]);

    expect(await backfillGbpLocationTitles(NOW)).toEqual({ named: 0, failed: 0, flagged: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired access token first, under the connection's lock", async () => {
    const expired = connection({ expiresAt: new Date(NOW.getTime() - HOUR) });
    useRows([expired]);
    refreshConnectionTokenMock.mockResolvedValue({ ...expired, accessToken: "gbp-access-2" });
    fetchMock.mockResolvedValue(json({ title: "Vibe Surf School" }));

    await backfillGbpLocationTitles(NOW);

    expect(refreshConnectionTokenMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe("Bearer gbp-access-2");
  });

  it("resolves a location saved as a store code before asking for its title", async () => {
    useRows([connection({ metadata: { locationName: "FTL-01" } })]);
    resolveGbpLocationNameMock.mockResolvedValue("accounts/9/locations/77");
    fetchMock.mockResolvedValue(json({ title: "Fort Lauderdale" }));

    await backfillGbpLocationTitles(NOW);

    expect(resolveGbpLocationNameMock).toHaveBeenCalledWith("gbp-access", "FTL-01");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/locations/77?readMask=title");
    // The saved location itself is not rewritten.
    expect(updateMock.mock.calls[0][0].data.metadata).toEqual({
      locationName: "FTL-01",
      locationTitle: "Fort Lauderdale",
    });
  });

  it("a location Google won't describe is counted and left for the next day; the others still get theirs", async () => {
    useRows([
      connection({ id: "a" }),
      connection({ id: "b", metadata: { locationName: "accounts/1/locations/33" } }),
    ]);
    fetchMock.mockResolvedValueOnce(json({ error: { status: "PERMISSION_DENIED" } }, 403));
    fetchMock.mockResolvedValueOnce(json({ title: "Second" }));

    expect(await backfillGbpLocationTitles(NOW)).toEqual({ named: 1, failed: 1, flagged: [] });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][0].where).toEqual({ id: "b" });
  });

  it("an answer without a title saves nothing", async () => {
    useRows([connection()]);
    fetchMock.mockResolvedValueOnce(json({}));

    expect(await backfillGbpLocationTitles(NOW)).toEqual({ named: 0, failed: 1, flagged: [] });
    expect(updateMock).not.toHaveBeenCalled();
  });

  // The owner can pick another location in Settings while the run is under way.
  it("does not write a title for a location the owner replaced meanwhile", async () => {
    findManyMock.mockResolvedValue([connection()]);
    // Another location, saved without a title (a pasted store code, say).
    findUniqueMock.mockResolvedValue({ metadata: { locationName: "accounts/1/locations/99" } });
    fetchMock.mockResolvedValue(json({ title: "Old Shop" }));

    expect(await backfillGbpLocationTitles(NOW)).toEqual({ named: 0, failed: 1, flagged: [] });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("does not overwrite a title that arrived meanwhile", async () => {
    findManyMock.mockResolvedValue([connection()]);
    findUniqueMock.mockResolvedValue({
      metadata: { locationName: "accounts/1/locations/22", locationTitle: "Picked In Settings" },
    });
    fetchMock.mockResolvedValue(json({ title: "From Google" }));

    expect(await backfillGbpLocationTitles(NOW)).toEqual({ named: 0, failed: 1, flagged: [] });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("does nothing for a connection removed meanwhile", async () => {
    findManyMock.mockResolvedValue([connection()]);
    findUniqueMock.mockResolvedValue(null);
    fetchMock.mockResolvedValue(json({ title: "From Google" }));

    expect(await backfillGbpLocationTitles(NOW)).toEqual({ named: 0, failed: 1, flagged: [] });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("keeps whatever else was written to the row meanwhile", async () => {
    findManyMock.mockResolvedValue([connection()]);
    findUniqueMock.mockResolvedValue({
      metadata: { locationName: "accounts/1/locations/22", reviewsSyncedAt: "2026-11-10T11:59:00Z" },
    });
    fetchMock.mockResolvedValue(json({ title: "Vibe Surf School" }));

    await backfillGbpLocationTitles(NOW);

    expect(updateMock.mock.calls[0][0].data.metadata).toEqual({
      locationName: "accounts/1/locations/22",
      reviewsSyncedAt: "2026-11-10T11:59:00Z",
      locationTitle: "Vibe Surf School",
    });
  });

  // googleTokens.ts flags a connection whose grant is dead; the owners are emailed
  // by whoever observes that, so the run reports it (inngest-functions.ts emails).
  it("reports a connection its token refresh found dead, so its owners can be emailed", async () => {
    const expired = connection({ id: "dead", expiresAt: new Date(NOW.getTime() - HOUR) });
    findManyMock.mockResolvedValue([expired]);
    refreshConnectionTokenMock.mockRejectedValue(new Error("invalid_grant"));
    findUniqueMock.mockResolvedValue({ needsReconnect: true });

    expect(await backfillGbpLocationTitles(NOW)).toEqual({ named: 0, failed: 1, flagged: ["dead"] });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a refresh that failed for another reason (an outage) reports nothing", async () => {
    const expired = connection({ expiresAt: new Date(NOW.getTime() - HOUR) });
    findManyMock.mockResolvedValue([expired]);
    refreshConnectionTokenMock.mockRejectedValue(new Error("503"));
    findUniqueMock.mockResolvedValue({ needsReconnect: false });

    expect(await backfillGbpLocationTitles(NOW)).toEqual({ named: 0, failed: 1, flagged: [] });
  });

  it("tries a bounded number of connections per run", async () => {
    useRows(
      Array.from({ length: GBP_TITLE_BACKFILL_MAX_PER_RUN + 5 }, (_, i) => connection({ id: `c-${i}` })),
    );
    fetchMock.mockImplementation(async () => json({ title: "Name" }));

    const result = await backfillGbpLocationTitles(NOW);

    expect(result.named).toBe(GBP_TITLE_BACKFILL_MAX_PER_RUN);
    expect(fetchMock).toHaveBeenCalledTimes(GBP_TITLE_BACKFILL_MAX_PER_RUN);
  });

  it("starts no new connection once its time budget is spent", async () => {
    useRows([connection({ id: "a" }), connection({ id: "b" }), connection({ id: "c" })]);
    fetchMock.mockImplementation(async () => json({ title: "Name" }));
    // The clock jumps past the budget after the first connection.
    const times = [0, 0, GBP_TITLE_BACKFILL_BUDGET_MS + 1];
    const clock = () => times.shift() ?? GBP_TITLE_BACKFILL_BUDGET_MS + 1;

    const result = await backfillGbpLocationTitles(NOW, clock);

    expect(result.named).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
