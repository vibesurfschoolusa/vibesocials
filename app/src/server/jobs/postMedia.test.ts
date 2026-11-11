import { beforeEach, describe, expect, it, vi } from "vitest";

const { postJobFindUniqueMock } = vi.hoisted(() => ({ postJobFindUniqueMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { postJob: { findUnique: postJobFindUniqueMock } },
}));

import {
  loadPostMediaItems,
  POST_PHOTO_UNAVAILABLE_MESSAGE,
  PostMediaUnavailableError,
} from "./postMedia";

function item(id: string) {
  return { id, mimeType: "image/jpeg", deletedAt: null };
}

beforeEach(() => {
  postJobFindUniqueMock.mockReset();
});

describe("loadPostMediaItems", () => {
  it("a post without rows returns its one media item", async () => {
    postJobFindUniqueMock.mockResolvedValue({ mediaItemId: "m1", mediaItem: item("m1"), media: [] });

    await expect(loadPostMediaItems("job-1")).resolves.toEqual([item("m1")]);
    expect(postJobFindUniqueMock).toHaveBeenCalledWith({
      where: { id: "job-1" },
      select: {
        mediaItemId: true,
        mediaItem: true,
        media: { orderBy: { position: "asc" }, select: { position: true, mediaItem: true } },
      },
    });
  });

  it("returns the rows' items in position order", async () => {
    postJobFindUniqueMock.mockResolvedValue({
      mediaItemId: "m1",
      mediaItem: item("m1"),
      media: [
        { position: 0, mediaItem: item("m1") },
        { position: 1, mediaItem: item("m2") },
        { position: 2, mediaItem: item("m3") },
      ],
    });

    const items = await loadPostMediaItems("job-1");
    expect(items.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("reads through the transaction client when one is given", async () => {
    const txFindUnique = vi.fn().mockResolvedValue({ mediaItemId: "m1", mediaItem: item("m1"), media: [] });
    const tx = { postJob: { findUnique: txFindUnique } };

    await loadPostMediaItems("job-1", tx as never);

    expect(txFindUnique).toHaveBeenCalledTimes(1);
    expect(postJobFindUniqueMock).not.toHaveBeenCalled();
  });

  it("reports a missing post", async () => {
    postJobFindUniqueMock.mockResolvedValue(null);
    await expect(loadPostMediaItems("job-1")).rejects.toBeInstanceOf(PostMediaUnavailableError);
  });

  it("reports a photo whose row is gone (a gap in the positions)", async () => {
    // Deleting a MediaItem cascades to its PostJobMedia row, leaving a gap.
    postJobFindUniqueMock.mockResolvedValue({
      mediaItemId: "m1",
      mediaItem: item("m1"),
      media: [
        { position: 0, mediaItem: item("m1") },
        { position: 2, mediaItem: item("m3") },
      ],
    });

    const error = await loadPostMediaItems("job-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PostMediaUnavailableError);
    expect((error as Error).message).toBe(POST_PHOTO_UNAVAILABLE_MESSAGE);
    expect(POST_PHOTO_UNAVAILABLE_MESSAGE).toBe("One of this post's photos is no longer available.");
  });

  it("reports a post left with one row, or whose first row is not its media item", async () => {
    postJobFindUniqueMock.mockResolvedValue({
      mediaItemId: "m1",
      mediaItem: item("m1"),
      media: [{ position: 0, mediaItem: item("m1") }],
    });
    await expect(loadPostMediaItems("job-1")).rejects.toBeInstanceOf(PostMediaUnavailableError);

    postJobFindUniqueMock.mockResolvedValue({
      mediaItemId: "m1",
      mediaItem: item("m1"),
      media: [
        { position: 0, mediaItem: item("m9") },
        { position: 1, mediaItem: item("m2") },
      ],
    });
    await expect(loadPostMediaItems("job-1")).rejects.toBeInstanceOf(PostMediaUnavailableError);
  });
});

describe("loadPostMediaItems - a post without a file", () => {
  it("has no media to load: it reports the post's media unavailable instead of returning an empty list", async () => {
    postJobFindUniqueMock.mockResolvedValue({ mediaItemId: null, mediaItem: null, media: [] });
    await expect(loadPostMediaItems("job-1")).rejects.toBeInstanceOf(PostMediaUnavailableError);
  });

  it("isPostMediaComplete is false for a post without a file", async () => {
    const { isPostMediaComplete } = await import("./postMedia");
    expect(
      isPostMediaComplete(null, [
        { position: 0, mediaItem: { id: "m1" } },
        { position: 1, mediaItem: { id: "m2" } },
      ]),
    ).toBe(false);
  });
});
