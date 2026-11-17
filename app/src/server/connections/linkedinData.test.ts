import { beforeEach, describe, expect, it, vi } from "vitest";

const { findManyMock, updateMock, lookupOrganizationMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  updateMock: vi.fn(),
  lookupOrganizationMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { socialConnection: { findMany: findManyMock, update: updateMock } },
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

const connection = (over: { expiresAt?: Date | null; metadata?: Record<string, unknown> } = {}) => ({
  id: "conn-1",
  accessToken: "li-token",
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
  updateMock.mockResolvedValue({});
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
      select: { id: true, accessToken: true, expiresAt: true, metadata: true },
    });
    expect(lookupOrganizationMock).toHaveBeenCalledWith("li-token", "101");
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: {
        metadata: {
          name: "LinkedIn User",
          organizations: [{ id: "101", name: "Vibe Surf School", vanityName: "vibe-surf-school" }],
          username: "Vibe Surf School",
          organizationsFetchedAt: NOW.toISOString(),
        },
      },
    });
  });

  it("keeps a name read within eight weeks when this read fails", async () => {
    findManyMock.mockResolvedValue([connection()]);
    lookupOrganizationMock.mockResolvedValue(null);

    expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 0, cleared: 0 });
    expect(updateMock).not.toHaveBeenCalled();
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
      where: { id: "conn-1" },
      data: { metadata: { organizations: [{ id: "101" }], username: null, organizationsFetchedAt: null } },
    });
  });

  it("treats a connection saved before this rule (no read time) as stale when the page cannot be read", async () => {
    findManyMock.mockResolvedValue([
      connection({ metadata: { organizations: [{ id: "101", name: "Old Name" }], username: "Old Name" } }),
    ]);
    lookupOrganizationMock.mockResolvedValue(null);

    expect(await refreshLinkedInOrganizationProfiles(NOW)).toEqual({ refreshed: 0, cleared: 1 });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: { metadata: { organizations: [{ id: "101" }], username: null, organizationsFetchedAt: null } },
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
    expect(updateMock).not.toHaveBeenCalled();
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
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][0].where).toEqual({ id: "b" });
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
      row("late", 57),
    ];
    findManyMock.mockResolvedValue(rows);
    let at = 0;
    lookupOrganizationMock.mockImplementation(async (_token: string, id: string) => {
      at += 1_000;
      return id === "org-r0" ? { id, name: "Fresh" } : null;
    });

    const summary = await refreshLinkedInOrganizationProfiles(NOW, () => at);

    expect(lookupOrganizationMock).toHaveBeenCalledTimes(25);
    expect(lookedUp()).not.toContain("org-late");
    expect(summary).toEqual({ refreshed: 1, cleared: 25 });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "late" },
      data: { metadata: { organizations: [{ id: "org-late" }], username: null, organizationsFetchedAt: null } },
    });

    // Budget spent before the first lookup: no LinkedIn call, the clean-up as usual.
    vi.clearAllMocks();
    updateMock.mockResolvedValue({});
    findManyMock.mockResolvedValue([row("x", 57), row("y", 3)]);
    let calls = 0;
    const late = () => (calls++ === 0 ? 0 : LINKEDIN_ORG_REFRESH_BUDGET_MS + 1);
    expect(await refreshLinkedInOrganizationProfiles(NOW, late)).toEqual({ refreshed: 0, cleared: 1 });
    expect(lookupOrganizationMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(1);
  });
});
