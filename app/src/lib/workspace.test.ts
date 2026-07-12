import type { User, Workspace, WorkspaceMember, WorkspaceRole } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// settings/route.test.ts / posting.test.ts). workspace.ts imports `@/lib/db`
// (a real `new PrismaClient()`), `@/lib/auth` (next-auth session lookup), and
// `next/headers` (request-scoped cookies) at module scope, so all three must
// be mocked before workspace.ts is imported below.
const {
  findFirstMock,
  findManyMock,
  findUniqueUserMock,
  countMock,
  workspaceCreateMock,
  workspaceMemberCreateMock,
  executeRawMock,
  getCurrentUserMock,
  cookiesGetMock,
  cookiesMock,
} = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  findManyMock: vi.fn(),
  findUniqueUserMock: vi.fn(),
  countMock: vi.fn(),
  workspaceCreateMock: vi.fn(),
  workspaceMemberCreateMock: vi.fn(),
  executeRawMock: vi.fn(),
  getCurrentUserMock: vi.fn(),
  cookiesGetMock: vi.fn(),
  cookiesMock: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  // $transaction's mock replays the callback against this same object, so
  // `tx.<model>.<op>` inside a transaction resolves to these same mocks
  // (mirrors posting.test.ts's $transaction mock). `$executeRaw` receives the
  // per-user pg_advisory_xact_lock the provisioning core takes (review fix
  // round 1 — TOCTOU double-provision guard).
  const prisma: Record<string, unknown> = {
    $executeRaw: executeRawMock,
    user: { findUnique: findUniqueUserMock },
    workspace: { create: workspaceCreateMock },
    workspaceMember: {
      findFirst: findFirstMock,
      findMany: findManyMock,
      count: countMock,
      create: workspaceMemberCreateMock,
    },
    $transaction: (cb: (tx: unknown) => unknown) => cb(prisma),
  };
  return { prisma };
});

vi.mock("@/lib/auth", () => ({
  getCurrentUser: getCurrentUserMock,
}));

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
}));

import { NextResponse } from "next/server";

import {
  ACTIVE_WORKSPACE_COOKIE,
  getWorkspaceContext,
  provisionPersonalWorkspace,
  requireOwnerContext,
  resolveActiveMembershipId,
  resolveWorkspaceForUser,
  WorkspaceForbiddenError,
} from "./workspace";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "user@example.com",
    name: "Klaus",
    passwordHash: null,
    companyWebsite: null,
    defaultHashtags: null,
    notifyOnPostComplete: true,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2020-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeMembership(
  overrides: Partial<WorkspaceMember & { workspace: Workspace }> = {},
): WorkspaceMember & { workspace: Workspace } {
  const workspaceId = overrides.workspaceId ?? "workspace-1";
  return {
    id: `member-${workspaceId}`,
    workspaceId,
    userId: "user-1",
    role: "member",
    createdAt: new Date("2020-01-01T00:00:00Z"),
    workspace: {
      id: workspaceId,
      name: "Test workspace",
      companyWebsite: null,
      defaultHashtags: null,
      createdAt: new Date("2020-01-01T00:00:00Z"),
      updatedAt: new Date("2020-01-01T00:00:00Z"),
    },
    ...overrides,
  };
}

beforeEach(() => {
  findFirstMock.mockReset();
  findManyMock.mockReset();
  findUniqueUserMock.mockReset();
  countMock.mockReset();
  workspaceCreateMock.mockReset();
  workspaceMemberCreateMock.mockReset();
  executeRawMock.mockReset();
  getCurrentUserMock.mockReset();
  cookiesGetMock.mockReset();
  cookiesMock.mockReset();

  cookiesGetMock.mockReturnValue(undefined);
  cookiesMock.mockResolvedValue({ get: cookiesGetMock });
});

describe("resolveActiveMembershipId (pure)", () => {
  type Membership = { workspaceId: string; role: WorkspaceRole; createdAt: Date };

  const owned: Membership = {
    workspaceId: "ws-owned",
    role: "owner",
    createdAt: new Date("2020-01-02T00:00:00Z"),
  };
  const olderOwned: Membership = {
    workspaceId: "ws-older-owned",
    role: "owner",
    createdAt: new Date("2020-01-01T00:00:00Z"),
  };
  const member: Membership = {
    workspaceId: "ws-member",
    role: "member",
    createdAt: new Date("2019-01-01T00:00:00Z"),
  };

  it("returns null for an empty membership list", () => {
    expect(resolveActiveMembershipId([], "anything")).toBeNull();
    expect(resolveActiveMembershipId([], undefined)).toBeNull();
  });

  it("returns the cookie's workspace when it matches a membership", () => {
    expect(resolveActiveMembershipId([olderOwned, owned, member], "ws-member")).toBe(
      "ws-member",
    );
  });

  it("falls back to the oldest OWNED membership when the cookie matches nothing", () => {
    expect(
      resolveActiveMembershipId([owned, olderOwned, member], "no-such-workspace"),
    ).toBe("ws-older-owned");
  });

  it("falls back to the oldest OWNED membership when the cookie is absent", () => {
    expect(resolveActiveMembershipId([owned, olderOwned, member], undefined)).toBe(
      "ws-older-owned",
    );
  });

  it("falls back to the oldest membership of any role when none is owned", () => {
    const memberA: Membership = {
      workspaceId: "ws-a",
      role: "member",
      createdAt: new Date("2020-01-05T00:00:00Z"),
    };
    const memberB: Membership = {
      workspaceId: "ws-b",
      role: "member",
      createdAt: new Date("2020-01-03T00:00:00Z"),
    };
    expect(resolveActiveMembershipId([memberA, memberB], undefined)).toBe("ws-b");
    expect(resolveActiveMembershipId([memberA, memberB], "no-such-workspace")).toBe("ws-b");
  });
});

describe("provisionPersonalWorkspace", () => {
  function makeTx() {
    return {
      workspace: { create: workspaceCreateMock },
      workspaceMember: { create: workspaceMemberCreateMock },
    };
  }

  it(`names the workspace "{name}'s workspace" when the user has a name`, async () => {
    workspaceCreateMock.mockResolvedValue({ id: "ws-1" });
    workspaceMemberCreateMock.mockResolvedValue({});

    await provisionPersonalWorkspace(
      makeTx(),
      makeUser({ name: "Klaus", email: "klaus@example.com" }),
    );

    expect(workspaceCreateMock).toHaveBeenCalledWith({
      data: { name: "Klaus's workspace", companyWebsite: null, defaultHashtags: null },
    });
  });

  it("falls back to the email local-part when the name is an empty string", async () => {
    workspaceCreateMock.mockResolvedValue({ id: "ws-2" });
    workspaceMemberCreateMock.mockResolvedValue({});

    await provisionPersonalWorkspace(
      makeTx(),
      makeUser({ name: "", email: "jane.doe@example.com" }),
    );

    expect(workspaceCreateMock).toHaveBeenCalledWith({
      data: { name: "jane.doe's workspace", companyWebsite: null, defaultHashtags: null },
    });
  });

  it("falls back to the email local-part when the name is null", async () => {
    workspaceCreateMock.mockResolvedValue({ id: "ws-3" });
    workspaceMemberCreateMock.mockResolvedValue({});

    await provisionPersonalWorkspace(
      makeTx(),
      makeUser({ name: null, email: "noname@example.com" }),
    );

    expect(workspaceCreateMock).toHaveBeenCalledWith({
      data: { name: "noname's workspace", companyWebsite: null, defaultHashtags: null },
    });
  });

  it("copies companyWebsite/defaultHashtags from the user onto the workspace", async () => {
    workspaceCreateMock.mockResolvedValue({ id: "ws-4" });
    workspaceMemberCreateMock.mockResolvedValue({});

    await provisionPersonalWorkspace(
      makeTx(),
      makeUser({ companyWebsite: "https://acme.test", defaultHashtags: "#acme" }),
    );

    expect(workspaceCreateMock).toHaveBeenCalledWith({
      data: {
        name: "Klaus's workspace",
        companyWebsite: "https://acme.test",
        defaultHashtags: "#acme",
      },
    });
  });

  it("creates an owner membership linking the user to the new workspace", async () => {
    workspaceCreateMock.mockResolvedValue({ id: "ws-5" });
    workspaceMemberCreateMock.mockResolvedValue({});

    const result = await provisionPersonalWorkspace(makeTx(), makeUser({ id: "user-9" }));

    expect(workspaceMemberCreateMock).toHaveBeenCalledWith({
      data: { workspaceId: "ws-5", userId: "user-9", role: "owner" },
    });
    expect(result).toEqual({ workspaceId: "ws-5" });
  });
});

describe("resolveWorkspaceForUser", () => {
  it("returns the oldest OWNED membership's workspaceId without provisioning", async () => {
    findFirstMock.mockResolvedValue({ workspaceId: "ws-existing" });

    const workspaceId = await resolveWorkspaceForUser("user-1");

    expect(workspaceId).toBe("ws-existing");
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { userId: "user-1", role: "owner" },
      orderBy: { createdAt: "asc" },
    });
    expect(workspaceCreateMock).not.toHaveBeenCalled();
  });

  it("takes no advisory lock on the fast path (owned membership already exists)", async () => {
    findFirstMock.mockResolvedValue({ workspaceId: "ws-existing" });

    await resolveWorkspaceForUser("user-1");

    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it("lazily provisions a personal workspace when the user owns none yet", async () => {
    findFirstMock.mockResolvedValue(null);
    findUniqueUserMock.mockResolvedValue(makeUser({ id: "user-2", name: "New Guy" }));
    workspaceCreateMock.mockResolvedValue({ id: "ws-new" });
    workspaceMemberCreateMock.mockResolvedValue({});

    const workspaceId = await resolveWorkspaceForUser("user-2");

    expect(workspaceId).toBe("ws-new");
    expect(workspaceCreateMock).toHaveBeenCalledWith({
      data: { name: "New Guy's workspace", companyWebsite: null, defaultHashtags: null },
    });
    expect(workspaceMemberCreateMock).toHaveBeenCalledWith({
      data: { workspaceId: "ws-new", userId: "user-2", role: "owner" },
    });
    // Review fix round 1: provisioning happens strictly AFTER the per-user
    // advisory lock is taken.
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      workspaceCreateMock.mock.invocationCallOrder[0],
    );
  });

  it("throws when the user no longer exists", async () => {
    findFirstMock.mockResolvedValue(null);
    findUniqueUserMock.mockResolvedValue(null);

    await expect(resolveWorkspaceForUser("ghost")).rejects.toThrow(/ghost/);
    expect(workspaceCreateMock).not.toHaveBeenCalled();
  });

  // Review fix round 1 (TOCTOU): two concurrent first-touch requests for a
  // zero-membership user must not BOTH provision. The provisioning core takes
  // a per-user pg_advisory_xact_lock and re-checks membership INSIDE the lock,
  // so the race loser adopts the winner's workspace instead of creating a
  // second one.
  describe("concurrent first-touch (advisory-locked re-check)", () => {
    it("returns the racing winner's workspace from the in-lock re-check without provisioning", async () => {
      // Fast path (call 1) misses; by the time the lock is held, a concurrent
      // request has provisioned — the in-lock re-check (call 2) finds it.
      findFirstMock
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ workspaceId: "ws-race-winner" });

      const workspaceId = await resolveWorkspaceForUser("user-1");

      expect(workspaceId).toBe("ws-race-winner");
      expect(findFirstMock).toHaveBeenCalledTimes(2);
      expect(workspaceCreateMock).not.toHaveBeenCalled();
      expect(workspaceMemberCreateMock).not.toHaveBeenCalled();
      // The winner's row satisfies the lookup — no need to reload the user.
      expect(findUniqueUserMock).not.toHaveBeenCalled();
    });

    it("issues the per-user advisory lock BEFORE the in-lock re-check", async () => {
      findFirstMock
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ workspaceId: "ws-race-winner" });

      await resolveWorkspaceForUser("user-1");

      expect(executeRawMock).toHaveBeenCalledTimes(1);
      // $executeRaw is a tagged-template call: (TemplateStringsArray, ...values).
      // The SQL must be the xact-scoped advisory lock, keyed per user.
      const [strings, lockKey] = executeRawMock.mock.calls[0] as [
        readonly string[],
        string,
      ];
      expect(strings.join("?")).toContain("pg_advisory_xact_lock(hashtext(");
      expect(lockKey).toBe("ws-provision:user-1");
      // Order: fast-path lookup -> advisory lock -> in-lock re-check.
      const lockOrder = executeRawMock.mock.invocationCallOrder[0];
      expect(lockOrder).toBeGreaterThan(findFirstMock.mock.invocationCallOrder[0]);
      expect(lockOrder).toBeLessThan(findFirstMock.mock.invocationCallOrder[1]);
    });
  });
});

describe("getWorkspaceContext", () => {
  it("returns null when unauthenticated, without touching workspace data", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    expect(await getWorkspaceContext()).toBeNull();
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("returns the active workspace context for an authenticated owner", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser());
    findManyMock.mockResolvedValue([makeMembership({ role: "owner" })]);
    countMock.mockResolvedValue(1);

    const context = await getWorkspaceContext();

    expect(context).toEqual({
      user: makeUser(),
      workspace: {
        id: "workspace-1",
        name: "Test workspace",
        companyWebsite: null,
        defaultHashtags: null,
      },
      role: "owner",
      memberCount: 1,
    });
    expect(countMock).toHaveBeenCalledWith({ where: { workspaceId: "workspace-1" } });
  });

  it("self-heals by provisioning a personal workspace when the user has zero memberships", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser({ id: "user-heal" }));
    findManyMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeMembership({ userId: "user-heal", role: "owner", workspaceId: "ws-healed" }),
      ]);
    // The shared provisioning core (review fix round 1): fast-path owned
    // lookup + in-lock re-check both miss, then the user row is reloaded
    // inside the lock for the workspace name rule.
    findFirstMock.mockResolvedValue(null);
    findUniqueUserMock.mockResolvedValue(makeUser({ id: "user-heal" }));
    workspaceCreateMock.mockResolvedValue({ id: "ws-healed" });
    workspaceMemberCreateMock.mockResolvedValue({});
    countMock.mockResolvedValue(1);

    const context = await getWorkspaceContext();

    expect(workspaceCreateMock).toHaveBeenCalledTimes(1);
    expect(workspaceMemberCreateMock).toHaveBeenCalledWith({
      data: { workspaceId: "ws-healed", userId: "user-heal", role: "owner" },
    });
    expect(context?.workspace.id).toBe("ws-healed");
    expect(findManyMock).toHaveBeenCalledTimes(2);
    // Self-heal rides the same advisory-locked core as resolveWorkspaceForUser.
    expect(executeRawMock).toHaveBeenCalledTimes(1);
  });

  it("self-heal adopts a concurrently provisioned workspace instead of double-provisioning", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser({ id: "user-heal" }));
    findManyMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeMembership({ userId: "user-heal", role: "owner", workspaceId: "ws-won" }),
      ]);
    // Fast path misses; the in-lock re-check finds the racing winner's row.
    findFirstMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ workspaceId: "ws-won" });
    countMock.mockResolvedValue(1);

    const context = await getWorkspaceContext();

    expect(workspaceCreateMock).not.toHaveBeenCalled();
    expect(workspaceMemberCreateMock).not.toHaveBeenCalled();
    expect(context?.workspace.id).toBe("ws-won");
  });

  it("honors the active-workspace cookie when it matches a membership", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser());
    findManyMock.mockResolvedValue([
      makeMembership({
        workspaceId: "ws-personal",
        role: "owner",
        createdAt: new Date("2020-01-01T00:00:00Z"),
      }),
      makeMembership({
        workspaceId: "ws-invited",
        role: "member",
        createdAt: new Date("2020-06-01T00:00:00Z"),
      }),
    ]);
    cookiesGetMock.mockReturnValue({ value: "ws-invited" });
    countMock.mockResolvedValue(2);

    const context = await getWorkspaceContext();

    expect(context?.workspace.id).toBe("ws-invited");
    expect(context?.role).toBe("member");
    expect(cookiesGetMock).toHaveBeenCalledWith(ACTIVE_WORKSPACE_COOKIE);
  });

  it("falls back to the personal workspace when the cookie names a foreign/invalid workspace", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser());
    findManyMock.mockResolvedValue([
      makeMembership({
        workspaceId: "ws-personal",
        role: "owner",
        createdAt: new Date("2020-01-01T00:00:00Z"),
      }),
    ]);
    cookiesGetMock.mockReturnValue({ value: "ws-not-a-member-of" });
    countMock.mockResolvedValue(1);

    const context = await getWorkspaceContext();

    expect(context?.workspace.id).toBe("ws-personal");
  });

  it("throws WorkspaceForbiddenError when requireRole: owner isn't met, without leaking memberCount", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser());
    findManyMock.mockResolvedValue([makeMembership({ role: "member" })]);

    await expect(getWorkspaceContext({ requireRole: "owner" })).rejects.toBeInstanceOf(
      WorkspaceForbiddenError,
    );
    expect(countMock).not.toHaveBeenCalled();
  });

  it("does not throw when requireRole: owner IS met", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser());
    findManyMock.mockResolvedValue([makeMembership({ role: "owner" })]);
    countMock.mockResolvedValue(1);

    await expect(getWorkspaceContext({ requireRole: "owner" })).resolves.not.toBeNull();
  });
});

// Review fix round 1 (Minor 1): the shared owner gate the 4 owner-gated
// routes import — hoisted here from 4 byte-identical per-route copies. The
// route contract it must preserve: 401 { error: "Unauthorized" } when
// unauthenticated, 403 { error: "Only the workspace owner can do that." }
// for a non-owner, the context object for an owner, and anything unexpected
// rethrown (routes let it become a 500 via their own error handling).
describe("requireOwnerContext", () => {
  it("returns a 401 JSON response when unauthenticated", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const result = await requireOwnerContext();

    expect(result).toBeInstanceOf(NextResponse);
    const response = result as NextResponse;
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns a 403 JSON response with the shared message for a member", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser());
    findManyMock.mockResolvedValue([makeMembership({ role: "member" })]);

    const result = await requireOwnerContext();

    expect(result).toBeInstanceOf(NextResponse);
    const response = result as NextResponse;
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only the workspace owner can do that.",
    });
  });

  it("returns the workspace context (not a response) for an owner", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser());
    findManyMock.mockResolvedValue([makeMembership({ role: "owner" })]);
    countMock.mockResolvedValue(1);

    const result = await requireOwnerContext();

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toMatchObject({ role: "owner", workspace: { id: "workspace-1" } });
  });

  it("rethrows unexpected errors instead of mapping them to 403", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser());
    findManyMock.mockRejectedValue(new Error("db down"));

    await expect(requireOwnerContext()).rejects.toThrow("db down");
  });
});
