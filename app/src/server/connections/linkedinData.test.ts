import { beforeEach, describe, expect, it, vi } from "vitest";

// updateMock is the guarded write (updateMany); findUniqueMock the token re-read,
// answering by default the tokens every row below was read with.
const { findManyMock, findUniqueMock, updateMock, lookupOrganizationMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  findUniqueMock: vi.fn<(args: { select: Record<string, boolean> }) => Promise<unknown>>(async () => ({
    accessToken: "li-token",
    refreshToken: null,
  })),
  updateMock: vi.fn(),
  lookupOrganizationMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { socialConnection: { findMany: findManyMock, findUnique: findUniqueMock, updateMany: updateMock } },
}));

vi.mock("./linkedinOrganizations", () => ({
  lookupOrganization: lookupOrganizationMock,
}));

import {
  LINKEDIN_ORG_PROFILE_MAX_AGE_MS,
  LINKEDIN_ORG_REFRESH_BUDGET_MS,
  LINKEDIN_ORG_REFRESH_MAX_PER_RUN,
  refreshLinkedInOrganizationProfiles,
} from "./linkedinData";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

/** When every row below was last written, as the run read it. */
const READ_AT = new Date("2026-11-09T11:58:00.000Z");

const connection = (over: { expiresAt?: Date | null; metadata?: Record<string, unknown> } = {}) => ({
  id: "conn-1",
  accessToken: "li-token",
  refreshToken: null,
  updatedAt: READ_AT,
  expiresAt: "expiresAt" in over ? over.expiresAt : new Date(NOW.getTime() + 30 * DAY),
  metadata: over.metadata ?? {
    name: "LinkedIn User",
    organizations: [{ id: "101", name: "Old Name", vanityName: "old-name" }],
    username: "Old Name",
    organizationsFetchedAt: daysAgo(3),
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockResolvedValue({ count: 1 });
  findUniqueMock.mockResolvedValue({ accessToken: "li-token", refreshToken: null });
});

// LinkedIn Marketing API data storage requirements (checked 2026-11-09):
// profile data of an organization that authenticated into the app (its name,
// vanity name) may be stored for eight weeks. IDs have no limit.
describe("refreshLinkedInOrganizationProfiles", () => {
  it("allows eight weeks", () => {
    expect(LINKEDIN_ORG_PROFILE_MAX_AGE_MS).toBe(56 * DAY);
  });

  it("re-reads each connected page's name while the token works, and records when", async () => {
    findManyMock.mockResolvedValue([connection()]);
    lookupOrganizationMock.mockResolvedValue({ id: "101", name: "Vibe Surf School", vanityName: "vibe-surf-school" });

    const summary = await refreshLinkedInOrganizationProfiles(NOW);

    expect(summary).toEqual({ refreshed: 1, cleared: 0 });
    expect(findManyMock).toHaveBeenCalledWith({
      where: { platform: "linkedin" },
      select: { id: true, accessToken: true, refreshToken: true, expiresAt: true, metadata: true, updatedAt: true },
    });
    expect(lookupOrganizationMock).toHaveBeenCalledWith("li-token", "101");
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "conn-1", updatedAt: READ_AT },
      data: {
        metadata: {
          name: "LinkedIn User",
          organizations: [{ id: "101", name: "Vibe Surf School", vanityName: "vibe-surf-school" }],
          username: "Vibe Surf School",
          organizationsFetchedAt: NOW.toISOString(),
          organizationsTriedAt: NOW.toISOString(),
        },
      },
    });
  });

  it("keeps a name read within eight weeks when this read fails, recording only the try", async () => {
    findManyMock.mockResolvedValue([connection()]);
    lookupOrganizationMock.mockResolvedValue(null);

    expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 0, cleared: 0 });
    // Lead review (R35): the name, vanity name and read time are as they were.
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "conn-1", updatedAt: READ_AT },
      data: { metadata: { ...connection().metadata, organizationsTriedAt: NOW.toISOString() } },
    });
  });

  it("deletes the name and vanity name eight weeks after the last read, keeping the page id", async () => {
    findManyMock.mockResolvedValue([
      connection({
        expiresAt: new Date(NOW.getTime() - DAY),
        metadata: {
          organizations: [{ id: "101", name: "Old Name", vanityName: "old-name" }],
          username: "Old Name",
          organizationsFetchedAt: daysAgo(57),
        },
      }),
    ]);

    const summary = await refreshLinkedInOrganizationProfiles(NOW);

    expect(summary).toEqual({ refreshed: 0, cleared: 1 });
    expect(lookupOrganizationMock).not.toHaveBeenCalled(); // the token has expired
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "conn-1", updatedAt: READ_AT },
      data: { metadata: { organizations: [{ id: "101" }], username: null, organizationsFetchedAt: null } },
    });
  });

  it("treats a connection saved before this rule (no read time) as stale when the page cannot be read", async () => {
    findManyMock.mockResolvedValue([
      connection({ metadata: { organizations: [{ id: "101", name: "Old Name" }], username: "Old Name" } }),
    ]);
    lookupOrganizationMock.mockResolvedValue(null);

    expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 0, cleared: 1 });
    // One write: the clean-up, with this run's try recorded.
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "conn-1", updatedAt: READ_AT },
      data: {
        metadata: {
          organizations: [{ id: "101" }],
          username: null,
          organizationsFetchedAt: null,
          organizationsTriedAt: NOW.toISOString(),
        },
      },
    });
  });

  it("leaves alone a connection with no page, or whose profile data is already gone", async () => {
    findManyMock.mockResolvedValue([
      connection({ metadata: { organizations: [] } }),
      connection({
        expiresAt: null,
        metadata: { organizations: [{ id: "202" }], username: null, organizationsFetchedAt: null },
      }),
    ]);
    lookupOrganizationMock.mockResolvedValue(null);

    expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 0, cleared: 0 });
    expect(lookupOrganizationMock).toHaveBeenCalledTimes(1);
    expect(lookupOrganizationMock).toHaveBeenCalledWith("li-token", "202");
    // Only the try is recorded; nothing to clear.
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][0].data.metadata).toEqual({
      organizations: [{ id: "202" }],
      username: null,
      organizationsFetchedAt: null,
      organizationsTriedAt: NOW.toISOString(),
    });
  });

  it("answers counts only, never a token", async () => {
    findManyMock.mockResolvedValue([connection()]);
    lookupOrganizationMock.mockResolvedValue({ id: "101", name: "Vibe Surf School" });

    expect(JSON.stringify(await refreshLinkedInOrganizationProfiles(NOW))).not.toContain("li-token");
  });
});

// R35 platform-clients L1: the sweep step stays far inside Vercel's 300 s, as
// backfillGbpLocationTitles does: at most 25 lookups and 120 s a run, the rows
// that need it most first, so the ones not reached come first the next day.
describe("refreshLinkedInOrganizationProfiles: bounded", () => {
  const row = (id: string, fetchedDaysAgo: number | null, over: { expiresAt?: Date | null } = {}) => ({
    ...connection(over),
    id,
    metadata: {
      organizations: [{ id: `org-${id}`, name: `Name ${id}` }],
      username: `Name ${id}`,
      ...(fetchedDaysAgo === null ? {} : { organizationsFetchedAt: daysAgo(fetchedDaysAgo) }),
    },
  });
  const lookedUp = () => lookupOrganizationMock.mock.calls.map((call) => call[1]);

  it("caps a run at 25 lookups, as the Business Profile step", () => {
    expect(LINKEDIN_ORG_REFRESH_MAX_PER_RUN).toBe(25);
    expect(LINKEDIN_ORG_REFRESH_BUDGET_MS).toBe(120_000);
  });

  it("a lookup that timed out leaves that name alone, and the loop goes on", async () => {
    findManyMock.mockResolvedValue([row("a", 3), row("b", 2)]);
    lookupOrganizationMock.mockImplementation(async (_token: string, id: string) =>
      id === "org-a" ? null : { id, name: "New B" },
    );

    expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 1, cleared: 0 });
    expect(lookedUp()).toEqual(["org-a", "org-b"]);
    // "a" records only its try; its name stays.
    expect(updateMock).toHaveBeenCalledTimes(2);
    const byId = Object.fromEntries(updateMock.mock.calls.map((call) => [call[0].where.id, call[0].data.metadata]));
    expect(byId.a.organizations).toEqual([{ id: "org-a", name: "Name a" }]);
    expect(byId.a.username).toBe("Name a");
    expect(byId.a.organizationsFetchedAt).toBe(daysAgo(3));
    expect(byId.a.organizationsTriedAt).toBe(NOW.toISOString());
    expect(byId.b.username).toBe("New B");
  });

  it("the cap stops the lookups", async () => {
    const rows = Array.from({ length: 30 }, (_, index) => row(`r${index}`, 1));
    findManyMock.mockResolvedValue(rows);
    lookupOrganizationMock.mockImplementation(async (_token: string, id: string) => ({ id, name: "Fresh" }));

    expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 25, cleared: 0 });
    expect(lookupOrganizationMock).toHaveBeenCalledTimes(25);
  });

  it("the time budget stops the lookups", async () => {
    findManyMock.mockResolvedValue([row("a", 5), row("b", 4), row("c", 3), row("d", 2)]);
    let at = 0;
    const clock = () => at;
    lookupOrganizationMock.mockImplementation(async (_token: string, id: string) => {
      at += 50_000; // each lookup takes 50 s
      return { id, name: "Fresh" };
    });

    // 0 s, 50 s, 100 s start; at 150 s the budget (120 s) is spent.
    expect(await refreshLinkedInOrganizationProfiles(NOW, clock)).toEqual({ refreshed: 3, cleared: 0 });
    expect(lookedUp()).toEqual(["org-a", "org-b", "org-c"]);
  });

  it("looks up the rows never read first, then the oldest read", async () => {
    findManyMock.mockResolvedValue([row("fresh", 1), row("never", null), row("old", 20), row("mid", 5)]);
    lookupOrganizationMock.mockImplementation(async (_token: string, id: string) => ({ id, name: "Fresh" }));

    await refreshLinkedInOrganizationProfiles(NOW);

    expect(lookedUp()).toEqual(["org-never", "org-old", "org-mid", "org-fresh"]);
  });

  it("the eight-week clean-up still runs for rows past the cap or the budget", async () => {
    const rows = [
      ...Array.from({ length: 25 }, (_, index) => row(`r${index}`, 57)),
      row("z-late", 57), // ties go by id: "z-late" comes last
    ];
    findManyMock.mockResolvedValue(rows);
    let at = 0;
    lookupOrganizationMock.mockImplementation(async (_token: string, id: string) => {
      at += 1_000;
      return id === "org-r0" ? { id, name: "Fresh" } : null;
    });

    const summary = await refreshLinkedInOrganizationProfiles(NOW, () => at);

    expect(lookupOrganizationMock).toHaveBeenCalledTimes(25);
    expect(lookedUp()).not.toContain("org-z-late");
    expect(summary).toEqual({ refreshed: 1, cleared: 25 });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "z-late", updatedAt: READ_AT },
      data: { metadata: { organizations: [{ id: "org-z-late" }], username: null, organizationsFetchedAt: null } },
    });

    // Budget spent before the first lookup: no LinkedIn call, the clean-up as usual.
    vi.clearAllMocks();
    updateMock.mockResolvedValue({ count: 1 });
    findManyMock.mockResolvedValue([row("x", 57), row("y", 3)]);
    let calls = 0;
    const late = () => (calls++ === 0 ? 0 : LINKEDIN_ORG_REFRESH_BUDGET_MS + 1);
    expect(await refreshLinkedInOrganizationProfiles(NOW, late)).toEqual({ refreshed: 0, cleared: 1 });
    expect(lookupOrganizationMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(1);
  });
});

// Lead review (R35): a lookup that keeps failing (lost page admin, app removed
// on LinkedIn) writes no read time, and a row cleared at eight weeks has none,
// so ordering by the read time alone kept those rows first every day. Rows are
// picked by the later of last tried and last read, never-tried first, then id.
describe("refreshLinkedInOrganizationProfiles: which rows are tried", () => {
  type Meta = Record<string, unknown>;
  const row = (id: string, metadata: Meta) => ({ ...connection(), id, metadata });
  const named = (id: string, readDaysAgo: number | null, extra: Meta = {}) =>
    row(id, {
      organizations: [{ id: `org-${id}`, name: `Name ${id}` }],
      username: `Name ${id}`,
      ...(readDaysAgo === null ? {} : { organizationsFetchedAt: daysAgo(readDaysAgo) }),
      ...extra,
    });
  const lookedUp = () => lookupOrganizationMock.mock.calls.map((call) => call[1] as string);

  it("rows that keep failing don't starve a healthy one across two runs", async () => {
    // 30 broken rows, already cleared (no name, no read time), and one healthy row read 50 days ago.
    const broken = Array.from({ length: 30 }, (_, index) => {
      const id = `x${String(index).padStart(2, "0")}`;
      return row(id, { organizations: [{ id: `org-${id}` }], username: null, organizationsFetchedAt: null });
    });
    let rows = [...broken, named("healthy", 50)];

    const run = async (at: Date) => {
      vi.clearAllMocks();
      updateMock.mockResolvedValue({ count: 1 });
      findManyMock.mockResolvedValue(rows);
      lookupOrganizationMock.mockImplementation(async (_token: string, id: string) =>
        id === "org-healthy" ? { id, name: "Healthy" } : null,
      );
      await refreshLinkedInOrganizationProfiles(at);
      // The next day's rows carry this run's writes.
      const writes = new Map(updateMock.mock.calls.map((call) => [call[0].where.id as string, call[0].data.metadata]));
      rows = rows.map((r) => (writes.has(r.id) ? { ...r, metadata: writes.get(r.id) } : r));
      return lookedUp();
    };

    const first = await run(NOW);
    expect(first).toHaveLength(25);
    expect(first).not.toContain("org-healthy");
    const second = await run(new Date(NOW.getTime() + DAY));
    // The five broken rows not reached on day one go first on day two, then the healthy one.
    expect(second.slice(0, 6)).toEqual(["org-x25", "org-x26", "org-x27", "org-x28", "org-x29", "org-healthy"]);
    expect(rows.find((r) => r.id === "healthy")?.metadata.username).toBe("Healthy");
  });

  it("orders by the later of last tried and last read, never tried first, ties by id", async () => {
    findManyMock.mockResolvedValue([
      named("d", 20, { organizationsTriedAt: daysAgo(1) }), // tried yesterday: last
      named("c", 10),
      named("b", null),
      named("a", null),
      named("e", 30, { organizationsTriedAt: daysAgo(10) }), // the later is 10 days: ties with c
    ]);
    lookupOrganizationMock.mockResolvedValue(null);

    await refreshLinkedInOrganizationProfiles(NOW);

    expect(lookedUp()).toEqual(["org-a", "org-b", "org-c", "org-e", "org-d"]);
  });

  it("the order does not depend on the order the database answers in", async () => {
    const rows = [named("m", null), named("k", null), named("l", 5), named("j", 5)];
    lookupOrganizationMock.mockResolvedValue(null);
    findManyMock.mockResolvedValue(rows);
    await refreshLinkedInOrganizationProfiles(NOW);
    const once = lookedUp();
    vi.clearAllMocks();
    updateMock.mockResolvedValue({ count: 1 });
    lookupOrganizationMock.mockResolvedValue(null);
    findManyMock.mockResolvedValue([...rows].reverse());
    await refreshLinkedInOrganizationProfiles(NOW);
    expect(lookedUp()).toEqual(once);
    expect(once).toEqual(["org-k", "org-m", "org-j", "org-l"]);
  });

  it("a row not tried (an expired token) gets no try recorded", async () => {
    findManyMock.mockResolvedValue([{ ...named("old", 3), expiresAt: new Date(NOW.getTime() - DAY) }]);

    expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 0, cleared: 0 });
    expect(lookupOrganizationMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

// Lead review (R35, second look): the run's copy of a row can be minutes old by
// the time it writes. A reconnect meanwhile (another company page chosen) must
// not get the old organizations back, or the next posts go to the old page.
// Every write is guarded: the stored tokens are still the ones this run read
// (the 401-flagging rule) and the row is unchanged since (updatedAt).
describe("refreshLinkedInOrganizationProfiles: never writes over a newer row", () => {
  const reconnected = () => findUniqueMock.mockResolvedValue({ accessToken: "new-token", refreshToken: null });

  it("a reconnect after the read: no write on a success", async () => {
    findManyMock.mockResolvedValue([connection()]);
    lookupOrganizationMock.mockResolvedValue({ id: "101", name: "Vibe Surf School" });
    reconnected();

    expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 0, cleared: 0 });
    expect(findUniqueMock).toHaveBeenCalledWith({ where: { id: "conn-1" }, select: { accessToken: true, refreshToken: true } });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a reconnect after the read: no write on a failure", async () => {
    findManyMock.mockResolvedValue([connection()]);
    lookupOrganizationMock.mockResolvedValue(null);
    reconnected();

    expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 0, cleared: 0 });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a reconnect after the read: no clean-up write", async () => {
    findManyMock.mockResolvedValue([
      connection({
        expiresAt: new Date(NOW.getTime() - DAY),
        metadata: { organizations: [{ id: "101", name: "Old Name" }], username: "Old Name", organizationsFetchedAt: daysAgo(57) },
      }),
    ]);
    reconnected();

    expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 0, cleared: 0 });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("the row gone after the read: no write", async () => {
    findManyMock.mockResolvedValue([connection()]);
    lookupOrganizationMock.mockResolvedValue({ id: "101", name: "Vibe Surf School" });
    findUniqueMock.mockResolvedValue(null);

    expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 0, cleared: 0 });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("an unchanged row writes as before, only if it is still unchanged", async () => {
    findManyMock.mockResolvedValue([connection()]);
    lookupOrganizationMock.mockResolvedValue({ id: "101", name: "Vibe Surf School" });

    expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 1, cleared: 0 });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][0].where).toEqual({ id: "conn-1", updatedAt: READ_AT });
  });

  // The clean-up's own retry is in the describe below.
  it("another metadata change in between (a page choice, same tokens) is not written over", async () => {
    for (const lookup of [{ id: "101", name: "Vibe Surf School" }, null]) {
      vi.clearAllMocks();
      findManyMock.mockResolvedValue([connection()]);
      lookupOrganizationMock.mockResolvedValue(lookup);
      // The row's updatedAt moved on, so the guarded write matches nothing.
      updateMock.mockResolvedValue({ count: 0 });

      expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 0, cleared: 0 });
      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(updateMock.mock.calls[0][0].where).toEqual({ id: "conn-1", updatedAt: READ_AT });
    }
  });
});

// Lead review (R35, last look): a flag-only write (refreshFailedAt,
// markConnectionNeedsReconnect) moves updatedAt and leaves the tokens, so the
// guarded clean-up matched nothing and an over-age name stayed, with nothing
// bounding how often. It re-reads the row once and clears from the fresh copy;
// a reconnect still skips it (the new connection has fresh data).
describe("refreshLinkedInOrganizationProfiles: the eight-week clean-up after a moved row", () => {
  const LATER = new Date("2026-11-09T11:59:30.000Z");
  const OVER_AGE = { organizations: [{ id: "101", name: "Old Name" }], username: "Old Name", organizationsFetchedAt: daysAgo(57) };
  const FULL_SELECT = { accessToken: true, refreshToken: true, metadata: true, updatedAt: true };
  const fresh = (over: Record<string, unknown> = {}) => ({
    accessToken: "li-token",
    refreshToken: null,
    metadata: { ...OVER_AGE, needsAnotherField: "kept" },
    updatedAt: LATER,
    ...over,
  });

  beforeEach(() => {
    // No answer queued by an earlier test reaches these.
    updateMock.mockReset();
    updateMock.mockResolvedValue({ count: 1 });
    // An expired token: no lookup, only the clean-up.
    findManyMock.mockResolvedValue([connection({ expiresAt: new Date(NOW.getTime() - DAY), metadata: { ...OVER_AGE } })]);
  });

  it("a flag write in between: the clean-up lands on the retry, from the fresh copy", async () => {
    findUniqueMock.mockImplementation(async (args: { select: Record<string, boolean> }) =>
      args.select.metadata ? fresh() : { accessToken: "li-token", refreshToken: null },
    );
    updateMock.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 0, cleared: 1 });
    expect(findUniqueMock).toHaveBeenCalledWith({ where: { id: "conn-1" }, select: FULL_SELECT });
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock.mock.calls[1][0]).toEqual({
      where: { id: "conn-1", updatedAt: LATER },
      data: {
        metadata: {
          organizations: [{ id: "101" }],
          username: null,
          organizationsFetchedAt: null,
          needsAnotherField: "kept",
        },
      },
    });
  });

  it("a reconnect in between: no clean-up", async () => {
    findUniqueMock.mockImplementation(async (args: { select: Record<string, boolean> }) =>
      args.select.metadata ? fresh({ accessToken: "new-token" }) : { accessToken: "li-token", refreshToken: null },
    );
    updateMock.mockResolvedValue({ count: 0 });

    expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 0, cleared: 0 });
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("the fresh copy was read from LinkedIn meanwhile: nothing to clear", async () => {
    findUniqueMock.mockImplementation(async (args: { select: Record<string, boolean> }) =>
      args.select.metadata
        ? fresh({ metadata: { ...OVER_AGE, organizationsFetchedAt: daysAgo(0) } })
        : { accessToken: "li-token", refreshToken: null },
    );
    updateMock.mockResolvedValue({ count: 0 });

    expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 0, cleared: 0 });
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("two moves in a row: one retry, then it stops", async () => {
    findUniqueMock.mockImplementation(async (args: { select: Record<string, boolean> }) =>
      args.select.metadata ? fresh() : { accessToken: "li-token", refreshToken: null },
    );
    updateMock.mockResolvedValue({ count: 0 });

    expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 0, cleared: 0 });
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(findUniqueMock.mock.calls.filter((call) => call[0].select.metadata)).toHaveLength(1);
  });

  it("success and failure writes do not retry", async () => {
    findManyMock.mockResolvedValue([connection()]);
    for (const lookup of [{ id: "101", name: "Vibe Surf School" }, null]) {
      updateMock.mockClear();
      findUniqueMock.mockClear();
      lookupOrganizationMock.mockResolvedValue(lookup);
      updateMock.mockResolvedValue({ count: 0 });
      await refreshLinkedInOrganizationProfiles(NOW);
      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(findUniqueMock.mock.calls.some((call) => call[0].select.metadata)).toBe(false);
    }
  });
});
