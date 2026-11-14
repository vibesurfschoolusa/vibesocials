import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PickedFile } from "@/lib/clientPage";

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

function render(picked: PickedFile, previewUrl: string | null = null, onRemove?: () => void): string {
  return renderToStaticMarkup(createElement(UploadFileRow, { item: picked, previewUrl, onRemove }));
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
    const failed = render(item({ status: "failed", error: "Storage is full." }));
    expect(failed).toContain("Not sent");
    expect(failed).toContain("Storage is full.");
  });

  it("offers Remove only when asked to, with a 40px tap target and the file's name", () => {
    expect(render(item())).not.toContain("Remove");
    const html = render(item(), null, () => {});
    expect(html).toContain('aria-label="Remove wave.jpg"');
    expect(html).toContain("min-h-10");
  });
});
