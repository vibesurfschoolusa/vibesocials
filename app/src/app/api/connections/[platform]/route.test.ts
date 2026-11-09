import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireOwnerContextMock, connectionDeleteManyMock, metricDeleteManyMock, transactionMock } = vi.hoisted(
  () => ({
    requireOwnerContextMock: vi.fn(),
    connectionDeleteManyMock: vi.fn(),
    metricDeleteManyMock: vi.fn(),
    transactionMock: vi.fn(),
  }),
);

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { deleteMany: connectionDeleteManyMock },
    postMetric: { deleteMany: metricDeleteManyMock },
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

function disconnect(platform: string) {
  return DELETE(new NextRequest(`http://localhost/api/connections/${platform}`, { method: "DELETE" }), {
    params: Promise.resolve({ platform }),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  requireOwnerContextMock.mockResolvedValue(CONTEXT);
  // The route builds the deletes, then runs them (alone, or in a transaction).
  connectionDeleteManyMock.mockReturnValue(Promise.resolve({ count: 1 }));
  metricDeleteManyMock.mockReturnValue(Promise.resolve({ count: 4 }));
  transactionMock.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
});

describe("DELETE /api/connections/[platform]", () => {
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

  it("disconnecting another platform deletes only its connection", async () => {
    const response = await disconnect("facebook_page");

    expect(response.status).toBe(200);
    expect(connectionDeleteManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", platform: "facebook_page" },
    });
    expect(metricDeleteManyMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("400s an unknown platform", async () => {
    const response = await disconnect("myspace");

    expect(response.status).toBe(400);
    expect(connectionDeleteManyMock).not.toHaveBeenCalled();
  });
});
