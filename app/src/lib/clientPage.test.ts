import { describe, expect, it } from "vitest";

import { addPickedFiles, fileKind, formatFileSize, workspaceInitials } from "./clientPage";

function file(name: string, size = 10, type = "image/jpeg", lastModified = 1): File {
  return new File([new Uint8Array(size)], name, { type, lastModified });
}

describe("workspaceInitials", () => {
  it("takes the first letter of the first two words, upper case", () => {
    expect(workspaceInitials("surf co")).toBe("SC");
    expect(workspaceInitials("Vibe Surf School USA")).toBe("VS");
  });
  it("uses one letter for one word and a fallback for nothing", () => {
    expect(workspaceInitials("Surf")).toBe("S");
    expect(workspaceInitials("   ")).toBe("?");
  });
  it("counts an emoji as one character", () => {
    expect(workspaceInitials("🌊 Waves")).toBe("🌊W");
  });
});

describe("formatFileSize", () => {
  it("writes plain units", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("2 KB");
    expect(formatFileSize(3.2 * 1024 * 1024)).toBe("3.2 MB");
    expect(formatFileSize(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });
});

describe("fileKind", () => {
  it("tells photos from videos by type, then by name when the browser gives no type", () => {
    expect(fileKind({ name: "a.jpg", type: "image/jpeg" })).toBe("photo");
    expect(fileKind({ name: "a.mp4", type: "video/mp4" })).toBe("video");
    expect(fileKind({ name: "clip.MOV", type: "" })).toBe("video");
    expect(fileKind({ name: "a.heic", type: "" })).toBe("photo");
  });
});

describe("addPickedFiles", () => {
  it("appends new files and skips one already in the list", () => {
    const first = addPickedFiles([], [file("a.jpg"), file("b.jpg")]);
    expect(first.map((item) => item.file.name)).toEqual(["a.jpg", "b.jpg"]);
    const second = addPickedFiles(first, [file("a.jpg"), file("c.jpg")]);
    expect(second.map((item) => item.file.name)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
  });
  it("starts every file waiting, with unique keys", () => {
    const items = addPickedFiles([], [file("a.jpg", 5), file("a.jpg", 6)]);
    expect(items.every((item) => item.status === "waiting" && item.progress === 0 && item.error === null)).toBe(true);
    expect(new Set(items.map((item) => item.key)).size).toBe(2);
  });
});
