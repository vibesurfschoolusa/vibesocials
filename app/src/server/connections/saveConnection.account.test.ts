import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: { socialConnection: { findUnique: h.findUnique, create: h.create, updateMany: h.updateMany } },
}));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { connectionAccountKey, saveSocialConnection } from "./saveConnection";

/**
 * R6 review low 1: one place decides whether a sign-in may replace the
 * workspace's connection for a platform: only with the same platform account,
 * and only if the row still holds the account it compared (no last write wins).
 */

const OWNER = { userId: "user-1", workspaceId: "ws-1" };
const READ_AT = new Date("2026-11-14T10:00:00.000Z");
const WHERE = { workspaceId_platform: { workspaceId: "ws-1", platform: "tiktok" } };

function row(fields: Record<string, unknown>) {
  return { id: "conn-1", updatedAt: READ_AT, needsReconnect: true, ...fields };
}

function save(accountIdentifier: string, metadata: Record<string, unknown> = {}, signedInName: string | null = "New Name") {
  return saveSocialConnection({
    ...OWNER,
    platform: "tiktok",
    signedInName,
    create: { accountIdentifier, accessToken: "a", metadata: metadata as Prisma.InputJsonValue },
    update: { accountIdentifier, accessToken: "a", metadata: metadata as Prisma.InputJsonValue },
  });
}

function savePinterest(accountId: string, username: string) {
  const metadata = { username, accountId } as Prisma.InputJsonValue;
  return saveSocialConnection({
    ...OWNER,
    platform: "pinterest",
    signedInName: username,
    create: { accountIdentifier: username, accessToken: "a", metadata },
    update: { accountIdentifier: username, accessToken: "a", metadata },
  });
}

function saveGbp() {
  return saveSocialConnection({
    ...OWNER,
    platform: "google_business_profile",
    signedInName: null,
    create: { accountIdentifier: "google_business_profile", accessToken: "new-gbp-token", metadata: { locationName: null } },
    update: { accountIdentifier: "google_business_profile", accessToken: "new-gbp-token" },
  });
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.create.mockResolvedValue({ id: "conn-1" });
  h.updateMany.mockResolvedValue({ count: 1 });
  vi.stubGlobal("fetch", h.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saveSocialConnection", () => {
  it("first connect (no connection): creates it", async () => {
    h.findUnique.mockResolvedValue(null);
    await expect(save("open-1")).resolves.toEqual({ ok: true });
    expect(h.findUnique).toHaveBeenCalledWith({
      where: WHERE,
      select: { id: true, updatedAt: true, platform: true, accountIdentifier: true, metadata: true, needsReconnect: true },
    });
    expect(h.create).toHaveBeenCalledWith({
      data: { userId: "user-1", workspaceId: "ws-1", platform: "tiktok", accountIdentifier: "open-1", accessToken: "a", metadata: {} },
    });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("the same account (flagged or ending): updated in place, only if the row is still the one compared", async () => {
    h.findUnique.mockResolvedValue(row({ platform: "tiktok", accountIdentifier: "open-1", metadata: { username: "Surf TT" } }));
    await expect(save("open-1")).resolves.toEqual({ ok: true });
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: "conn-1", updatedAt: READ_AT },
      data: { accountIdentifier: "open-1", accessToken: "a", metadata: {} },
    });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("a different account: nothing is written, and both names are answered", async () => {
    h.findUnique.mockResolvedValue(row({ platform: "tiktok", accountIdentifier: "open-1", metadata: { username: "Surf TT" } }));
    await expect(save("open-2", {}, "Other TT")).resolves.toEqual({
      ok: false,
      reason: "different_account",
      connectedName: "Surf TT",
      signedInName: "Other TT",
    });
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("after Switch account (disconnected first, so no row): the new account is created", async () => {
    h.findUnique.mockResolvedValue(null);
    await expect(save("open-2", {}, "Other TT")).resolves.toEqual({ ok: true });
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  // R6 second review 3: the two-sign-ins race.
  it("RACE, no row: two different accounts both find none; the second create hits the row the first made and is refused", async () => {
    h.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row({ platform: "tiktok", accountIdentifier: "open-1", metadata: { username: "Surf TT" } }));
    h.create.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));

    await expect(save("open-2", {}, "Other TT")).resolves.toEqual({
      ok: false,
      reason: "different_account",
      connectedName: "Surf TT",
      signedInName: "Other TT",
    });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("RACE, a row: it changed after it was compared (0 rows updated); read again, another account is there now: refused", async () => {
    h.findUnique
      .mockResolvedValueOnce(row({ platform: "tiktok", accountIdentifier: "open-2", metadata: { username: "Old" } }))
      .mockResolvedValueOnce(
        row({ platform: "tiktok", accountIdentifier: "open-1", metadata: { username: "Surf TT" }, updatedAt: new Date(READ_AT.getTime() + 1) }),
      );
    h.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(save("open-2", {}, "Other TT")).resolves.toEqual({
      ok: false,
      reason: "different_account",
      connectedName: "Surf TT",
      signedInName: "Other TT",
    });
    expect(h.updateMany).toHaveBeenCalledTimes(1);
  });

  it("a row that changed but still holds the same account is updated on the next try", async () => {
    const same = { platform: "tiktok", accountIdentifier: "open-1", metadata: {} };
    h.findUnique.mockResolvedValueOnce(row(same)).mockResolvedValueOnce(row({ ...same, updatedAt: new Date(READ_AT.getTime() + 5) }));
    h.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    await expect(save("open-1")).resolves.toEqual({ ok: true });
    expect(h.updateMany.mock.calls[1][0].where).toEqual({ id: "conn-1", updatedAt: new Date(READ_AT.getTime() + 5) });
  });

  it("a stored connection whose account can't be told: updated", async () => {
    h.findUnique.mockResolvedValue(row({ platform: "x", accountIdentifier: "", metadata: {} }));
    const result = await saveSocialConnection({
      ...OWNER,
      platform: "x",
      signedInName: null,
      create: { accountIdentifier: "42", accessToken: "a" },
      update: { accountIdentifier: "42", accessToken: "a" },
    });
    expect(result).toEqual({ ok: true });
    expect(h.updateMany).toHaveBeenCalledTimes(1);
  });
});

// R6 second review 2: Pinterest's account id is stable; a username can change.
describe("saveSocialConnection: Pinterest", () => {
  it("renamed account, same id: updated in place", async () => {
    h.findUnique.mockResolvedValue(row({ platform: "pinterest", accountIdentifier: "oldname", metadata: { username: "oldname", accountId: "9001" } }));
    await expect(savePinterest("9001", "newname")).resolves.toEqual({ ok: true });
    expect(h.updateMany).toHaveBeenCalledTimes(1);
  });

  it("a different id: refused, though the username matches", async () => {
    h.findUnique.mockResolvedValue(row({ platform: "pinterest", accountIdentifier: "brand", metadata: { username: "brand", accountId: "9001" } }));
    await expect(savePinterest("7777", "brand")).resolves.toMatchObject({ ok: false, reason: "different_account" });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("an old row without an account id: compared by username", async () => {
    h.findUnique.mockResolvedValue(row({ platform: "pinterest", accountIdentifier: "brand", metadata: { username: "brand" } }));
    await expect(savePinterest("9001", "brand")).resolves.toEqual({ ok: true });
    h.findUnique.mockResolvedValue(row({ platform: "pinterest", accountIdentifier: "brand", metadata: { username: "brand" } }));
    await expect(savePinterest("9001", "surfco")).resolves.toMatchObject({ ok: false, reason: "different_account" });
  });
});

// R6 third review: for Google Business Profile a reconnect is never refused as
// another account. The new token is saved in place; the chosen location, read
// with it, is kept when it can be read and cleared (so the location chooser
// asks again) when this Google account can't use it.
describe("saveSocialConnection: Google Business Profile", () => {
  const LOCATION_METADATA = {
    locationName: "accounts/1/locations/555",
    locationTitle: "Surf Co Dania",
    reviewsLinkedAt: "2026-11-01T00:00:00.000Z",
  };
  const withLocation = row({
    platform: "google_business_profile",
    accountIdentifier: "google_business_profile",
    metadata: LOCATION_METADATA,
  });
  const withStoreCode = row({
    platform: "google_business_profile",
    accountIdentifier: "google_business_profile",
    metadata: { locationName: "STORE-7", locationTitle: "Surf Co Dania" },
  });
  const answer = (code: number, body: unknown = {}) => new Response(JSON.stringify(body), { status: code });
  const CLEARED = { ...LOCATION_METADATA, locationName: null, locationTitle: null };

  it("the same account (the location reads, 200): the token is saved in place and the location kept", async () => {
    h.findUnique.mockResolvedValue(withLocation);
    h.fetch.mockResolvedValue(answer(200, { name: "locations/555" }));

    await expect(saveGbp()).resolves.toEqual({ ok: true });
    const [url, init] = h.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mybusinessbusinessinformation.googleapis.com/v1/locations/555?readMask=name");
    expect(init.headers).toEqual({ Authorization: "Bearer new-gbp-token" });
    expect(h.updateMany.mock.calls[0][0].data).toEqual({ accountIdentifier: "google_business_profile", accessToken: "new-gbp-token" });
  });

  it.each([
    [403, "another Google account"],
    [404, "the location was deleted on Google"],
  ])("%i (%s): saved in place with the location cleared, and its title answered for the chooser", async (code) => {
    h.findUnique.mockResolvedValue(withLocation);
    h.fetch.mockResolvedValue(answer(code));

    await expect(saveGbp()).resolves.toEqual({ ok: true, locationCleared: "Surf Co Dania" });
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: "conn-1", updatedAt: READ_AT },
      data: { accountIdentifier: "google_business_profile", accessToken: "new-gbp-token", metadata: CLEARED },
    });
  });

  it("a store code this account manages exactly once: kept", async () => {
    h.findUnique.mockResolvedValue(withStoreCode);
    h.fetch
      .mockResolvedValueOnce(answer(200, { accounts: [{ name: "accounts/1" }] }))
      .mockResolvedValueOnce(answer(200, { locations: [{ name: "locations/555", storeCode: "STORE-7" }] }));

    await expect(saveGbp()).resolves.toEqual({ ok: true });
    expect(h.updateMany.mock.calls[0][0].data).not.toHaveProperty("metadata");
  });

  it.each([
    ["not found", []],
    [
      "on more than one location",
      [
        { name: "locations/555", storeCode: "STORE-7" },
        { name: "locations/556", storeCode: "STORE-7" },
      ],
    ],
  ])("a store code %s: the location is cleared for the chooser", async (_case, locations) => {
    h.findUnique.mockResolvedValue(withStoreCode);
    h.fetch
      .mockResolvedValueOnce(answer(200, { accounts: [{ name: "accounts/1" }] }))
      .mockResolvedValueOnce(answer(200, { locations }));

    await expect(saveGbp()).resolves.toEqual({ ok: true, locationCleared: "Surf Co Dania" });
    expect(h.updateMany.mock.calls[0][0].data.metadata).toEqual({ locationName: null, locationTitle: null });
  });

  it("a store-code search where one account's list fails (503): couldn't check, never 'not found'", async () => {
    h.findUnique.mockResolvedValue(withStoreCode);
    h.fetch
      .mockResolvedValueOnce(answer(200, { accounts: [{ name: "accounts/1" }, { name: "accounts/2" }] }))
      .mockResolvedValueOnce(answer(503))
      .mockResolvedValueOnce(answer(200, { locations: [] }));

    await expect(saveGbp()).resolves.toEqual({ ok: false, reason: "check_failed", connectedName: "Surf Co Dania" });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it.each([429, 500, 503])("Google %i on the location: nothing written, try again", async (code) => {
    h.findUnique.mockResolvedValue(withLocation);
    h.fetch.mockResolvedValue(answer(code));
    await expect(saveGbp()).resolves.toEqual({ ok: false, reason: "check_failed", connectedName: "Surf Co Dania" });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("a network failure: nothing written, try again", async () => {
    h.findUnique.mockResolvedValue(withLocation);
    h.fetch.mockRejectedValue(new TypeError("fetch failed"));
    await expect(saveGbp()).resolves.toEqual({ ok: false, reason: "check_failed", connectedName: "Surf Co Dania" });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("no location chosen yet: saved in place as before, without a check", async () => {
    h.findUnique.mockResolvedValue(row({ platform: "google_business_profile", accountIdentifier: "google_business_profile", metadata: { locationName: null } }));
    await expect(saveGbp()).resolves.toEqual({ ok: true });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("connectionAccountKey: what a connection posts as", () => {
  it("LinkedIn: the company page, not the member who signed in", () => {
    expect(
      connectionAccountKey({ platform: "linkedin", accountIdentifier: "member-1", metadata: { organizations: [{ id: 101 }] } }),
    ).toBe("101");
    expect(connectionAccountKey({ platform: "linkedin", accountIdentifier: "member-1", metadata: {} })).toBeNull();
  });

  it("YouTube: the channel id (its title can change)", () => {
    expect(connectionAccountKey({ platform: "youtube", accountIdentifier: "My Channel", metadata: { channelId: "chan-1" } })).toBe(
      "chan-1",
    );
    expect(connectionAccountKey({ platform: "youtube", accountIdentifier: "My Channel", metadata: {} })).toBe("My Channel");
  });

  it("Google Business Profile: none (its token names no account; the location decides)", () => {
    expect(connectionAccountKey({ platform: "google_business_profile", accountIdentifier: "google_business_profile", metadata: {} })).toBeNull();
  });

  it("every other platform: the stored account or page id", () => {
    for (const platform of ["facebook_page", "instagram", "tiktok", "x"] as const) {
      expect(connectionAccountKey({ platform, accountIdentifier: "id-1", metadata: {} })).toBe("id-1");
    }
    expect(connectionAccountKey({ platform: "x", accountIdentifier: "", metadata: {} })).toBeNull();
  });
});
