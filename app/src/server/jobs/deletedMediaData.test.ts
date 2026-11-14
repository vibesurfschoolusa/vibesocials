import { describe, expect, it } from "vitest";

import { deletedMediaData } from "./deletedMediaData";

/**
 * G4 (R2-pages M1): the privacy page says a client's name and note are deleted
 * with the file they sent. Marking a MediaItem deleted now also clears them and
 * the file's original name; every other file is only marked deleted.
 */

const NOW = new Date("2026-11-14T12:00:00Z");

describe("deletedMediaData", () => {
  it("clears the sender's name, note and file name of a client upload link file", () => {
    const data = deletedMediaData(
      {
        originalFilename: "Maria Lopez birthday.JPG",
        metadata: { source: "upload_link", linkId: "link-1", senderName: "Maria", note: "Call me on 555" },
      },
      NOW,
    );
    expect(data).toEqual({
      deletedAt: NOW,
      originalFilename: "deleted-file.jpg",
      metadata: { source: "upload_link", linkId: "link-1" },
    });
  });

  it("keeps the rest of a client file's metadata (a location added when it was posted)", () => {
    const data = deletedMediaData(
      {
        originalFilename: "clip.mp4",
        metadata: { source: "upload_link", linkId: "l", senderName: "A", location: { description: "Beach" } },
      },
      NOW,
    );
    expect(data.metadata).toEqual({ source: "upload_link", linkId: "l", location: { description: "Beach" } });
    expect(data.originalFilename).toBe("deleted-file.mp4");
  });

  it("names a client file without a usable extension plainly", () => {
    expect(
      deletedMediaData({ originalFilename: "no extension", metadata: { source: "upload_link" } }, NOW)
        .originalFilename,
    ).toBe("deleted-file");
  });

  it("only marks any other file deleted", () => {
    expect(
      deletedMediaData({ originalFilename: "team.jpg", metadata: { location: { description: "Pier" } } }, NOW),
    ).toEqual({ deletedAt: NOW });
    expect(deletedMediaData({ originalFilename: "team.jpg", metadata: null }, NOW)).toEqual({ deletedAt: NOW });
  });
});
