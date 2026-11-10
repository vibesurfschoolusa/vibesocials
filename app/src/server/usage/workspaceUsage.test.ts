import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  workspaceFindUnique: vi.fn(),
  postJobCount: vi.fn(),
  resultCount: vi.fn(),
  queryRaw: vi.fn(),
  memberFindMany: vi.fn(),
}));
const { consumeFixedWindowMock, sendEmailMock } = vi.hoisted(() => ({
  consumeFixedWindowMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { findUnique: db.workspaceFindUnique },
    postJob: { count: db.postJobCount },
    postJobResult: { count: db.resultCount },
    workspaceMember: { findMany: db.memberFindMany },
    $queryRaw: db.queryRaw,
  },
}));
vi.mock("@/lib/rateLimit", () => ({ consumeFixedWindow: consumeFixedWindowMock }));
vi.mock("@/server/notifications/email", () => ({ sendEmail: sendEmailMock }));

import {
  checkDailyPostLimit,
  getWorkspaceUsageOrNull,
  checkStorageLimit,
  checkXMonthlyLimit,
  checkYoutubeDailyLimit,
  getWorkspaceLimits,
  getWorkspaceUsage,
} from "./workspaceUsage";

const MB = 1024 * 1024;
const NOW = new Date("2026-11-10T15:00:00.000Z");

function workspaceRow(overrides: Record<string, number | null> = {}) {
  return {
    name: "Surf Co",
    limitPostsPerDay: null,
    limitXPostsPerMonth: null,
    limitYoutubeUploadsPerDay: null,
    limitStorageMb: null,
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of Object.values(db)) mock.mockReset();
  consumeFixedWindowMock.mockReset();
  sendEmailMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  db.workspaceFindUnique.mockResolvedValue(workspaceRow());
  db.postJobCount.mockResolvedValue(0);
  db.resultCount.mockResolvedValue(0);
  db.queryRaw.mockResolvedValue([{ total: BigInt(0) }]);
  db.memberFindMany.mockResolvedValue([
    { user: { id: "owner-1", email: "one@example.com" } },
    { user: { id: "owner-2", email: "two@example.com" } },
  ]);
  consumeFixedWindowMock.mockResolvedValue({ allowed: true });
  sendEmailMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("getWorkspaceLimits", () => {
  it("reads the workspace's columns and resolves them over the environment", async () => {
    vi.stubEnv("LIMIT_POSTS_PER_DAY", "40");
    vi.stubEnv("LIMIT_X_POSTS_PER_MONTH", "");
    vi.stubEnv("LIMIT_YOUTUBE_UPLOADS_PER_DAY", "");
    vi.stubEnv("LIMIT_STORAGE_MB", "");
    db.workspaceFindUnique.mockResolvedValue(workspaceRow({ limitXPostsPerMonth: 5 }));

    await expect(getWorkspaceLimits("ws-1")).resolves.toEqual({
      postsPerDay: 40,
      xPostsPerMonth: 5,
      youtubeUploadsPerDay: 10,
      storageBytes: 5120 * MB,
    });
    expect(db.workspaceFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ws-1" } }),
    );
  });
});

describe("checkDailyPostLimit", () => {
  it("allows a post while the day is under the limit, and emails no one", async () => {
    db.postJobCount.mockResolvedValue(19);

    await expect(
      checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" }),
    ).resolves.toBeNull();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("counts the workspace's non-draft, non-cancelled posts by scheduledFor, else createdAt, in the UTC day", async () => {
    await checkDailyPostLimit({ workspaceId: "ws-1", day: new Date("2026-11-12T22:00:00Z"), mode: "schedule" });

    const start = new Date("2026-11-12T00:00:00.000Z");
    const end = new Date("2026-11-13T00:00:00.000Z");
    expect(db.postJobCount).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        status: { notIn: ["draft", "cancelled"] },
        OR: [
          { scheduledFor: { gte: start, lt: end } },
          { scheduledFor: null, createdAt: { gte: start, lt: end } },
        ],
      },
    });
  });

  it("leaves out the post being moved", async () => {
    await checkDailyPostLimit({
      workspaceId: "ws-1",
      day: NOW,
      mode: "schedule",
      excludePostJobId: "job-9",
    });

    expect(db.postJobCount.mock.calls[0][0].where.id).toEqual({ not: "job-9" });
  });

  it("refuses at the limit with the publish-now sentence and code", async () => {
    db.postJobCount.mockResolvedValue(20);

    await expect(
      checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" }),
    ).resolves.toEqual({
      code: "WORKSPACE_DAILY_POST_LIMIT",
      error:
        "This workspace has reached its limit of 20 posts for today. Schedule this post for another day, or try again tomorrow.",
    });
  });

  it("refuses at the limit with the scheduling sentence", async () => {
    db.postJobCount.mockResolvedValue(25);

    const refusal = await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "schedule" });
    expect(refusal?.error).toBe(
      "That day already has 20 posts, which is this workspace's daily limit. Pick another day.",
    );
  });

  it("refuses everything when the limit is zero", async () => {
    db.workspaceFindUnique.mockResolvedValue(workspaceRow({ limitPostsPerDay: 0 }));
    db.postJobCount.mockResolvedValue(0);

    const refusal = await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });
    expect(refusal?.code).toBe("WORKSPACE_DAILY_POST_LIMIT");
  });

  it("fails open when the count cannot be read", async () => {
    db.postJobCount.mockRejectedValue(new Error("db down"));

    await expect(
      checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" }),
    ).resolves.toBeNull();
  });
});

describe("the limit-reached email", () => {
  it("emails every owner once per window, through a limit-1 counter that resets at the window's end", async () => {
    db.postJobCount.mockResolvedValue(20);

    await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });

    expect(consumeFixedWindowMock).toHaveBeenCalledWith({
      key: "usage-limit-email:ws-1:postsPerDay:2026-11-10",
      limit: 1,
      resetAt: new Date("2026-11-11T00:00:00.000Z"),
    });
    expect(db.memberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1", role: "owner" } }),
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "one@example.com", subject: "Surf Co reached a Vibe Socials limit" }),
      { idempotencyKey: "usage-limit/ws-1/postsPerDay/2026-11-10/owner-1" },
    );
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "two@example.com" }),
      { idempotencyKey: "usage-limit/ws-1/postsPerDay/2026-11-10/owner-2" },
    );
  });

  it("is not sent again once the window's counter is used", async () => {
    db.postJobCount.mockResolvedValue(20);
    consumeFixedWindowMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 10 });

    const refusal = await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });

    expect(refusal).not.toBeNull();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("a send failure does not fail the caller", async () => {
    db.postJobCount.mockResolvedValue(20);
    sendEmailMock.mockRejectedValue(new Error("resend down"));

    const refusal = await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });
    expect(refusal?.code).toBe("WORKSPACE_DAILY_POST_LIMIT");
  });

  it("names a future full day in the email and says other days are not affected", async () => {
    db.postJobCount.mockResolvedValue(20);

    await checkDailyPostLimit({ workspaceId: "ws-1", day: new Date("2026-11-12T18:00:00Z"), mode: "schedule" });

    expect(consumeFixedWindowMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: "usage-limit-email:ws-1:postsPerDay:2026-11-12" }),
    );
    const html = (sendEmailMock.mock.calls[0][0] as { html: string }).html;
    expect(html).toContain(
      "<strong>Surf Co</strong> reached its limit of 20 posts for 12 November. Posts on other days are not affected.",
    );
    expect(html).not.toContain("possible again");
  });

  it("gives up waiting after 5 seconds: the caller gets its refusal, and the delay is logged", async () => {
    vi.useFakeTimers();
    try {
      db.postJobCount.mockResolvedValue(20);
      sendEmailMock.mockReturnValue(new Promise(() => {}));

      let settled = false;
      const pending = checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" }).then((r) => {
        settled = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(4_900);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await expect(pending).resolves.toMatchObject({ code: "WORKSPACE_DAILY_POST_LIMIT" });
      expect(console.error).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an owner lookup that hangs is cut off after 5 seconds too", async () => {
    vi.useFakeTimers();
    try {
      db.resultCount.mockResolvedValue(30);
      db.memberFindMany.mockReturnValue(new Promise(() => {}));

      const refusal = await checkXMonthlyLimit("ws-1", NOW);
      const notified = refusal!.notifyOwners();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(notified).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failure to find the owners does not fail the caller", async () => {
    db.postJobCount.mockResolvedValue(20);
    db.memberFindMany.mockRejectedValue(new Error("db down"));

    const refusal = await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });
    expect(refusal?.code).toBe("WORKSPACE_DAILY_POST_LIMIT");
  });

  it("X: the check sends nothing itself; notifyOwners does, with the UTC month as the window", async () => {
    db.resultCount.mockResolvedValue(30);

    const refusal = await checkXMonthlyLimit("ws-1", NOW);
    expect(consumeFixedWindowMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();

    await refusal!.notifyOwners();
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(consumeFixedWindowMock).toHaveBeenCalledWith({
      key: "usage-limit-email:ws-1:xPostsPerMonth:2026-11",
      limit: 1,
      resetAt: new Date("2026-12-01T00:00:00.000Z"),
    });
  });

  it("YouTube: the check sends nothing itself; notifyOwners does, with the Pacific day as the window", async () => {
    db.resultCount.mockResolvedValue(10);

    const refusal = await checkYoutubeDailyLimit("ws-1", NOW);
    expect(consumeFixedWindowMock).not.toHaveBeenCalled();

    await refusal!.notifyOwners();
    expect(consumeFixedWindowMock).toHaveBeenCalledWith({
      key: "usage-limit-email:ws-1:youtubeUploadsPerDay:2026-11-10",
      limit: 1,
      resetAt: new Date("2026-11-11T08:00:00.000Z"),
    });
  });

  it("uses the UTC day as the storage window", async () => {
    db.queryRaw.mockResolvedValue([{ total: BigInt(5120 * MB) }]);

    await checkStorageLimit("ws-1", NOW);

    expect(consumeFixedWindowMock).toHaveBeenCalledWith({
      key: "usage-limit-email:ws-1:storage:2026-11-10",
      limit: 1,
      resetAt: new Date("2026-11-11T00:00:00.000Z"),
    });
  });
});

describe("checkXMonthlyLimit", () => {
  it("counts the workspace's successful X results since the start of the UTC month", async () => {
    db.resultCount.mockResolvedValue(29);

    await expect(checkXMonthlyLimit("ws-1", NOW)).resolves.toBeNull();
    expect(db.resultCount).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        platform: "x",
        status: "success",
        updatedAt: { gte: new Date("2026-11-01T00:00:00.000Z") },
      },
    });
  });

  it("refuses at the limit with X_MONTHLY_LIMIT and the month sentence", async () => {
    db.resultCount.mockResolvedValue(30);

    await expect(checkXMonthlyLimit("ws-1", NOW)).resolves.toEqual({
      errorCode: "X_MONTHLY_LIMIT",
      errorMessage:
        "This workspace has used its 30 X posts for November. X posts start again on 1 December.",
      notifyOwners: expect.any(Function),
    });
  });

  it("fails open when the count cannot be read", async () => {
    db.resultCount.mockRejectedValue(new Error("db down"));
    await expect(checkXMonthlyLimit("ws-1", NOW)).resolves.toBeNull();
  });
});

describe("checkYoutubeDailyLimit", () => {
  it("counts the workspace's successful YouTube results within the Pacific day", async () => {
    db.resultCount.mockResolvedValue(9);

    await expect(checkYoutubeDailyLimit("ws-1", NOW)).resolves.toBeNull();
    expect(db.resultCount).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        platform: "youtube",
        status: "success",
        updatedAt: {
          gte: new Date("2026-11-10T08:00:00.000Z"),
          lt: new Date("2026-11-11T08:00:00.000Z"),
        },
      },
    });
  });

  it("refuses at the limit with YOUTUBE_WORKSPACE_DAILY_LIMIT and its sentence", async () => {
    db.resultCount.mockResolvedValue(10);

    await expect(checkYoutubeDailyLimit("ws-1", NOW)).resolves.toEqual({
      errorCode: "YOUTUBE_WORKSPACE_DAILY_LIMIT",
      errorMessage:
        "This workspace has reached its limit of 10 YouTube uploads for today. Retry this upload tomorrow.",
      notifyOwners: expect.any(Function),
    });
  });
});

describe("checkStorageLimit", () => {
  it("sums the sizes of the workspace's live media as a bigint, with the workspace id as a parameter", async () => {
    db.queryRaw.mockResolvedValue([{ total: BigInt(100) }]);

    await expect(checkStorageLimit("ws-1", NOW)).resolves.toBeNull();
    const [strings, ...values] = db.queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("$").replace(/\s+/g, " ").trim()).toBe(
      'SELECT COALESCE(SUM("sizeBytes"), 0)::bigint AS "total" FROM "MediaItem" WHERE "workspaceId" = $ AND "deletedAt" IS NULL',
    );
    expect(values).toEqual(["ws-1"]);
  });

  it("reads a total above 2^31 bytes correctly", async () => {
    const threeGb = 3 * 1024 * MB;
    expect(threeGb).toBeGreaterThan(2 ** 31);
    db.queryRaw.mockResolvedValue([{ total: BigInt(threeGb) }]);

    await expect(checkStorageLimit("ws-1", NOW)).resolves.toBeNull();
    expect((await getWorkspaceUsage("ws-1", NOW)).storage.used).toBe(threeGb);

    db.workspaceFindUnique.mockResolvedValue(workspaceRow({ limitStorageMb: 2048 }));
    await expect(checkStorageLimit("ws-1", NOW)).resolves.toMatchObject({ code: "WORKSPACE_STORAGE_FULL" });
  });

  it("refuses at or over the limit with the storage sentence", async () => {
    db.queryRaw.mockResolvedValue([{ total: BigInt(5120 * MB) }]);

    await expect(checkStorageLimit("ws-1", NOW)).resolves.toEqual({
      code: "WORKSPACE_STORAGE_FULL",
      error:
        "This workspace's media storage is full (5.0 GB). Delete media you no longer need on the Media page, then upload again.",
    });
  });

  it("allows just under the limit", async () => {
    db.queryRaw.mockResolvedValue([{ total: BigInt(5120 * MB - 1) }]);
    await expect(checkStorageLimit("ws-1", NOW)).resolves.toBeNull();
  });
});

describe("getWorkspaceUsage", () => {
  it("returns used and limit for all four, with when each starts again", async () => {
    db.postJobCount.mockResolvedValue(3);
    db.resultCount.mockImplementation(({ where }: { where: { platform: string } }) =>
      Promise.resolve(where.platform === "x" ? 4 : 1),
    );
    db.queryRaw.mockResolvedValue([{ total: BigInt(5 * MB) }]);

    await expect(getWorkspaceUsage("ws-1", NOW)).resolves.toEqual({
      postsToday: { used: 3, limit: 20, resetsAt: new Date("2026-11-11T00:00:00.000Z") },
      xPostsThisMonth: { used: 4, limit: 30, resetsAt: new Date("2026-12-01T00:00:00.000Z") },
      youtubeUploadsToday: { used: 1, limit: 10, resetsAt: new Date("2026-11-11T08:00:00.000Z") },
      storage: { used: 5 * MB, limit: 5120 * MB, resetsAt: null },
    });
  });
});

describe("getWorkspaceUsageOrNull", () => {
  it("returns the usage when it can be read", async () => {
    await expect(getWorkspaceUsageOrNull("ws-1", NOW)).resolves.toMatchObject({
      postsToday: { used: 0, limit: 20 },
    });
  });

  it("returns null (and logs) when any count cannot be read, so Settings still renders", async () => {
    db.queryRaw.mockRejectedValue(new Error("db down"));

    await expect(getWorkspaceUsageOrNull("ws-1", NOW)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});
