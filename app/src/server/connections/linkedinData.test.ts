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

import { LINKEDIN_ORG_PROFILE_MAX_AGE_MS, refreshLinkedInOrganizationProfiles } from "./linkedinData";

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
