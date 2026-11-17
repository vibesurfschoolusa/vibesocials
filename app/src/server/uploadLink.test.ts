import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findUniqueMock, memberFindManyMock, consumeFixedWindowMock, sendEmailMock, releaseMock } = vi.hoisted(() => ({
  releaseMock: vi.fn(),
  findUniqueMock: vi.fn(),
  memberFindManyMock: vi.fn(),
  consumeFixedWindowMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceUploadLink: { findUnique: findUniqueMock },
    workspaceMember: { findMany: memberFindManyMock },
    rateLimitEntry: { deleteMany: releaseMock },
  },
}));
vi.mock("@/lib/rateLimit", () => ({ consumeFixedWindow: consumeFixedWindowMock }));
vi.mock("@/server/notifications/email", () => ({ sendEmail: sendEmailMock }));
vi.mock("@/server/notifications/onceADay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/notifications/onceADay")>();
  return { ...actual, sendOncePer: vi.fn(actual.sendOncePer) };
});

import { generateInviteToken, hashInviteToken } from "@/lib/inviteToken";

import { sendOncePer } from "@/server/notifications/onceADay";

import { findActiveUploadLink, notifyOwnersOfClientUpload, resolveUploadLinkOwner } from "./uploadLink";

function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    workspaceId: "ws-1",
    createdById: "owner-1",
    revokedAt: null,
    workspace: { name: "Surf Co" },
    ...overrides,
  };
}

beforeEach(() => {
  findUniqueMock.mockReset();
  memberFindManyMock.mockReset();
  consumeFixedWindowMock.mockReset();
  sendEmailMock.mockReset();
  releaseMock.mockReset();
  releaseMock.mockResolvedValue({ count: 1 });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});

  consumeFixedWindowMock.mockResolvedValue({ allowed: true });
  memberFindManyMock.mockResolvedValue([
    { user: { id: "owner-1", email: "a@example.com" } },
    { user: { id: "owner-2", email: "b@example.com" } },
  ]);
  sendEmailMock.mockResolvedValue(true);
  process.env.NEXTAUTH_URL = "https://app.example";
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.NEXTAUTH_URL;
});

describe("findActiveUploadLink", () => {
  it("finds a made token by the SHA-256 hash of it", async () => {
    const { raw, hash } = generateInviteToken();
    expect(hash).toBe(hashInviteToken(raw));
    findUniqueMock.mockResolvedValue(linkRow());

    const link = await findActiveUploadLink(raw);

    expect(findUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hash } }),
    );
    expect(link).toEqual({
      id: "link-1",
      workspaceId: "ws-1",
      createdById: "owner-1",
      workspaceName: "Surf Co",
    });
  });

  it("gives null while the workspace is paused, and the link again after a resume", async () => {
    const { raw } = generateInviteToken();
    findUniqueMock.mockResolvedValue(
      linkRow({ workspace: { name: "Surf Co", pausedAt: new Date("2026-11-10T08:00:00Z"), pausedReason: "Unpaid." } }),
    );
    expect(await findActiveUploadLink(raw)).toBeNull();

    findUniqueMock.mockResolvedValue(linkRow({ workspace: { name: "Surf Co", pausedAt: null, pausedReason: null } }));
    expect(await findActiveUploadLink(raw)).toMatchObject({ id: "link-1", workspaceId: "ws-1", workspaceName: "Surf Co" });
  });

  it("reads the pause fields with the link, in the same query", async () => {
    const { raw } = generateInviteToken();
    findUniqueMock.mockResolvedValue(linkRow());
    await findActiveUploadLink(raw);
    expect(findUniqueMock.mock.calls[0][0].select.workspace).toEqual({
      select: { name: true, pausedAt: true, pausedReason: true },
    });
  });

  it("gives null for an unknown token and for a revoked one alike", async () => {
    const { raw } = generateInviteToken();
    findUniqueMock.mockResolvedValue(null);
    expect(await findActiveUploadLink(raw)).toBeNull();

    findUniqueMock.mockResolvedValue(linkRow({ revokedAt: new Date() }));
    expect(await findActiveUploadLink(raw)).toBeNull();
  });

  it("does not look up a value that cannot be a token", async () => {
    expect(await findActiveUploadLink("short")).toBeNull();
    expect(await findActiveUploadLink(`${"A".repeat(42)}%`)).toBeNull();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});

describe("notifyOwnersOfClientUpload", () => {
  const args = {
    linkId: "link-1",
    workspaceId: "ws-1",
    workspaceName: "Surf Co",
    senderName: "Ana",
    now: new Date("2026-11-10T17:42:00Z"),
  };

  it("emails every owner the first time in the hour, with a per-owner key", async () => {
    await notifyOwnersOfClientUpload(args);

    expect(consumeFixedWindowMock).toHaveBeenCalledWith({
      key: "client-upload-email:link-1:2026-11-10T17",
      limit: 1,
      resetAt: new Date("2026-11-10T18:00:00Z"),
      failClosed: true,
    });
    expect(memberFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1", role: "owner" } }),
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "a@example.com", subject: "Ana sent files to Surf Co" }),
      { idempotencyKey: "client-upload/link-1/2026-11-10T17/owner-1", throwOnRetryable: true },
    );
    const [params] = sendEmailMock.mock.calls[1];
    expect(params.html).toContain('href="https://app.example/go?w=ws-1&amp;to=%2Fmedia"');
    // An email went: the hour's claim is kept.
    expect(releaseMock).not.toHaveBeenCalled();
  });

  // R39 client-journey L2: the hour is let go when no email went, through sendOncePer.
  it("the owners can't be read: the hour's claim is let go", async () => {
    memberFindManyMock.mockRejectedValue(new Error("db blip"));
    await notifyOwnersOfClientUpload(args);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: "client-upload-email:link-1:2026-11-10T17" } });
  });

  it("no send went: the hour's claim is let go", async () => {
    sendEmailMock.mockResolvedValue(false);
    await notifyOwnersOfClientUpload(args);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: "client-upload-email:link-1:2026-11-10T17" } });
  });

  it("a lost reply lets the hour go; the second owner is still sent, and the next file reuses the keys", async () => {
    sendEmailMock.mockRejectedValueOnce(new Error("Resend request failed before a response (network error)"));
    await notifyOwnersOfClientUpload(args);
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: "client-upload-email:link-1:2026-11-10T17" } });

    releaseMock.mockClear();
    await notifyOwnersOfClientUpload({ ...args, now: new Date("2026-11-10T17:55:00Z") });
    expect(sendEmailMock.mock.calls.map(([, options]) => options.idempotencyKey)).toEqual([
      "client-upload/link-1/2026-11-10T17/owner-1",
      "client-upload/link-1/2026-11-10T17/owner-2",
      "client-upload/link-1/2026-11-10T17/owner-1",
      "client-upload/link-1/2026-11-10T17/owner-2",
    ]);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  // R39 lead review L3: an hour's window is inside the keys' 24 hours, so a store blip sends with them.
  it("a counter store that can't answer: each owner is sent once, with their key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(args.now);
    consumeFixedWindowMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60, unavailable: true });
    await notifyOwnersOfClientUpload(args);
    expect(sendEmailMock.mock.calls.map(([, options]) => options.idempotencyKey)).toEqual([
      "client-upload/link-1/2026-11-10T17/owner-1",
      "client-upload/link-1/2026-11-10T17/owner-2",
    ]);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  // R40 lead: the hour's key can first be used when the hour begins.
  it("claims the hour with its start as keysFrom", async () => {
    await notifyOwnersOfClientUpload(args);
    expect(vi.mocked(sendOncePer).mock.calls.at(-1)![0]).toMatchObject({
      resetAt: new Date("2026-11-10T18:00:00.000Z"),
      keysFrom: new Date("2026-11-10T17:00:00.000Z"),
    });
  });

  it("does not email again within the hour", async () => {
    consumeFixedWindowMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 600 });

    await notifyOwnersOfClientUpload(args);

    expect(memberFindManyMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("never throws when the lookup or the send fails", async () => {
    sendEmailMock.mockRejectedValue(new Error("resend down"));
    await expect(notifyOwnersOfClientUpload(args)).resolves.toBeUndefined();

    memberFindManyMock.mockRejectedValue(new Error("db down"));
    await expect(notifyOwnersOfClientUpload(args)).resolves.toBeUndefined();
  });

  it("gives up waiting after 5 seconds", async () => {
    vi.useFakeTimers();
    sendEmailMock.mockReturnValue(new Promise(() => {}));

    let settled = false;
    const done = notifyOwnersOfClientUpload(args).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(settled).toBe(true);
  });
});

describe("resolveUploadLinkOwner", () => {
  const link = { id: "link-1", workspaceId: "ws-1", createdById: "creator", workspaceName: "Surf Co" };

  it("asks for the workspace's owners, longest-standing first", async () => {
    memberFindManyMock.mockResolvedValue([]);
    await resolveUploadLinkOwner(link);
    expect(memberFindManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", role: "owner" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { userId: true },
    });
  });

  it("keeps the link's creator while they are still an owner", async () => {
    memberFindManyMock.mockResolvedValue([{ userId: "first-owner" }, { userId: "creator" }]);
    expect(await resolveUploadLinkOwner(link)).toBe("creator");
  });

  it("falls back to the longest-standing owner when the creator left, or was made a member", async () => {
    // A member's row is not in an owner query, so leaving and demotion look the same.
    memberFindManyMock.mockResolvedValue([{ userId: "first-owner" }, { userId: "second-owner" }]);
    expect(await resolveUploadLinkOwner(link)).toBe("first-owner");
  });

  it("falls back the same way when the creator's account is gone (its memberships go with it)", async () => {
    memberFindManyMock.mockResolvedValue([{ userId: "only-owner" }]);
    expect(await resolveUploadLinkOwner({ ...link, createdById: "deleted-user" })).toBe("only-owner");
  });

  it("gives null when the workspace has no owner", async () => {
    memberFindManyMock.mockResolvedValue([]);
    expect(await resolveUploadLinkOwner(link)).toBeNull();
  });
});
