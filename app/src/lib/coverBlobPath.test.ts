import { describe, expect, it } from "vitest";

import {
  COVER_ADDRESS_REFUSED_MESSAGE,
  coverBlobPathname,
  coverUploadRefusal,
  isCoverAddress,
  isWorkspaceCoverAddress,
} from "./coverBlobPath";

const HOST = "https://abc.public.blob.vercel-storage.com";

describe("coverBlobPathname", () => {
  it("puts the cover under covers/<workspace>/ with one safe file name", () => {
    const path = coverBlobPathname("ws1abc", 1_700_000_000_000, "r4nd0m");
    expect(path).toBe("covers/ws1abc/1700000000000-r4nd0m-cover.jpg");
    expect(isWorkspaceCoverAddress(`${HOST}/${path}`, "ws1abc")).toBe(true);
  });
});

describe("isWorkspaceCoverAddress", () => {
  it("takes this workspace's covers only", () => {
    expect(isWorkspaceCoverAddress(`${HOST}/covers/ws1/1-a-cover.jpg`, "ws1")).toBe(true);
    expect(isWorkspaceCoverAddress(`${HOST}/covers/ws2/1-a-cover.jpg`, "ws1")).toBe(false);
    expect(isWorkspaceCoverAddress(`${HOST}/1-a-cover.jpg`, "ws1")).toBe(false);
  });

  it("refuses every spelling that could reach another folder", () => {
    for (const path of [
      "covers/ws1/../ws2/a.jpg",
      "covers/ws1/%2e%2e/ws2/a.jpg",
      "covers/ws1%2fa.jpg",
      "covers/ws1/sub/a.jpg",
      "COVERS/ws1/a.jpg",
      "covers//ws1/a.jpg",
    ]) {
      expect(isWorkspaceCoverAddress(`${HOST}/${path}`, "ws1"), path).toBe(false);
    }
  });
});

describe("coverUploadRefusal (/api/upload)", () => {
  it("lets a workspace upload under its own covers/ folder, and any other file as before", () => {
    expect(coverUploadRefusal("covers/ws1/1-a-cover.jpg", "ws1")).toBeNull();
    expect(coverUploadRefusal("1700-abc-video.mp4", "ws1")).toBeNull();
  });

  it("refuses another workspace's covers/ folder in any spelling", () => {
    for (const path of ["covers/ws2/a.jpg", "/covers/ws2/a.jpg", "Covers/ws1/a.jpg", "covers/ws1/../ws2/a.jpg", "covers%2Fws2/a.jpg"]) {
      expect(coverUploadRefusal(path, "ws1"), path).toBe(COVER_ADDRESS_REFUSED_MESSAGE);
    }
  });

  it("knows a covers/ address when it sees one", () => {
    expect(isCoverAddress(`${HOST}/covers/ws1/a.jpg`)).toBe(true);
    expect(isCoverAddress(`${HOST}/media/a.jpg`)).toBe(false);
  });
});
