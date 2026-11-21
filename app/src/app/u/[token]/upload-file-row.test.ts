import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PickedFile } from "@/lib/clientPage";

import type { ClientFileFailureKind } from "./send-file";
import { UploadFileRow } from "./upload-file-row";

function item(over: Partial<PickedFile> & { name?: string; type?: string; size?: number } = {}): PickedFile {
  const { name = "wave.jpg", type = "image/jpeg", size = 3 * 1024 * 1024, ...rest } = over;
  return {
    key: "k",
    file: new File([new Uint8Array(size)], name, { type }),
    status: "waiting",
    progress: 0,
    error: null,
    ...rest,
  };
}

function render(
  picked: PickedFile,
  previewUrl: string | null = null,
  onRemove?: () => void,
  failureKind?: ClientFileFailureKind,
  position = 1,
): string {
  return renderToStaticMarkup(createElement(UploadFileRow, { item: picked, previewUrl, onRemove, failureKind, position }));
}

describe("UploadFileRow", () => {
  it("shows a small thumbnail for a photo, the name and the size", () => {
    const html = render(item(), "blob:preview-1");
    expect(html).toContain('src="blob:preview-1"');
    expect(html).toContain("wave.jpg");
    expect(html).toContain("3 MB");
    expect(html).toContain("Waiting");
  });

  it("shows a film icon, not an image, for a video", () => {
    const html = render(item({ name: "clip.mp4", type: "video/mp4" }), "blob:ignored");
    expect(html).not.toContain("<img");
    expect(html).toContain('data-kind="video"');
  });

  it("falls back to a photo icon while there is no preview yet", () => {
    const html = render(item(), null);
    expect(html).not.toContain("<img");
    expect(html).toContain('data-kind="photo"');
  });

  it("shows the sending percentage with a progress bar", () => {
    const html = render(item({ status: "sending", progress: 41.6 }));
    expect(html).toContain("42%");
    expect(html).toContain('aria-valuenow="42"');
  });

  it("marks a sent file Sent and a failed one Not sent with its sentence", () => {
    expect(render(item({ status: "sent", progress: 100 }))).toContain("Sent");
    const failed = render(item({ status: "failed", error: "Storage is full." }), null, undefined, "refused");
    expect(failed).toContain("Not sent");
    expect(failed).toContain("Storage is full.");
  });

  it("offers Remove only when asked to, with a 40px tap target and the file's name", () => {
    expect(render(item())).not.toContain("Remove");
    const html = render(item(), null, () => {});
    expect(html).toContain('aria-label="Remove 1. wave.jpg"');
    expect(html).toContain("min-h-10");
  });
});

// R29 lead review: the row said a red "Not sent" for a file the summary says
// may have arrived. The row follows the failure's kind.
describe("UploadFileRow: a failed file, by kind", () => {
  const failed = item({ status: "failed", error: "The sentence." });

  it("network and refused: a red Not sent, with its sentence", () => {
    for (const kind of ["network", "refused"] as const) {
      const html = render(failed, null, undefined, kind);
      expect(html, kind).toContain('<span class="text-destructive">Not sent</span>');
      expect(html, kind).toContain("bg-destructive");
      expect(html, kind).toContain('<p class="text-sm text-destructive">The sentence.</p>');
    }
  });

  it("maybe: May have arrived, not red", () => {
    const html = render(failed, null, undefined, "maybe");
    expect(html).toContain("May have arrived");
    expect(html).not.toContain("Not sent");
    expect(html).not.toContain("destructive");
    expect(html).toContain('<p class="text-sm text-foreground">The sentence.</p>');
  });

  it("no kind given: read as maybe, as the form reads a failure it can't place", () => {
    expect(render(failed)).toContain("May have arrived");
  });

  it("the form passes each file's kind", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./upload-link-form.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/failureKind=\{failureKinds\[item\.key\]\}/);
    expect(source).toMatch(/<UploadFileRow item=\{item\} previewUrl=\{previewUrl\} onRemove=\{onRemove\} failureKind=\{failureKind\} position=\{position\} \/>/);
  });
});

// R58 pages-a-2 L1: two phones give files the same name, so a row's controls
// name it by its position in the list, as Add many's rows do.
describe("UploadFileRow: same-named files", () => {
  it("two files with the same name have different names, by their position", () => {
    const first = render(item({ name: "IMG_0001.JPG" }), null, () => {}, undefined, 1);
    const second = render(item({ name: "IMG_0001.JPG" }), null, () => {}, undefined, 2);
    expect(first).toContain('aria-label="Remove 1. IMG_0001.JPG"');
    expect(second).toContain('aria-label="Remove 2. IMG_0001.JPG"');
    expect(first).toContain('aria-label="1. IMG_0001.JPG progress"');
    expect(second).toContain('aria-label="2. IMG_0001.JPG progress"');
  });

  it("the form gives each row its position in the list", () => {
    const form = readFileSync(fileURLToPath(new URL("./upload-link-form.tsx", import.meta.url)), "utf8");
    expect(form).toMatch(/files\.map\(\(item, index\) => \(\s*<FileRow[^>]*position=\{index \+ 1\}/);
  });
});
