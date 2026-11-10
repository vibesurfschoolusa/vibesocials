import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireOwnerContextMock, findFirstMock, updateMock } = vi.hoisted(() => ({
  requireOwnerContextMock: vi.fn(),
  findFirstMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ requireOwnerContext: requireOwnerContextMock }));
vi.mock("@/lib/db", () => ({
  prisma: { socialConnection: { findFirst: findFirstMock, update: updateMock } },
}));

import { POST } from "./route";

const CONTEXT = {
  user: { id: "user-1", email: "owner@example.com", name: "Owner" },
  workspace: { id: "ws-1", name: "Acme" },
  role: "owner" as const,
};

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/connections/google_business_profile/location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  requireOwnerContextMock.mockResolvedValue(CONTEXT);
  findFirstMock.mockResolvedValue({ id: "conn-1", metadata: { locationName: null, other: "kept" } });
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
});
