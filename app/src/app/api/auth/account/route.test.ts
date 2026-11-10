import bcrypt from "bcryptjs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The route runs the real deletion plan, loader and file cleanup
// (server/account/*) against this mocked prisma, so the tests check what is
// changed and in what order, not just which helper was called.
const m = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    callLog: [] as string[],
    getCurrentUser: fn(),
    checkRateLimit: fn(),
    deliverAccountEmail: fn(),
    del: fn(),
    memberFindMany: fn(),
    memberCount: fn(),
    executeRaw: fn(),
    workspaceFindMany: fn(),
    connectionFindMany: fn(),
    mediaFindMany: fn(),
    postJobFindMany: fn(),
    metricFindMany: fn(),
    postJobFindFirst: fn(),
    connectionUpdateMany: fn(),
    mediaUpdateMany: fn(),
    postJobUpdateMany: fn(),
    metricUpdateMany: fn(),
    workspaceDeleteMany: fn(),
    pendingDeleteMany: fn(),
    handshakeDeleteMany: fn(),
    userDelete: fn(),
  };
});

vi.mock("@/lib/auth", () => ({ getCurrentUser: m.getCurrentUser }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: m.checkRateLimit }));
vi.mock("@vercel/blob", () => ({ del: m.del }));
// deliverAccountEmail never throws (it logs and returns false), so the mock
// resolves false the way a failed or unconfigured send really behaves.
vi.mock("@/lib/accountEmails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/accountEmails")>()),
  deliverAccountEmail: m.deliverAccountEmail,
}));
vi.mock("@/lib/db", () => {
  const prisma: Record<string, unknown> = {
    $executeRaw: m.executeRaw,
    workspaceMember: { findMany: m.memberFindMany, count: m.memberCount },
    workspace: { findMany: m.workspaceFindMany, deleteMany: m.workspaceDeleteMany },
    socialConnection: { findMany: m.connectionFindMany, updateMany: m.connectionUpdateMany },
    mediaItem: { findMany: m.mediaFindMany, updateMany: m.mediaUpdateMany },
    postJob: { findMany: m.postJobFindMany, findFirst: m.postJobFindFirst, updateMany: m.postJobUpdateMany },
    postMetric: { findMany: m.metricFindMany, updateMany: m.metricUpdateMany },
    pendingConnection: { deleteMany: m.pendingDeleteMany },
    oAuthHandshake: { deleteMany: m.handshakeDeleteMany },
    user: { delete: m.userDelete },
    $transaction: (cb: (tx: unknown) => unknown) => {
      m.callLog.push("transaction");
      return cb(prisma);
    },
  };
  return { prisma };
});

import { DELETE } from "./route";

const USER_ID = "user-1";
const FILE = (name: string) => `https://abc123.public.blob.vercel-storage.com/${name}.png`;
let passwordHash: string;

type Member = { userId: string; role: "owner" | "member"; createdAt: Date };
type Membership = { role: "owner" | "member"; workspace: { id: string; name: string; members: Member[] } };
let memberships: Membership[];
let media: { id: string; workspaceId: string; storageLocation: string }[];
/** What the in-transaction re-check reads; null = same as the memberships above. */
let liveMembers: Record<string, Member[]> | null;

const day = (n: number) => new Date(`2026-01-0${n}T00:00:00Z`);

function request(body: unknown): Request {
  return new Request("http://localhost/api/auth/account", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function logged(name: string, result: unknown = { count: 1 }) {
  return async (args: unknown) => {
    m.callLog.push(`${name} ${JSON.stringify(args)}`);
    return result;
  };
}

beforeAll(async () => {
  passwordHash = await bcrypt.hash("right-password", 4);
});

beforeEach(() => {
  m.callLog.length = 0;
  for (const value of Object.values(m)) {
    if (typeof value === "function" && "mockReset" in value) value.mockReset();
  }
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("BLOB_STORE_ID", "");
  memberships = [{ role: "owner", workspace: { id: "ws-personal", name: "Personal", members: [] } }];
  media = [];
  liveMembers = null;

  m.getCurrentUser.mockResolvedValue({ id: USER_ID, email: "me@example.com", passwordHash });
  m.checkRateLimit.mockResolvedValue({ allowed: true });
  m.deliverAccountEmail.mockResolvedValue(false);
  // The loader asks for the user's own memberships; the re-check inside the
  // transaction asks for one workspace's other members.
  m.memberFindMany.mockImplementation(async ({ where }: { where: { userId?: unknown; workspaceId?: string } }) => {
    if (where.userId === USER_ID) return memberships;
    const workspaceId = where.workspaceId as string;
    if (liveMembers) return liveMembers[workspaceId] ?? [];
    return memberships.find((entry) => entry.workspace.id === workspaceId)?.workspace.members ?? [];
  });
  m.memberCount.mockResolvedValue(0);
  m.executeRaw.mockImplementation(async (_strings: unknown, key: string) => {
    m.callLog.push(`lock ${key}`);
    return 0;
  });
  m.workspaceFindMany.mockResolvedValue([]);
  m.connectionFindMany.mockResolvedValue([]);
  m.postJobFindMany.mockResolvedValue([]);
  m.metricFindMany.mockResolvedValue([]);
  m.postJobFindFirst.mockResolvedValue(null);
  m.mediaFindMany.mockImplementation(
    async ({ where }: { where: { userId?: string; workspaceId?: { in?: string[]; notIn?: string[] }; id?: { gt: string }; storageLocation?: { in: string[] } } }) => {
      if (where.userId) return []; // the "rows this user owns" lookup
      return media.filter((row) => {
        if (where.workspaceId?.in && !where.workspaceId.in.includes(row.workspaceId)) return false;
        if (where.workspaceId?.notIn && where.workspaceId.notIn.includes(row.workspaceId)) return false;
        if (where.id && !(row.id > where.id.gt)) return false;
        if (where.storageLocation && !where.storageLocation.in.includes(row.storageLocation)) return false;
        return true;
      });
    },
  );
  m.del.mockImplementation(logged("del", undefined));
  m.connectionUpdateMany.mockImplementation(logged("reassign socialConnection"));
  m.mediaUpdateMany.mockImplementation(logged("reassign mediaItem"));
  m.postJobUpdateMany.mockImplementation(logged("reassign postJob"));
  m.metricUpdateMany.mockImplementation(logged("reassign postMetric"));
  m.workspaceDeleteMany.mockImplementation(logged("delete workspaces"));
  m.pendingDeleteMany.mockImplementation(logged("delete pendingConnection"));
  m.handshakeDeleteMany.mockImplementation(logged("delete oAuthHandshake"));
  m.userDelete.mockImplementation(logged("delete user", {}));
});

function nothingChanged() {
  for (const mock of [
    m.del,
    m.connectionUpdateMany,
    m.mediaUpdateMany,
    m.postJobUpdateMany,
    m.metricUpdateMany,
    m.workspaceDeleteMany,
    m.userDelete,
  ]) {
    expect(mock).not.toHaveBeenCalled();
  }
}

describe("DELETE /api/auth/account", () => {
  it("returns 401 when signed out", async () => {
    m.getCurrentUser.mockResolvedValue(null);

    const response = await DELETE(request({ password: "right-password" }));

    expect(response.status).toBe(401);
    nothingChanged();
  });

  it("rate limits 5 attempts per hour per user", async () => {
    m.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 600 });

    const response = await DELETE(request({ password: "right-password" }));

    expect(response.status).toBe(429);
    expect(m.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, limit: 5, windowMs: 60 * 60 * 1000 }),
    );
    nothingChanged();
  });

  it("returns 400 on invalid JSON", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/auth/account", { method: "DELETE", body: "[" }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects a wrong password and changes nothing", async () => {
    const response = await DELETE(request({ password: "wrong-password" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Your password is not correct." });
    expect(m.memberFindMany).not.toHaveBeenCalled();
    nothingChanged();
  });

  it("does not accept the email in place of the password for a password user", async () => {
    const response = await DELETE(request({ confirmEmail: "me@example.com" }));

    expect(response.status).toBe(400);
    nothingChanged();
  });

  it("rejects a wrong email for a Google-only user", async () => {
    m.getCurrentUser.mockResolvedValue({ id: USER_ID, email: "me@example.com", passwordHash: null });

    const response = await DELETE(request({ confirmEmail: "someone@example.com" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "That email does not match the one on this account.",
    });
    nothingChanged();
  });

  it("accepts a Google-only user's email in any case and with spaces", async () => {
    m.getCurrentUser.mockResolvedValue({ id: USER_ID, email: "me@example.com", passwordHash: null });

    const response = await DELETE(request({ confirmEmail: "  ME@Example.com " }));

    expect(response.status).toBe(200);
    expect(m.userDelete).toHaveBeenCalledWith({ where: { id: USER_ID } });
  });

  it("is blocked with the workspace names and changes nothing", async () => {
    memberships = [
      { role: "owner", workspace: { id: "ws-personal", name: "Personal", members: [] } },
      {
        role: "owner",
        workspace: { id: "ws-a", name: "Surf Team", members: [{ userId: "u-2", role: "member", createdAt: day(2) }] },
      },
      {
        role: "owner",
        workspace: { id: "ws-b", name: "Shop", members: [{ userId: "u-3", role: "member", createdAt: day(2) }] },
      },
    ];

    const response = await DELETE(request({ password: "right-password" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "You are the only owner of Surf Team and Shop. Make another member an owner, or delete the workspace, then try again.",
    });
    nothingChanged();
  });

  it("refuses with 409 while a post publishes in a workspace that would be deleted", async () => {
    m.postJobFindFirst.mockResolvedValue({ id: "job-1" });

    const response = await DELETE(request({ password: "right-password" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "A post is publishing right now. Try again in a few minutes.",
    });
    expect(m.postJobFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: { in: ["ws-personal"] } }) }),
    );
    nothingChanged();
  });

  it("returns 500 and changes no row when a file deletion fails", async () => {
    media = [{ id: "m1", workspaceId: "ws-personal", storageLocation: FILE("a") }];
    m.del.mockRejectedValue(new Error("blob down"));

    const response = await DELETE(request({ password: "right-password" }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Could not delete all of your workspaces' files. Try again.",
    });
    expect(m.callLog).not.toContain("transaction");
    expect(m.userDelete).not.toHaveBeenCalled();
    expect(m.workspaceDeleteMany).not.toHaveBeenCalled();
  });

  it("deletes files, then reassigns, deletes the planned workspaces and deletes the user last", async () => {
    memberships = [
      { role: "owner", workspace: { id: "ws-personal", name: "Personal", members: [] } },
      {
        role: "owner",
        workspace: {
          id: "ws-co",
          name: "Co",
          members: [
            { userId: "u-late", role: "owner", createdAt: day(5) },
            { userId: "u-early", role: "owner", createdAt: day(2) },
          ],
        },
      },
      {
        role: "member",
        workspace: { id: "ws-joined", name: "Joined", members: [{ userId: "u-boss", role: "owner", createdAt: day(1) }] },
      },
    ];
    media = [
      { id: "m1", workspaceId: "ws-personal", storageLocation: FILE("mine") },
      { id: "m2", workspaceId: "ws-co", storageLocation: FILE("co-file") },
    ];

    const response = await DELETE(request({ password: "right-password" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });

    const reassign = (model: string, workspaceId: string, toUserId: string) =>
      `reassign ${model} ${JSON.stringify({ where: { workspaceId, userId: USER_ID }, data: { userId: toUserId } })}`;
    expect(m.callLog).toEqual([
      expect.stringMatching(/^del /),
      "transaction",
      "lock ws-owners:ws-co",
      "lock ws-owners:ws-joined",
      reassign("socialConnection", "ws-co", "u-early"),
      reassign("mediaItem", "ws-co", "u-early"),
      reassign("postJob", "ws-co", "u-early"),
      reassign("postMetric", "ws-co", "u-early"),
      reassign("socialConnection", "ws-joined", "u-boss"),
      reassign("mediaItem", "ws-joined", "u-boss"),
      reassign("postJob", "ws-joined", "u-boss"),
      reassign("postMetric", "ws-joined", "u-boss"),
      `delete workspaces ${JSON.stringify({ where: { id: { in: ["ws-personal"] } } })}`,
      `delete pendingConnection ${JSON.stringify({ where: { userId: USER_ID } })}`,
      `delete oAuthHandshake ${JSON.stringify({ where: { userId: USER_ID } })}`,
      `delete user ${JSON.stringify({ where: { id: USER_ID } })}`,
    ]);
    expect(m.del).toHaveBeenCalledWith([FILE("mine")], expect.anything());
    expect(m.deliverAccountEmail).toHaveBeenCalledWith(
      "me@example.com",
      expect.objectContaining({ subject: "Your Vibe Socials account was deleted" }),
    );
  });

  it("reassigns rows in a workspace the user has left instead of letting them cascade", async () => {
    m.postJobFindMany.mockImplementation(async ({ where }: { where: { userId?: string } }) =>
      where.userId ? [{ workspaceId: "ws-left" }, { workspaceId: "ws-personal" }] : [],
    );
    m.workspaceFindMany.mockResolvedValue([
      { id: "ws-left", name: "Left", members: [{ userId: "u-boss", role: "owner", createdAt: day(1) }] },
    ]);
    liveMembers = { "ws-left": [{ userId: "u-boss", role: "owner", createdAt: day(1) }] };

    const response = await DELETE(request({ password: "right-password" }));

    expect(response.status).toBe(200);
    expect(m.workspaceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["ws-left"] } } }),
    );
    expect(m.postJobUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-left", userId: USER_ID },
      data: { userId: "u-boss" },
    });
    expect(m.workspaceDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["ws-personal"] } } });
  });

  it("never deletes a workspace the user does not solely own, whatever the body says", async () => {
    memberships = [
      { role: "owner", workspace: { id: "ws-personal", name: "Personal", members: [] } },
      {
        role: "member",
        workspace: { id: "ws-victim", name: "Victim", members: [{ userId: "u-boss", role: "owner", createdAt: day(1) }] },
      },
    ];

    const response = await DELETE(
      request({ password: "right-password", workspaceId: "ws-victim", deleteWorkspaceIds: ["ws-victim"] }),
    );

    expect(response.status).toBe(200);
    expect(m.workspaceDeleteMany).toHaveBeenCalledTimes(1);
    expect(m.workspaceDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["ws-personal"] } } });
    expect(m.memberFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: USER_ID } }));
  });

  it("deletes only the user when they own no workspace alone", async () => {
    memberships = [
      {
        role: "member",
        workspace: { id: "ws-joined", name: "Joined", members: [{ userId: "u-boss", role: "owner", createdAt: day(1) }] },
      },
    ];

    const response = await DELETE(request({ password: "right-password" }));

    expect(response.status).toBe(200);
    expect(m.del).not.toHaveBeenCalled();
    expect(m.workspaceDeleteMany).toHaveBeenCalledWith({ where: { id: { in: [] } } });
    expect(m.userDelete).toHaveBeenCalledWith({ where: { id: USER_ID } });
  });

  describe("re-checks the plan inside the transaction", () => {
    const CHANGED =
      "Your workspaces changed while this was running. Nothing was deleted from your account. Try again.";
    const coOwned: Membership = {
      role: "owner",
      workspace: {
        id: "ws-co",
        name: "Co",
        members: [{ userId: "u-co", role: "owner", createdAt: day(2) }],
      },
    };

    function nothingWritten() {
      for (const mock of [
        m.connectionUpdateMany,
        m.mediaUpdateMany,
        m.postJobUpdateMany,
        m.metricUpdateMany,
        m.workspaceDeleteMany,
        m.pendingDeleteMany,
        m.handshakeDeleteMany,
        m.userDelete,
      ]) {
        expect(mock).not.toHaveBeenCalled();
      }
    }

    it("refuses when the co-owner who was to receive the rows left during the file cleanup", async () => {
      memberships = [memberships[0], coOwned];
      liveMembers = { "ws-co": [{ userId: "u-member", role: "member", createdAt: day(3) }] };

      const response = await DELETE(request({ password: "right-password" }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: CHANGED });
      expect(m.callLog).toContain("lock ws-owners:ws-co");
      nothingWritten();
    });

    it("refuses when the target is no longer an owner", async () => {
      memberships = [memberships[0], coOwned];
      liveMembers = {
        "ws-co": [
          { userId: "u-co", role: "member", createdAt: day(2) },
          { userId: "u-new", role: "owner", createdAt: day(4) },
        ],
      };

      const response = await DELETE(request({ password: "right-password" }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: CHANGED });
      nothingWritten();
    });

    it("refuses when a workspace to be deleted gained a member", async () => {
      m.memberCount.mockResolvedValue(1);

      const response = await DELETE(request({ password: "right-password" }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: CHANGED });
      expect(m.memberCount).toHaveBeenCalledWith({
        where: { workspaceId: { in: ["ws-personal"] }, userId: { not: USER_ID } },
      });
      nothingWritten();
    });

    it("refuses when a post started publishing in a workspace to be deleted", async () => {
      m.postJobFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "job-1" });

      const response = await DELETE(request({ password: "right-password" }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "A post is publishing right now. Try again in a few minutes.",
      });
      expect(m.postJobFindFirst).toHaveBeenCalledTimes(2);
      nothingWritten();
    });

    it("answers 500 with a finish-it sentence when the database step fails after the files went", async () => {
      media = [{ id: "m1", workspaceId: "ws-personal", storageLocation: FILE("a") }];
      m.userDelete.mockRejectedValue(new Error("connection lost"));

      const response = await DELETE(request({ password: "right-password" }));

      expect(m.del).toHaveBeenCalled();
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "The files were removed, but the rest could not be finished. Try again to complete it.",
      });
      expect(m.deliverAccountEmail).not.toHaveBeenCalled();
    });
  });
});
