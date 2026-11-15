import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { socialConnection: { findUnique: h.findUnique, upsert: h.upsert } } }));

import { connectionAccountKey, saveSocialConnection } from "./saveConnection";

/**
 * R6 review low 1: one place decides whether a sign-in may replace the
 * workspace's connection for a platform: only with the same platform account.
 */

const OWNER = { userId: "user-1", workspaceId: "ws-1" };

function save(accountIdentifier: string, metadata: Record<string, unknown> = {}, signedInName: string | null = "New Name") {
  return saveSocialConnection({
    ...OWNER,
    platform: "tiktok",
    signedInName,
    create: { accountIdentifier, accessToken: "a", metadata: metadata as Prisma.InputJsonValue },
    update: { accountIdentifier, accessToken: "a", metadata: metadata as Prisma.InputJsonValue },
  });
}

beforeEach(() => {
  h.findUnique.mockReset();
  h.upsert.mockReset();
  h.upsert.mockResolvedValue({ id: "conn-1" });
});

describe("saveSocialConnection", () => {
  it("first connect (no connection): saves", async () => {
    h.findUnique.mockResolvedValue(null);
    await expect(save("open-1")).resolves.toEqual({ ok: true });
    expect(h.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_platform: { workspaceId: "ws-1", platform: "tiktok" } },
      select: { platform: true, accountIdentifier: true, metadata: true, needsReconnect: true },
    });
    expect(h.upsert).toHaveBeenCalledWith({
      where: { workspaceId_platform: { workspaceId: "ws-1", platform: "tiktok" } },
      create: { userId: "user-1", workspaceId: "ws-1", platform: "tiktok", accountIdentifier: "open-1", accessToken: "a", metadata: {} },
      update: { accountIdentifier: "open-1", accessToken: "a", metadata: {} },
    });
  });

  it("the same account (flagged or ending): replaced in place on the same row, so its numbers stay", async () => {
    h.findUnique.mockResolvedValue({ platform: "tiktok", accountIdentifier: "open-1", metadata: { username: "Surf TT" } });
    await expect(save("open-1")).resolves.toEqual({ ok: true });
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });

  it("a different account: nothing is written, and both names are answered", async () => {
    h.findUnique.mockResolvedValue({ platform: "tiktok", accountIdentifier: "open-1", metadata: { username: "Surf TT" } });
    await expect(save("open-2", {}, "Other TT")).resolves.toEqual({
      ok: false,
      reason: "different_account",
      connectedName: "Surf TT",
      signedInName: "Other TT",
    });
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("after Switch account (disconnected first, so no row): the new account is saved", async () => {
    h.findUnique.mockResolvedValue(null);
    await expect(save("open-2", {}, "Other TT")).resolves.toEqual({ ok: true });
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });

  it("a stored connection whose account can't be told (old placeholder): saves", async () => {
    h.findUnique.mockResolvedValue({ platform: "google_business_profile", accountIdentifier: "google_business_profile", metadata: {} });
    const result = await saveSocialConnection({
      ...OWNER,
      platform: "google_business_profile",
      signedInName: null,
      create: { accountIdentifier: "google-sub-2", accessToken: "a" },
      update: { accountIdentifier: "google-sub-2", accessToken: "a" },
    });
    expect(result).toEqual({ ok: true });
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

  it("Google Business Profile: the Google account, unknown for the old placeholder", () => {
    expect(connectionAccountKey({ platform: "google_business_profile", accountIdentifier: "sub-1", metadata: {} })).toBe("sub-1");
    expect(
      connectionAccountKey({ platform: "google_business_profile", accountIdentifier: "google_business_profile", metadata: {} }),
    ).toBeNull();
  });

  it("every other platform: the stored account or page id", () => {
    for (const platform of ["facebook_page", "instagram", "pinterest", "tiktok", "x"] as const) {
      expect(connectionAccountKey({ platform, accountIdentifier: "id-1", metadata: {} })).toBe("id-1");
    }
    expect(connectionAccountKey({ platform: "x", accountIdentifier: "", metadata: {} })).toBeNull();
  });
});
