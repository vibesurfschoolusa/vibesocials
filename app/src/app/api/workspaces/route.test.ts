import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// settings/route.test.ts / workspace.test.ts). route.ts imports `@/lib/db`
// and `@/lib/workspace` at module scope, so both must be mocked before
// route.ts is imported below.
const {
  findManyMock,
  getWorkspaceContextMock,
  countMock,
  transactionMock,
  workspaceCreateMock,
  memberCreateMock,
  checkRateLimitMock,
  cookieSetMock,
  cookiesMock,
} = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  getWorkspaceContextMock: vi.fn(),
  countMock: vi.fn(),
  transactionMock: vi.fn(),
  workspaceCreateMock: vi.fn(),
  memberCreateMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  cookieSetMock: vi.fn(),
  cookiesMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findMany: findManyMock, count: countMock },
    $transaction: transactionMock,
  },
}));

vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
  ACTIVE_WORKSPACE_COOKIE: "vs_active_workspace",
}));

vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: checkRateLimitMock,
}));

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
}));

import { GET, MAX_OWNED_WORKSPACES, POST } from "./route";

function makeContext(overrides: Partial<{ userId: string; workspaceId: string }> = {}) {
  const userId = overrides.userId ?? "user-1";
  const workspaceId = overrides.workspaceId ?? "ws-active";
  return {
    user: { id: userId, email: "owner@example.com", name: "Owner" },
    workspace: { id: workspaceId, name: "Active workspace", companyWebsite: null, defaultHashtags: null },
    role: "owner" as const,
    memberCount: 1,
  };
}

function makeMembershipRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    workspaceId: "ws-active",
    role: "owner",
    createdAt: new Date("2020-01-01T00:00:00Z"),
    workspace: { id: "ws-active", name: "Active workspace" },
    ...overrides,
  };
}

beforeEach(() => {
  findManyMock.mockReset();
  getWorkspaceContextMock.mockReset();
  countMock.mockReset();
  transactionMock.mockReset();
  workspaceCreateMock.mockReset();
  memberCreateMock.mockReset();
  checkRateLimitMock.mockReset();
  cookieSetMock.mockReset();
  cookiesMock.mockReset();

  checkRateLimitMock.mockResolvedValue({ allowed: true });
  cookiesMock.mockResolvedValue({ set: cookieSetMock });
  countMock.mockResolvedValue(1);
  workspaceCreateMock.mockImplementation(async ({ data }: { data: { name: string } }) => ({ id: "ws-new", name: data.name }));
  memberCreateMock.mockResolvedValue({});
  // The route runs its writes in an interactive transaction: hand it a tx.
  transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ workspace: { create: workspaceCreateMock }, workspaceMember: { create: memberCreateMock } }),
  );
});

function createRequest(body: unknown): Request {
  return new Request("http://localhost/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// 2026-11-08: one workspace per client. "New workspace" in the account menu
// creates one, makes the caller its owner and switches to it.
describe("POST /api/workspaces", () => {
  it("returns 401 and creates nothing when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await POST(createRequest({ name: "Sunrise Surf Co." }));

    expect(response.status).toBe(401);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("creates the workspace with the caller as owner, in one transaction, and makes it active", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeContext());

    const response = await POST(createRequest({ name: "  Sunrise   Surf Co.  " }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      workspace: { id: "ws-new", name: "Sunrise Surf Co.", role: "owner", isActive: true },
    });
    expect(workspaceCreateMock).toHaveBeenCalledWith({ data: { name: "Sunrise Surf Co." } });
    expect(memberCreateMock).toHaveBeenCalledWith({
      data: { workspaceId: "ws-new", userId: "user-1", role: "owner" },
    });
    expect(cookieSetMock).toHaveBeenCalledWith(
      "vs_active_workspace",
      "ws-new",
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }),
    );
  });

  it.each([[""], ["   "], ["x".repeat(61)], [42], [null]])("400s a missing or too-long name (%j)", async (name) => {
    getWorkspaceContextMock.mockResolvedValue(makeContext());

    const response = await POST(createRequest({ name }));

    expect(response.status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("409s once the caller owns the maximum number of workspaces", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeContext());
    countMock.mockResolvedValue(MAX_OWNED_WORKSPACES);

    const response = await POST(createRequest({ name: "One too many" }));

    expect(response.status).toBe(409);
    expect(countMock).toHaveBeenCalledWith({ where: { userId: "user-1", role: "owner" } });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("429s with Retry-After when the create rate limit blocks", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeContext());
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });

    const response = await POST(createRequest({ name: "Sunrise Surf Co." }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("120");
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/workspaces", () => {
  it("returns 401 and never queries memberships when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("returns every membership with role and isActive, scoped to the caller", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeContext());
    findManyMock.mockResolvedValue([
      makeMembershipRow({
        workspaceId: "ws-personal",
        role: "owner",
        workspace: { id: "ws-personal", name: "Personal workspace" },
      }),
      makeMembershipRow({
        workspaceId: "ws-active",
        role: "member",
        workspace: { id: "ws-active", name: "Active workspace" },
      }),
    ]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      workspaces: [
        { id: "ws-personal", name: "Personal workspace", role: "owner", isActive: false },
        { id: "ws-active", name: "Active workspace", role: "member", isActive: true },
      ],
    });
    expect(findManyMock).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      include: { workspace: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("marks isActive false for every workspace when none match the context's active id", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeContext({ workspaceId: "ws-active" }));
    findManyMock.mockResolvedValue([
      makeMembershipRow({
        workspaceId: "ws-other",
        workspace: { id: "ws-other", name: "Other" },
      }),
    ]);

    const response = await GET();
    const body = await response.json();

    expect(body.workspaces).toEqual([
      { id: "ws-other", name: "Other", role: "owner", isActive: false },
    ]);
  });
});
