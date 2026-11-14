import { beforeEach, describe, expect, it, vi } from "vitest";

import { findPairHalf, PAIR_HALF_SELECT } from "./pairHalf";

const findFirst = vi.fn();
const db = { postJob: { findFirst } } as unknown as Parameters<typeof findPairHalf>[0];

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "story-1",
    storyOfPostJobId: "feed-1",
    status: "scheduled",
    scheduledFor: new Date("2026-11-20T15:00:00Z"),
    submittedForApprovalAt: null,
    approvedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  findFirst.mockReset();
});

// R2-client-journey M1: the other half of a Feed and Story post, read in the workspace only.
describe("findPairHalf", () => {
  it("a feed post: its Story job, in this workspace", async () => {
    findFirst.mockResolvedValue(row());

    const half = await findPairHalf(db, "ws-1", { id: "feed-1", storyOfPostJobId: null });

    expect(findFirst).toHaveBeenCalledWith({
      where: { storyOfPostJobId: "feed-1", workspaceId: "ws-1" },
      orderBy: { createdAt: "asc" },
      select: PAIR_HALF_SELECT,
    });
    expect(half).toEqual({
      id: "story-1",
      kind: "story",
      status: "scheduled",
      scheduledFor: new Date("2026-11-20T15:00:00Z"),
      submittedForApprovalAt: null,
      approvedAt: null,
    });
  });

  it("a Story: its feed job, in this workspace", async () => {
    findFirst.mockResolvedValue(row({ id: "feed-1", storyOfPostJobId: null }));

    const half = await findPairHalf(db, "ws-1", { id: "story-1", storyOfPostJobId: "feed-1" });

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "feed-1", workspaceId: "ws-1" },
      select: PAIR_HALF_SELECT,
    });
    expect(half?.kind).toBe("feed");
    expect(half?.id).toBe("feed-1");
  });

  it("no other half: null", async () => {
    findFirst.mockResolvedValue(null);
    expect(await findPairHalf(db, "ws-1", { id: "feed-1", storyOfPostJobId: null })).toBeNull();
    expect(await findPairHalf(db, "ws-1", { id: "story-1", storyOfPostJobId: "gone" })).toBeNull();
  });

  it("a cancelled other half is no longer part of the post: null", async () => {
    findFirst.mockResolvedValue(row({ status: "cancelled" }));
    expect(await findPairHalf(db, "ws-1", { id: "feed-1", storyOfPostJobId: null })).toBeNull();
  });

  it("a row that does not point back is not the pair: null", async () => {
    findFirst.mockResolvedValue(row({ storyOfPostJobId: "someone-else" }));
    expect(await findPairHalf(db, "ws-1", { id: "feed-1", storyOfPostJobId: null })).toBeNull();
    findFirst.mockResolvedValue(row({ id: "other" }));
    expect(await findPairHalf(db, "ws-1", { id: "story-1", storyOfPostJobId: "feed-1" })).toBeNull();
  });
});
