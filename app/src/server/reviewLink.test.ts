import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  linkFindUniqueMock,
  postFindManyMock,
  postFindFirstMock,
  groupByMock,
  connectionFindManyMock,
  memberFindManyMock,
  sendEmailMock,
} = vi.hoisted(() => ({
  linkFindUniqueMock: vi.fn(),
  postFindManyMock: vi.fn(),
  postFindFirstMock: vi.fn(),
  groupByMock: vi.fn(),
  connectionFindManyMock: vi.fn(),
  memberFindManyMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceReviewLink: { findUnique: linkFindUniqueMock },
    postJob: { findMany: postFindManyMock, findFirst: postFindFirstMock },
    postJobMedia: { groupBy: groupByMock },
    socialConnection: { findMany: connectionFindManyMock },
    workspaceMember: { findMany: memberFindManyMock },
  },
}));
vi.mock("@/server/notifications/email", () => ({ sendEmail: sendEmailMock }));

import { generateInviteToken, hashInviteToken } from "@/lib/inviteToken";

import { findActiveReviewLink, listReviewPosts, notifyOwnersOfClientChange } from "./reviewLink";

const NOW = new Date("2026-11-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    workspaceId: "ws-1",
    revokedAt: null,
    workspace: { name: "Surf Co" },
    ...overrides,
  };
}

/** A post row as the list query selects it, plus fields it must never pass on. */
function postRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    scheduledFor: new Date("2026-11-12T15:00:00Z"),
    baseCaption: "Dawn patrol tomorrow",
    perPlatformOverrides: null,
    publishMetadata: { targetPlatforms: ["instagram", "facebook_page"], tiktok: { privacyLevel: "SELF_ONLY" } },
    clientApprovedAt: null,
    clientChangeRequestedAt: null,
    clientNote: null,
    mediaItem: {
      baseCaption: "media caption",
      perPlatformOverrides: null,
      storageLocation: "https://store.public.blob.vercel-storage.com/a.jpg",
      mimeType: "image/jpeg",
    },
    // Never selected by the real query; here to prove the mapper drops them.
    userId: "user-1",
    workspaceId: "ws-1",
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of [
    linkFindUniqueMock,
    postFindManyMock,
    postFindFirstMock,
    groupByMock,
    connectionFindManyMock,
    memberFindManyMock,
    sendEmailMock,
  ]) {
    mock.mockReset();
  }
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});

  postFindManyMock.mockResolvedValue([]);
  groupByMock.mockResolvedValue([]);
  connectionFindManyMock.mockResolvedValue([]);
  memberFindManyMock.mockResolvedValue([
    { user: { id: "owner-1", email: "a@example.com" } },
    { user: { id: "owner-2", email: "b@example.com" } },
  ]);
  sendEmailMock.mockResolvedValue(undefined);
  process.env.NEXTAUTH_URL = "https://app.example";
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.NEXTAUTH_URL;
});

describe("findActiveReviewLink", () => {
  it("finds a made token by the SHA-256 hash of it", async () => {
    const { raw, hash } = generateInviteToken();
    expect(hash).toBe(hashInviteToken(raw));
    linkFindUniqueMock.mockResolvedValue(linkRow());

    expect(await findActiveReviewLink(raw)).toEqual({
      id: "link-1",
      workspaceId: "ws-1",
      workspaceName: "Surf Co",
    });
    expect(linkFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hash } }),
    );
  });

  it("gives null for an unknown token and for a revoked one alike", async () => {
    const { raw } = generateInviteToken();
    linkFindUniqueMock.mockResolvedValue(null);
    expect(await findActiveReviewLink(raw)).toBeNull();

    linkFindUniqueMock.mockResolvedValue(linkRow({ revokedAt: new Date() }));
    expect(await findActiveReviewLink(raw)).toBeNull();
  });

  it("does not look up a value that cannot be a token", async () => {
    expect(await findActiveReviewLink("short")).toBeNull();
    expect(await findActiveReviewLink(`${"A".repeat(42)}%`)).toBeNull();
    expect(linkFindUniqueMock).not.toHaveBeenCalled();
  });
});

describe("listReviewPosts", () => {
  it("asks only for the workspace's scheduled posts in the next 60 days, earliest first, at most 100", async () => {
    await listReviewPosts("ws-1", NOW);

    const scheduledQuery = postFindManyMock.mock.calls[0][0];
    expect(scheduledQuery.where).toEqual({
      workspaceId: "ws-1",
      status: "scheduled",
      scheduledFor: { gte: NOW, lte: new Date(NOW.getTime() + 60 * DAY) },
    });
    expect(scheduledQuery.orderBy).toEqual([{ scheduledFor: "asc" }, { id: "asc" }]);
    expect(scheduledQuery.take).toBe(100);
  });

  it("asks for the drafts the client asked to change in the last 30 days, and nothing else", async () => {
    await listReviewPosts("ws-1", NOW);

    const changedQuery = postFindManyMock.mock.calls[1][0];
    expect(changedQuery.where).toEqual({
      workspaceId: "ws-1",
      status: "draft",
      clientChangeRequestedAt: { gte: new Date(NOW.getTime() - 30 * DAY) },
    });
    expect(changedQuery.take).toBe(100);
    // Neither query can return a published, failed or cancelled post, or another workspace's.
    for (const [query] of postFindManyMock.mock.calls) {
      expect(query.where.workspaceId).toBe("ws-1");
      expect(["scheduled", "draft"]).toContain(query.where.status);
    }
  });

  it("selects no user, email, token or settings", async () => {
    await listReviewPosts("ws-1", NOW);
    for (const [query] of postFindManyMock.mock.calls) {
      const selected = JSON.stringify(query.select);
      expect(selected).not.toContain("user");
      expect(selected).not.toContain("email");
      expect(selected).not.toContain("workspaceId");
    }
  });

  it("passes on only the documented fields of a scheduled post", async () => {
    postFindManyMock.mockResolvedValueOnce([postRow()]).mockResolvedValueOnce([]);

    const posts = await listReviewPosts("ws-1", NOW);

    expect(posts).toEqual([
      {
        id: "post-1",
        scheduledFor: "2026-11-12T15:00:00.000Z",
        platforms: ["Instagram", "Facebook Page"],
        caption: "Dawn patrol tomorrow",
        platformCaptions: [],
        media: { url: "https://store.public.blob.vercel-storage.com/a.jpg", mimeType: "image/jpeg" },
        mediaCount: 1,
        state: "none",
        note: null,
      },
    ]);
    const text = JSON.stringify(posts);
    for (const secret of ["user-1", "ws-1", "SELF_ONLY", "media caption"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("lists each platform's own caption under the main one, by platform name", async () => {
    postFindManyMock
      .mockResolvedValueOnce([
        postRow({
          perPlatformOverrides: { instagram: "IG text", x: "not a target", junk: "no" },
        }),
      ])
      .mockResolvedValueOnce([]);

    const [post] = await listReviewPosts("ws-1", NOW);

    expect(post.platformCaptions).toEqual([{ label: "Instagram", text: "IG text" }]);
  });

  it("names the connected platforms when the post has no chosen ones", async () => {
    postFindManyMock.mockResolvedValueOnce([postRow({ publishMetadata: null })]).mockResolvedValueOnce([]);
    connectionFindManyMock.mockResolvedValue([{ platform: "youtube" }, { platform: "tiktok" }]);

    const [post] = await listReviewPosts("ws-1", NOW);

    expect(connectionFindManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      select: { platform: true },
    });
    expect(post.platforms).toEqual(["TikTok", "YouTube"]);
  });

  it("shows the photo count and the client's approval", async () => {
    postFindManyMock
      .mockResolvedValueOnce([postRow({ clientApprovedAt: new Date("2026-11-10T08:00:00Z") })])
      .mockResolvedValueOnce([]);
    groupByMock.mockResolvedValue([{ postJobId: "post-1", _count: { _all: 3 } }]);

    const [post] = await listReviewPosts("ws-1", NOW);

    expect(groupByMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { postJobId: { in: ["post-1"] } } }),
    );
    expect(post.mediaCount).toBe(3);
    expect(post.state).toBe("approved");
  });

  it("shows a recent change request with the client's note, in time order with the rest", async () => {
    postFindManyMock
      .mockResolvedValueOnce([
        postRow({ id: "later", scheduledFor: new Date("2026-11-20T10:00:00Z") }),
      ])
      .mockResolvedValueOnce([
        postRow({
          id: "changed",
          scheduledFor: new Date("2026-11-15T10:00:00Z"),
          clientChangeRequestedAt: new Date("2026-11-09T10:00:00Z"),
          clientNote: "Use the <b>other</b> photo",
        }),
      ]);

    const posts = await listReviewPosts("ws-1", NOW);

    expect(posts.map((post) => post.id)).toEqual(["changed", "later"]);
    expect(posts[0]).toMatchObject({ state: "change_requested", note: "Use the <b>other</b> photo" });
    expect(posts[1]).toMatchObject({ state: "none", note: null });
  });

  it("does not ask for counts or connections when there is nothing to show", async () => {
    expect(await listReviewPosts("ws-1", NOW)).toEqual([]);
    expect(groupByMock).not.toHaveBeenCalled();
    expect(connectionFindManyMock).not.toHaveBeenCalled();
  });
});

describe("notifyOwnersOfClientChange", () => {
  const args = {
    postJobId: "post-1",
    workspaceId: "ws-1",
    workspaceName: "Surf Co",
    note: "Use the other photo",
    requestedAt: new Date("2026-11-10T17:42:00Z"),
  };

  beforeEach(() => {
    postFindFirstMock.mockResolvedValue({
      scheduledFor: new Date("2026-11-12T15:00:00Z"),
      baseCaption: "Dawn patrol tomorrow",
      mediaItem: { baseCaption: "media caption" },
    });
  });

  it("emails every owner, keyed on the post and the request time", async () => {
    await notifyOwnersOfClientChange(args);

    expect(postFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "post-1", workspaceId: "ws-1" } }),
    );
    expect(memberFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1", role: "owner" } }),
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "a@example.com",
        subject: "Surf Co: your client asked for a change",
      }),
      { idempotencyKey: "client-change/post-1/2026-11-10T17:42:00.000Z/owner-1" },
    );
    const [params, options] = sendEmailMock.mock.calls[1];
    expect(params.html).toContain("Use the other photo");
    expect(params.html).toContain("Dawn patrol tomorrow");
    expect(params.html).toContain('href="https://app.example/queue"');
    // Best-effort: never the retrying mode.
    expect(options).not.toHaveProperty("throwOnRetryable");
  });

  it("never throws when the lookup or the send fails", async () => {
    sendEmailMock.mockRejectedValue(new Error("resend down"));
    await expect(notifyOwnersOfClientChange(args)).resolves.toBeUndefined();

    postFindFirstMock.mockRejectedValue(new Error("db down"));
    await expect(notifyOwnersOfClientChange(args)).resolves.toBeUndefined();
  });

  it("sends nothing when the post is gone", async () => {
    postFindFirstMock.mockResolvedValue(null);
    await notifyOwnersOfClientChange(args);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("gives up waiting after 5 seconds", async () => {
    vi.useFakeTimers();
    sendEmailMock.mockReturnValue(new Promise(() => {}));

    let settled = false;
    const done = notifyOwnersOfClientChange(args).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(settled).toBe(true);
  });
});
