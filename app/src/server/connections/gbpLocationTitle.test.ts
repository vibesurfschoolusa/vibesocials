import type { SocialConnection } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  return { ...actual, fetchWithTimeout: fetchMock, fetchWithinLimit: fetchMock };
});

vi.mock("@/server/platforms/connectionRefresh", () => ({
  refreshConnectionToken: refreshConnectionTokenMock,
}));

// The early-refresh check and fallback stay real (googleTokens.ts).
vi.mock("@/server/platforms/googleTokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/platforms/googleTokens")>()),
  refreshGoogleToken: vi.fn(),
}));

vi.mock("@/server/platforms/gbpLocation", () => ({
  resolveGbpLocationName: resolveGbpLocationNameMock,
}));

const { flagRejectedTokenMock } = vi.hoisted(() => ({ flagRejectedTokenMock: vi.fn() }));
vi.mock("@/server/platforms/connectionHealth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/platforms/connectionHealth")>()),
  flagRejectedToken: flagRejectedTokenMock,
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
  // The token check reads the clock: it stands at the run's NOW.
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  updateMock.mockResolvedValue({});
  resolveGbpLocationNameMock.mockImplementation(async (_token: string, name: string) => name);
});

afterEach(() => {
  vi.useRealTimers();
});

// 2026-11-09 (PR #64): Settings names a Business Profile connection by its
// location's title, saved when the location is picked. A location picked before
// that has none, and Settings read "choose the Maps location" although one was
// chosen. Once a day the missing title is read from Google and saved.
describe("backfillGbpLocationTitles", () => {
  it("reads the title of a chosen location that has none, and saves it beside the location", async () => {
    useRows([connection()]);
    fetchMock.mockResolvedValue(json({ title: "  Vibe Surf School  " }));

    const result = await backfillGbpLocationTitles();

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

  // R67: the title is cut to 200 code points in whole graphemes, like the location
  // route's own title, so an emoji at the bound is kept or dropped whole.
  it("cuts a long title in whole graphemes, never half an emoji", async () => {
    useRows([connection()]);
    fetchMock.mockResolvedValue(json({ title: `${"a".repeat(199)}🌊 Surf` }));

    await backfillGbpLocationTitles();

    const saved = (updateMock.mock.calls[0]?.[0] as { data: { metadata: { locationTitle: string } } }).data
      .metadata.locationTitle;
    expect(saved).toBe("a".repeat(199));
    expect(saved).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("only looks at working Business Profile connections, oldest first", async () => {
    useRows([]);

    await backfillGbpLocationTitles();

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

    expect(await backfillGbpLocationTitles()).toEqual({ named: 0, failed: 0, flagged: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired access token first, under the connection's lock", async () => {
    const expired = connection({ expiresAt: new Date(NOW.getTime() - HOUR) });
    useRows([expired]);
    refreshConnectionTokenMock.mockResolvedValue({ ...expired, accessToken: "gbp-access-2" });
    fetchMock.mockResolvedValue(json({ title: "Vibe Surf School" }));

    await backfillGbpLocationTitles();

    expect(refreshConnectionTokenMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe("Bearer gbp-access-2");
  });

  // R23 client-journey L1 (lead review): a token in its last 5 minutes is
  // refreshed first; a failed early refresh still reads with the stored token.
  it("refreshes a token with 4 minutes left, and leaves one with 10 minutes alone", async () => {
    const soon = connection({ id: "soon", expiresAt: new Date(NOW.getTime() + 4 * 60_000) });
    const later = connection({ id: "later", expiresAt: new Date(NOW.getTime() + 10 * 60_000) });
    useRows([soon, later]);
    refreshConnectionTokenMock.mockResolvedValue({ ...soon, accessToken: "gbp-access-2" });
    fetchMock.mockResolvedValue(json({ title: "Vibe Surf School" }));

    await backfillGbpLocationTitles();

    expect(refreshConnectionTokenMock).toHaveBeenCalledTimes(1);
    expect(refreshConnectionTokenMock.mock.calls[0][0].id).toBe("soon");
  });

  it("a failed refresh with 4 minutes left reads the title with the stored token", async () => {
    const soon = connection({ expiresAt: new Date(NOW.getTime() + 4 * 60_000) });
    useRows([soon]);
    refreshConnectionTokenMock.mockRejectedValue(new Error("503"));
    fetchMock.mockResolvedValue(json({ title: "Vibe Surf School" }));

    expect(await backfillGbpLocationTitles()).toMatchObject({ named: 1, failed: 0 });
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe("Bearer gbp-access");
  });

  it("resolves a location saved as a store code before asking for its title", async () => {
    useRows([connection({ metadata: { locationName: "FTL-01" } })]);
    resolveGbpLocationNameMock.mockResolvedValue("accounts/9/locations/77");
    fetchMock.mockResolvedValue(json({ title: "Fort Lauderdale" }));

    await backfillGbpLocationTitles();

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

    expect(await backfillGbpLocationTitles()).toEqual({ named: 1, failed: 1, flagged: [] });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][0].where).toEqual({ id: "b" });
  });

  it("an answer without a title saves nothing", async () => {
    useRows([connection()]);
    fetchMock.mockResolvedValueOnce(json({}));

    expect(await backfillGbpLocationTitles()).toEqual({ named: 0, failed: 1, flagged: [] });
    expect(updateMock).not.toHaveBeenCalled();
  });

  // The owner can pick another location in Settings while the run is under way.
  it("does not write a title for a location the owner replaced meanwhile", async () => {
    findManyMock.mockResolvedValue([connection()]);
    // Another location, saved without a title (a pasted store code, say).
    findUniqueMock.mockResolvedValue({ metadata: { locationName: "accounts/1/locations/99" } });
    fetchMock.mockResolvedValue(json({ title: "Old Shop" }));

    expect(await backfillGbpLocationTitles()).toEqual({ named: 0, failed: 1, flagged: [] });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("does not overwrite a title that arrived meanwhile", async () => {
    findManyMock.mockResolvedValue([connection()]);
    findUniqueMock.mockResolvedValue({
      metadata: { locationName: "accounts/1/locations/22", locationTitle: "Picked In Settings" },
    });
    fetchMock.mockResolvedValue(json({ title: "From Google" }));

    expect(await backfillGbpLocationTitles()).toEqual({ named: 0, failed: 1, flagged: [] });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("does nothing for a connection removed meanwhile", async () => {
    findManyMock.mockResolvedValue([connection()]);
    findUniqueMock.mockResolvedValue(null);
    fetchMock.mockResolvedValue(json({ title: "From Google" }));

    expect(await backfillGbpLocationTitles()).toEqual({ named: 0, failed: 1, flagged: [] });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("keeps whatever else was written to the row meanwhile", async () => {
    findManyMock.mockResolvedValue([connection()]);
    findUniqueMock.mockResolvedValue({
      metadata: { locationName: "accounts/1/locations/22", reviewsSyncedAt: "2026-11-10T11:59:00Z" },
    });
    fetchMock.mockResolvedValue(json({ title: "Vibe Surf School" }));

    await backfillGbpLocationTitles();

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

    expect(await backfillGbpLocationTitles()).toEqual({ named: 0, failed: 1, flagged: ["dead"] });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a refresh that failed for another reason (an outage) reports nothing", async () => {
    const expired = connection({ expiresAt: new Date(NOW.getTime() - HOUR) });
    findManyMock.mockResolvedValue([expired]);
    refreshConnectionTokenMock.mockRejectedValue(new Error("503"));
    findUniqueMock.mockResolvedValue({ needsReconnect: false });

    expect(await backfillGbpLocationTitles()).toEqual({ named: 0, failed: 1, flagged: [] });
  });

  it("tries a bounded number of connections per run", async () => {
    useRows(
      Array.from({ length: GBP_TITLE_BACKFILL_MAX_PER_RUN + 5 }, (_, i) => connection({ id: `c-${i}` })),
    );
    fetchMock.mockImplementation(async () => json({ title: "Name" }));

    const result = await backfillGbpLocationTitles();

    expect(result.named).toBe(GBP_TITLE_BACKFILL_MAX_PER_RUN);
    expect(fetchMock).toHaveBeenCalledTimes(GBP_TITLE_BACKFILL_MAX_PER_RUN);
  });

  it("starts no new connection once its time budget is spent", async () => {
    useRows([connection({ id: "a" }), connection({ id: "b" }), connection({ id: "c" })]);
    fetchMock.mockImplementation(async () => json({ title: "Name" }));
    // The clock jumps past the budget after the first connection.
    const times = [0, 0, GBP_TITLE_BACKFILL_BUDGET_MS + 1];
    const clock = () => times.shift() ?? GBP_TITLE_BACKFILL_BUDGET_MS + 1;

    const result = await backfillGbpLocationTitles(clock);

    expect(result.named).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// R25 (lead follow-up): one rule on every Google call. A 401 here flags the row
// with the tokens this run sent, so the sweep emails the owners (once: the
// sweep's own notices step sees the email already sent for that flag).
describe("backfillGbpLocationTitles and a token Google refuses", () => {
  const SNAPSHOT = { id: "conn-1", accessToken: "gbp-access", refreshToken: "gbp-refresh" };

  function flagsTheRow(row: SocialConnection) {
    flagRejectedTokenMock.mockImplementation(async () => {
      (row as { needsReconnect: boolean }).needsReconnect = true;
      return "flagged";
    });
  }

  it("a 401 on the title flags the row and hands it to the sweep to email", async () => {
    const row = connection();
    useRows([row]);
    flagsTheRow(row);
    fetchMock.mockResolvedValue(json({}, 401));

    const result = await backfillGbpLocationTitles();

    expect(flagRejectedTokenMock).toHaveBeenCalledWith(SNAPSHOT, "GOOGLE_API_TOKEN_REJECTED");
    expect(result).toEqual({ named: 0, failed: 1, flagged: ["conn-1"] });
  });

  it("a 401 while a store code is looked up flags the row too", async () => {
    const row = connection({ metadata: { locationName: "STORE-1" } });
    useRows([row]);
    flagsTheRow(row);
    resolveGbpLocationNameMock.mockRejectedValue(Object.assign(new Error("Google list failed"), { status: 401 }));

    const result = await backfillGbpLocationTitles();

    expect(flagRejectedTokenMock).toHaveBeenCalledTimes(1);
    expect(flagRejectedTokenMock).toHaveBeenCalledWith(SNAPSHOT, "GOOGLE_API_TOKEN_REJECTED");
    expect(result.flagged).toEqual(["conn-1"]);
  });

  it("a 5xx flags nothing", async () => {
    useRows([connection()]);
    fetchMock.mockResolvedValue(json({}, 503));

    const result = await backfillGbpLocationTitles();

    expect(flagRejectedTokenMock).not.toHaveBeenCalled();
    expect(result).toEqual({ named: 0, failed: 1, flagged: [] });
  });
});
