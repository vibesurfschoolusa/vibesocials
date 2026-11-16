import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireOwnerContextMock,
  connectionDeleteManyMock,
  metricDeleteManyMock,
  listingMetricDeleteManyMock,
  pendingDeleteManyMock,
  transactionMock,
} = vi.hoisted(() => ({
  requireOwnerContextMock: vi.fn(),
  connectionDeleteManyMock: vi.fn(),
  metricDeleteManyMock: vi.fn(),
  listingMetricDeleteManyMock: vi.fn(),
  pendingDeleteManyMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { deleteMany: connectionDeleteManyMock },
    postMetric: { deleteMany: metricDeleteManyMock },
    locationMetricDaily: { deleteMany: listingMetricDeleteManyMock },
    pendingConnection: { deleteMany: pendingDeleteManyMock },
    $transaction: transactionMock,
  },
}));

vi.mock("@/lib/workspace", () => ({
  requireOwnerContext: requireOwnerContextMock,
}));

import { DELETE } from "./route";

const CONTEXT = {
  user: { id: "user-1", email: "owner@example.com", name: "Owner" },
  workspace: { id: "ws-1", name: "Acme" },
  role: "owner" as const,
};

function disconnect(platform: string, body: unknown = { workspaceId: "ws-1" }) {
  return DELETE(
    new NextRequest(`http://localhost/api/connections/${platform}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: body === null ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ platform }) } as never,
  );
}

function nothingDeleted() {
  expect(connectionDeleteManyMock).not.toHaveBeenCalled();
  expect(metricDeleteManyMock).not.toHaveBeenCalled();
  expect(listingMetricDeleteManyMock).not.toHaveBeenCalled();
  expect(pendingDeleteManyMock).not.toHaveBeenCalled();
  expect(transactionMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  requireOwnerContextMock.mockResolvedValue(CONTEXT);
  // The route builds the deletes, then runs them (alone, or in a transaction).
  connectionDeleteManyMock.mockReturnValue(Promise.resolve({ count: 1 }));
  metricDeleteManyMock.mockReturnValue(Promise.resolve({ count: 4 }));
  listingMetricDeleteManyMock.mockReturnValue(Promise.resolve({ count: 30 }));
  pendingDeleteManyMock.mockReturnValue(Promise.resolve({ count: 0 }));
  transactionMock.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
});

describe("DELETE /api/connections/[platform]", () => {
  // R31 security-billing L1: an unfinished account choice holds sealed tokens
  // for every account it offered; the privacy page says Disconnect deletes them.
  it("deletes this workspace's waiting account choices for that platform only, in the same transaction", async () => {
    const response = await disconnect("facebook_page");

    expect(response.status).toBe(200);
    expect(pendingDeleteManyMock).toHaveBeenCalledTimes(1);
    expect(pendingDeleteManyMock).toHaveBeenCalledWith({ where: { workspaceId: "ws-1", platform: "facebook_page" } });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(transactionMock.mock.calls[0][0]).toContain(pendingDeleteManyMock.mock.results[0].value);
  });

  it("is owner-only", async () => {
    requireOwnerContextMock.mockResolvedValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }));

    const response = await disconnect("youtube");

    expect(response.status).toBe(403);
    expect(connectionDeleteManyMock).not.toHaveBeenCalled();
  });

  // YouTube API Services policy (2026-11-09): disconnecting YouTube deletes the
  // YouTube data the app keeps for the workspace, in the same transaction.
  it("disconnecting YouTube also deletes the workspace's YouTube statistics, in one transaction", async () => {
    const response = await disconnect("youtube");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, deletedCount: 1 });
    expect(connectionDeleteManyMock).toHaveBeenCalledWith({ where: { workspaceId: "ws-1", platform: "youtube" } });
    expect(metricDeleteManyMock).toHaveBeenCalledWith({ where: { workspaceId: "ws-1", platform: "youtube" } });
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  // F3 (R1 pages H1): disconnecting any platform deletes the numbers read from
  // it, not only YouTube's. A workspace has one connection per platform, so
  // its PostMetric rows for that platform are that connection's.
  it.each(["facebook_page", "instagram", "linkedin", "pinterest", "x", "tiktok"])(
    "disconnecting %s also deletes the workspace's numbers for that platform, in one transaction",
    async (platform) => {
      const response = await disconnect(platform);

      expect(response.status).toBe(200);
      expect(connectionDeleteManyMock).toHaveBeenCalledWith({ where: { workspaceId: "ws-1", platform } });
      expect(metricDeleteManyMock).toHaveBeenCalledWith({ where: { workspaceId: "ws-1", platform } });
      expect(listingMetricDeleteManyMock).not.toHaveBeenCalled();
      expect(transactionMock).toHaveBeenCalledTimes(1);
      expect(transactionMock.mock.calls[0][0]).toHaveLength(3);
    },
  );

  // The listing's daily numbers (LocationMetricDaily) are only ever read
  // through the workspace's one Google Business Profile connection.
  it("disconnecting Google Business Profile also deletes the workspace's listing numbers", async () => {
    const response = await disconnect("google_business_profile");

    expect(response.status).toBe(200);
    expect(connectionDeleteManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", platform: "google_business_profile" },
    });
    expect(metricDeleteManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", platform: "google_business_profile" },
    });
    expect(listingMetricDeleteManyMock).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(transactionMock.mock.calls[0][0]).toHaveLength(4);
  });

  // F3 (R1 security H1): the active workspace is one cookie for every tab.
  it("409s a page rendered for another workspace, and deletes nothing", async () => {
    const response = await disconnect("instagram", { workspaceId: "ws-2" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "WORKSPACE_CHANGED" });
    nothingDeleted();
  });

  it.each([
    ["no body", null],
    ["a body without the id", {}],
  ])("400s %s, and deletes nothing", async (_label, body) => {
    const response = await disconnect("instagram", body);

    expect(response.status).toBe(400);
    nothingDeleted();
  });

  it("400s an unknown platform", async () => {
    const response = await disconnect("myspace");

    expect(response.status).toBe(400);
    expect(connectionDeleteManyMock).not.toHaveBeenCalled();
  });
});
