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
  getOperatorMock,
  isOperatorUserMock,
  getCurrentUserMock,
} = vi.hoisted(() => ({
  getOperatorMock: vi.fn(),
  isOperatorUserMock: vi.fn(),
  getCurrentUserMock: vi.fn(),
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

// The real pure check runs (wrapped so a test can make it throw); getOperator
// and the session must never be touched by this route.
vi.mock("@/lib/operator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/operator")>();
  isOperatorUserMock.mockImplementation(actual.isOperatorUser);
  return { ...actual, getOperator: getOperatorMock, isOperatorUser: isOperatorUserMock };
});
vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
}));

import { SUPPORT_EMAIL } from "@/lib/siteInfo";

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
  getOperatorMock.mockReset();
  getCurrentUserMock.mockReset();
  delete process.env.ADMIN_EMAILS;
  // POST reads the caller's owned workspaces for the pause check; none paused.
  findManyMock.mockResolvedValue([]);

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

// Fix round 1 (2026-11-10): a paused owner must not carry on in a new workspace.
describe("POST /api/workspaces while one of the caller's workspaces is paused", () => {
  it("403s before counting or writing anything, with the support address", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeContext());
    findManyMock.mockResolvedValue([
      { workspace: { pausedAt: null, pausedReason: null } },
      { workspace: { pausedAt: new Date("2026-11-10T08:00:00Z"), pausedReason: "Unpaid invoice." } },
    ]);

    const response = await POST(createRequest({ name: "Fresh start" }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: `You cannot create a workspace while one of your workspaces is paused. Contact ${SUPPORT_EMAIL}.`,
      code: "WORKSPACE_PAUSED",
    });
    expect(findManyMock).toHaveBeenCalledWith({
      where: { userId: "user-1", role: "owner" },
      select: { workspace: { select: { pausedAt: true, pausedReason: true } } },
    });
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(countMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("still creates when none of the caller's owned workspaces is paused", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeContext());
    findManyMock.mockResolvedValue([{ workspace: { pausedAt: null, pausedReason: null } }]);

    const response = await POST(createRequest({ name: "Fresh start" }));

    expect(response.status).toBe(201);
  });
});

describe("GET /api/workspaces — the operator's link (fix rounds 1 and 2)", () => {
  function operatorContext(verified: boolean) {
    const context = makeContext();
    return {
      ...context,
      user: { ...context.user, email: "ops@example.com", emailVerifiedAt: verified ? new Date("2026-11-01T00:00:00Z") : null },
    };
  }

  it("decides from the context's user: no second session read, no getOperator", async () => {
    process.env.ADMIN_EMAILS = "ops@example.com";
    getWorkspaceContextMock.mockResolvedValue(operatorContext(true));
    findManyMock.mockResolvedValue([makeMembershipRow()]);

    const body = await (await GET()).json();

    expect(body.operatorLink).toEqual({ href: "/admin", label: "Admin" });
    expect(getOperatorMock).not.toHaveBeenCalled();
    expect(getCurrentUserMock).not.toHaveBeenCalled();
    expect(findManyMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unverified listed user", true, false],
    ["a user who is not listed", false, true],
  ])("carries no link for %s", async (_label, listed, verified) => {
    process.env.ADMIN_EMAILS = listed ? "ops@example.com" : "other@example.com";
    getWorkspaceContextMock.mockResolvedValue(operatorContext(verified));
    findManyMock.mockResolvedValue([makeMembershipRow()]);

    const body = await (await GET()).json();

    expect(Object.keys(body)).toEqual(["workspaces"]);
  });

  it("answers the list without the link when the check fails", async () => {
    process.env.ADMIN_EMAILS = "ops@example.com";
    getWorkspaceContextMock.mockResolvedValue(operatorContext(true));
    findManyMock.mockResolvedValue([makeMembershipRow()]);
    isOperatorUserMock.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(["workspaces"]);
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
