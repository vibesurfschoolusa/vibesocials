import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  resultFindMany: vi.fn(),
  connectionFindMany: vi.fn(),
  postJobGroupBy: vi.fn(),
  memberFindMany: vi.fn(),
  userFindMany: vi.fn(),
}));
const { sendEmailMock, loggerMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(),
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJobResult: { findMany: db.resultFindMany },
    socialConnection: { findMany: db.connectionFindMany },
    postJob: { groupBy: db.postJobGroupBy },
    workspaceMember: { findMany: db.memberFindMany },
    user: { findMany: db.userFindMany },
  },
}));
vi.mock("@/server/notifications/email", () => ({ sendEmail: sendEmailMock }));
vi.mock("@/lib/logger", () => ({ logger: loggerMock }));

import {
  collectProblemDigests,
  DIGEST_MAX_EMAILS_PER_RUN,
  sendProblemDigests,
  type ProblemDigest,
} from "./problemDigest";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const DAY_AGO = new Date("2026-11-09T12:00:00.000Z");

/** An owner row as the membership query returns it. */
function owner(userId: string, workspaceId: string, name: string) {
  return { userId, workspaceId, workspace: { name } };
}

beforeEach(() => {
  for (const mock of Object.values(db)) mock.mockReset();
  sendEmailMock.mockReset();
  for (const mock of Object.values(loggerMock)) mock.mockReset();
  db.resultFindMany.mockResolvedValue([]);
  db.connectionFindMany.mockResolvedValue([]);
  db.postJobGroupBy.mockResolvedValue([]);
  db.memberFindMany.mockResolvedValue([]);
  db.userFindMany.mockResolvedValue([]);
  sendEmailMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("collectProblemDigests", () => {
  it("returns no digests, and reads no owners, when nothing has a problem", async () => {
    await expect(collectProblemDigests(NOW)).resolves.toEqual([]);
    expect(db.memberFindMany).not.toHaveBeenCalled();
  });

  it("only counts results that are failed now and finished in the 24 hours before the run", async () => {
    await collectProblemDigests(NOW);

    const where = db.resultFindMany.mock.calls[0][0].where;
    // A result that was retried and succeeded is `success` now, so `failed` excludes it.
    expect(where.status).toBe("failed");
    expect(where.updatedAt).toEqual({ gte: DAY_AGO, lte: NOW });
    expect(where.workspaceId).toEqual({ not: null });
  });

  it("matches a post waiting for approval the way deriveApprovalState does, for drafts", async () => {
    await collectProblemDigests(NOW);

    expect(db.postJobGroupBy.mock.calls[0][0].where).toEqual({
      status: "draft",
      submittedForApprovalAt: { not: null },
      approvedAt: null,
    });
  });

  it("reads only connections that need reconnecting", async () => {
    await collectProblemDigests(NOW);

    expect(db.connectionFindMany.mock.calls[0][0].where).toEqual({ needsReconnect: true });
  });

  it("gives an owner of two problem workspaces one digest with both", async () => {
    db.resultFindMany.mockResolvedValue([
      { workspaceId: "ws-a", postJobId: "p1", platform: "x" },
      { workspaceId: "ws-a", postJobId: "p1", platform: "instagram" },
      { workspaceId: "ws-a", postJobId: "p2", platform: "x" },
    ]);
    db.connectionFindMany.mockResolvedValue([{ workspaceId: "ws-b", platform: "linkedin" }]);
    db.postJobGroupBy.mockResolvedValue([{ workspaceId: "ws-b", _count: { _all: 2 } }]);
    db.memberFindMany.mockResolvedValue([
      owner("user-1", "ws-b", "Beach Club"),
      owner("user-1", "ws-a", "Alpha Surf"),
    ]);

    const digests = await collectProblemDigests(NOW);

    expect(digests).toEqual([
      {
        userId: "user-1",
        workspaces: [
          {
            workspaceId: "ws-a",
            name: "Alpha Surf",
            failedPosts: 2,
            failedPlatforms: ["instagram", "x"],
            needsReconnect: [],
            waitingForApproval: 0,
          },
          {
            workspaceId: "ws-b",
            name: "Beach Club",
            failedPosts: 0,
            failedPlatforms: [],
            needsReconnect: ["linkedin"],
            waitingForApproval: 2,
          },
        ],
      },
    ]);
  });

  it("asks only for owners of the problem workspaces who kept the preference on", async () => {
    db.connectionFindMany.mockResolvedValue([{ workspaceId: "ws-a", platform: "x" }]);

    await collectProblemDigests(NOW);

    // A member who is not an owner, and an owner with the preference off, are
    // filtered out here, so neither gets a digest.
    expect(db.memberFindMany.mock.calls[0][0].where).toEqual({
      workspaceId: { in: ["ws-a"] },
      role: "owner",
      user: { notifyDailyDigest: true },
    });
  });

  it("gives nobody a digest when no owner of a problem workspace wants one", async () => {
    db.connectionFindMany.mockResolvedValue([{ workspaceId: "ws-a", platform: "x" }]);
    db.memberFindMany.mockResolvedValue([]);

    await expect(collectProblemDigests(NOW)).resolves.toEqual([]);
  });

  it("returns digests in a stable order, so a re-run picks the same owners", async () => {
    db.connectionFindMany.mockResolvedValue([{ workspaceId: "ws-a", platform: "x" }]);
    db.memberFindMany.mockResolvedValue([owner("user-b", "ws-a", "A"), owner("user-a", "ws-a", "A")]);

    const digests = await collectProblemDigests(NOW);

    expect(digests.map((digest) => digest.userId)).toEqual(["user-a", "user-b"]);
  });
});

function digest(userId: string): ProblemDigest {
  return {
    userId,
    workspaces: [
      {
        workspaceId: "ws-1",
        name: "Surf Co",
        failedPosts: 0,
        failedPlatforms: [],
        needsReconnect: ["x"],
        waitingForApproval: 0,
      },
    ],
  };
}

describe("sendProblemDigests", () => {
  it("sends each owner one email with the key digest/<userId>/<UTC day>", async () => {
    db.userFindMany.mockResolvedValue([{ id: "user-1", email: "one@example.com" }]);

    const result = await sendProblemDigests([digest("user-1")], NOW);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [params, options] = sendEmailMock.mock.calls[0];
    expect(params.to).toBe("one@example.com");
    expect(params.subject).toBe("Vibe Socials: 1 workspace needs attention");
    expect(options).toEqual({ idempotencyKey: "digest/user-1/2026-11-10" });
    expect(result).toEqual({ sent: 1, failed: 0, left: 0 });
  });

  it("keeps sending after one owner's email fails", async () => {
    db.userFindMany.mockResolvedValue([
      { id: "user-1", email: "one@example.com" },
      { id: "user-2", email: "two@example.com" },
    ]);
    sendEmailMock.mockRejectedValueOnce(new Error("boom"));

    const result = await sendProblemDigests([digest("user-1"), digest("user-2")], NOW);

    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(sendEmailMock.mock.calls[1][0].to).toBe("two@example.com");
    expect(result).toEqual({ sent: 1, failed: 1, left: 0 });
  });

  it(`stops after ${DIGEST_MAX_EMAILS_PER_RUN} emails and logs how many were left`, async () => {
    expect(DIGEST_MAX_EMAILS_PER_RUN).toBe(200);
    const digests = Array.from({ length: 205 }, (_, index) => digest(`user-${index}`));
    db.userFindMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => ({ id, email: `${id}@example.com` })),
    );

    const result = await sendProblemDigests(digests, NOW);

    expect(sendEmailMock).toHaveBeenCalledTimes(200);
    expect(db.userFindMany.mock.calls[0][0].where.id.in).toHaveLength(200);
    expect(result).toEqual({ sent: 200, failed: 0, left: 5 });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ left: 5 }),
    );
  });

  it("skips an owner whose account is gone", async () => {
    db.userFindMany.mockResolvedValue([]);

    const result = await sendProblemDigests([digest("user-1")], NOW);

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 0, left: 0 });
  });
});
