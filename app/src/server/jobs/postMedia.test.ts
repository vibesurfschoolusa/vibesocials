import { beforeEach, describe, expect, it, vi } from "vitest";

const { postJobFindUniqueMock, postJobMediaFindManyMock, mediaItemUpdateManyMock, transactionMock } = vi.hoisted(
  () => ({
    postJobFindUniqueMock: vi.fn(),
    postJobMediaFindManyMock: vi.fn(),
    mediaItemUpdateManyMock: vi.fn(),
    transactionMock: vi.fn(),
  }),
);

vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findUnique: postJobFindUniqueMock },
    postJobMedia: { findMany: postJobMediaFindManyMock },
    mediaItem: { updateMany: mediaItemUpdateManyMock },
    $transaction: transactionMock,
  },
}));

import {
  loadPostMediaItems,
  POST_PHOTO_UNAVAILABLE_MESSAGE,
  PostMediaUnavailableError,
  saveMediaAltTexts,
} from "./postMedia";

function item(id: string) {
  return { id, mimeType: "image/jpeg", deletedAt: null };
}

beforeEach(() => {
  postJobFindUniqueMock.mockReset();
  postJobMediaFindManyMock.mockReset();
  mediaItemUpdateManyMock.mockReset();
  mediaItemUpdateManyMock.mockImplementation((args: unknown) => ({ updateMany: args }));
  transactionMock.mockReset();
  transactionMock.mockResolvedValue([]);
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

// 07d: the description is written onto the post's own media rows, scoped to the
// workspace and to photos, after the create helper made (or reused) them.
describe("saveMediaAltTexts", () => {
  const where = (id: string) => ({ id, workspaceId: "ws-1", mimeType: { startsWith: "image/" } });

  it("writes nothing, and reads nothing, when no photo has a description", async () => {
    await saveMediaAltTexts({ workspaceId: "ws-1", postJobId: "job-1", mediaItemId: "m1", altTexts: [undefined] });
    await saveMediaAltTexts({
      workspaceId: "ws-1",
      postJobId: "job-1",
      mediaItemId: "m1",
      altTexts: [undefined, undefined],
    });

    expect(postJobMediaFindManyMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("a single photo: updates the post's one media item, in the caller's workspace, photos only", async () => {
    await saveMediaAltTexts({ workspaceId: "ws-1", postJobId: "job-1", mediaItemId: "m1", altTexts: ["A dog."] });

    expect(postJobMediaFindManyMock).not.toHaveBeenCalled();
    expect(mediaItemUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(mediaItemUpdateManyMock).toHaveBeenCalledWith({ where: where("m1"), data: { altText: "A dog." } });
    expect(transactionMock).toHaveBeenCalledWith([{ updateMany: { where: where("m1"), data: { altText: "A dog." } } }]);
  });

  it("several photos: each description goes to the row at its position, and only those with one", async () => {
    postJobMediaFindManyMock.mockResolvedValue([
      { mediaItemId: "m1", position: 0 },
      { mediaItemId: "m2", position: 1 },
      { mediaItemId: "m3", position: 2 },
    ]);

    await saveMediaAltTexts({
      workspaceId: "ws-1",
      postJobId: "job-1",
      mediaItemId: "m1",
      altTexts: ["First.", undefined, "Third."],
    });

    expect(postJobMediaFindManyMock).toHaveBeenCalledWith({
      where: { postJobId: "job-1" },
      orderBy: { position: "asc" },
      select: { mediaItemId: true, position: true },
    });
    expect(mediaItemUpdateManyMock.mock.calls.map(([args]) => args)).toEqual([
      { where: where("m1"), data: { altText: "First." } },
      { where: where("m3"), data: { altText: "Third." } },
    ]);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it("never writes outside the workspace: every update is scoped to it", async () => {
    await saveMediaAltTexts({ workspaceId: "ws-2", postJobId: "job-1", mediaItemId: "foreign", altTexts: ["x"] });

    expect(mediaItemUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "foreign", workspaceId: "ws-2" }) }),
    );
  });
});
