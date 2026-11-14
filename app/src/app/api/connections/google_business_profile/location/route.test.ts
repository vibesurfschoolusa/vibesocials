import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireOwnerContextMock, findFirstMock, updateMock, listMock } = vi.hoisted(() => ({
  requireOwnerContextMock: vi.fn(),
  findFirstMock: vi.fn(),
  updateMock: vi.fn(),
  listMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ requireOwnerContext: requireOwnerContextMock }));
vi.mock("@/lib/db", () => ({
  prisma: { socialConnection: { findFirst: findFirstMock, update: updateMock } },
}));

// The locations the connected Google account lists (shared with GET .../locations).
vi.mock("../gbpLocations", () => ({ listGbpLocations: listMock }));

import { POST } from "./route";

const CONTEXT = {
  user: { id: "user-1", email: "owner@example.com", name: "Owner" },
  workspace: { id: "ws-1", name: "Acme" },
  role: "owner" as const,
};

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://localhost/api/connections/google_business_profile/location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-1", ...body }),
    }),
  );

const LISTED = [
  { resourceName: "accounts/1/locations/2", title: "Vibe Surf School", storeCode: null, address: null, accountName: "Vibe" },
  { resourceName: "accounts/1/locations/3", title: "Second Shop", storeCode: "STORE-42", address: null, accountName: "Vibe" },
];

beforeEach(() => {
  vi.clearAllMocks();
  requireOwnerContextMock.mockResolvedValue(CONTEXT);
  findFirstMock.mockResolvedValue({ id: "conn-1", metadata: { locationName: null, other: "kept" } });
  listMock.mockResolvedValue({ ok: true, locations: LISTED, complete: true });
  updateMock.mockImplementation(async (args: { data: { metadata: unknown } }) => ({ id: "conn-1", metadata: args.data.metadata }));
});

describe("POST /api/connections/google_business_profile/location", () => {
  it("is owner-only", async () => {
    requireOwnerContextMock.mockResolvedValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }));

    const res = await post({ locationName: "accounts/1/locations/2" });

    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  // 2026-11-09 first-run check: Settings showed "Connected as
  // google_business_profile" because the location's name was never stored.
  it("stores the location's title with it, keeping the rest of the metadata", async () => {
    const res = await post({ locationName: "accounts/1/locations/2", locationTitle: "  Vibe Surf School  " });

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: {
        metadata: { locationName: "accounts/1/locations/2", locationTitle: "Vibe Surf School", other: "kept" },
      },
    });
  });

  it("clears a stored title when a location is saved without one (a pasted store code)", async () => {
    findFirstMock.mockResolvedValue({
      id: "conn-1",
      metadata: { locationName: "accounts/1/locations/2", locationTitle: "Old Place" },
    });

    await post({ locationName: "STORE-42" });

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: { metadata: { locationName: "STORE-42", locationTitle: null } },
    });
  });

  it("ignores a title that is not text, and caps a long one", async () => {
    await post({ locationName: "accounts/1/locations/2", locationTitle: 7 });
    expect(updateMock.mock.calls[0][0].data.metadata.locationTitle).toBeNull();

    await post({ locationName: "accounts/1/locations/2", locationTitle: "x".repeat(500) });
    expect(updateMock.mock.calls[1][0].data.metadata.locationTitle).toHaveLength(200);
  });

  it("400s without a location", async () => {
    const res = await post({ locationTitle: "Vibe Surf School" });

    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  // F3 (R1 client journey H2): an agency's Google login can see many
  // listings, and a typed resource name could name any listing at all.
  it("400s a location the connected Google account does not list, and saves nothing", async () => {
    const res = await post({ locationName: "accounts/9/locations/2" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error:
        "That location isn't one this Google account manages. Click Fetch locations from Google and choose it from the list.",
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("400s a listed location's id under another account", async () => {
    const res = await post({ locationName: "accounts/7/locations/3" });

    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("accepts a store code of a listed location, saved as typed", async () => {
    const res = await post({ locationName: " STORE-42 " });

    expect(res.status).toBe(200);
    expect(updateMock.mock.calls[0][0].data.metadata.locationName).toBe("STORE-42");
  });

  it("passes on Google's failure to list, and saves nothing", async () => {
    listMock.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Failed to list Google Business Profile accounts" }, { status: 502 }),
    });

    const res = await post({ locationName: "accounts/1/locations/2" });

    expect(res.status).toBe(502);
    expect(updateMock).not.toHaveBeenCalled();
  });

  // F3 (R1 security H1): the active workspace is one cookie for every tab.
  it("409s a page rendered for another workspace before asking Google, and saves nothing", async () => {
    const res = await post({ locationName: "accounts/1/locations/2", workspaceId: "ws-2" });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "WORKSPACE_CHANGED" });
    expect(listMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("400s a request without the workspace id, and saves nothing", async () => {
    const res = await POST(
      new Request("http://localhost/api/connections/google_business_profile/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationName: "accounts/1/locations/2" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("checks the id sent with a form post too", async () => {
    const form = new FormData();
    form.set("locationName", "accounts/1/locations/2");
    form.set("workspaceId", "ws-2");

    const res = await POST(
      new Request("http://localhost/api/connections/google_business_profile/location", { method: "POST", body: form }),
    );

    expect(res.status).toBe(409);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
