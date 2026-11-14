import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob/client", () => ({ upload: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

import { MediaFilePicker, MEDIA_ACCEPT, pickDroppedFile, takePickedFile } from "./media-library";

const file = (name: string, type: string, size = 2048) => ({ name, type, size }) as File;
const render = (f: File | null) =>
  renderToStaticMarkup(createElement(MediaFilePicker, { file: f, inputKey: 0, onFile: () => {}, onReject: () => {} }));

describe("MediaFilePicker", () => {
  it("renders the hidden real file input with the same accept list and id", () => {
    const html = render(null);
    expect(html).toMatch(/<input[^>]*type="file"/);
    expect(html).toContain(`accept="${MEDIA_ACCEPT}"`);
    expect(MEDIA_ACCEPT).toBe("video/*,image/*");
    expect(html).toContain('id="media-file"');
    expect(html).toContain("sr-only");
  });

  it("offers the plain call to action", () => {
    const html = render(null);
    expect(html).toContain("Choose a photo or video");
    expect(html).toContain("or drag it here");
  });

  it("shows the chosen file's name and size", () => {
    const html = render(file("surf.jpg", "image/jpeg", 2048));
    expect(html).toContain("surf.jpg");
    expect(html).toContain("2.0 KB");
  });
});

describe("pickDroppedFile", () => {
  it("takes the first dropped image or video", () => {
    const f = file("a.mp4", "video/mp4");
    expect(pickDroppedFile([f, file("b.png", "image/png")])).toEqual({ file: f });
  });

  it("accepts an iPhone HEIC photo with no type", () => {
    const f = file("IMG_1.HEIC", "");
    expect(pickDroppedFile([f])).toEqual({ file: f });
  });

  it("refuses other types with the same message as the upload", () => {
    expect(pickDroppedFile([file("a.pdf", "application/pdf")])).toEqual({
      error: "Only image or video files can be added to the library.",
    });
  });

  it("ignores an empty drop", () => {
    expect(pickDroppedFile([])).toEqual({});
  });
});

// Review finding: pick A, drop B, pick A again. A filled input fires no change for
// the same file, so B stayed chosen and was uploaded.
describe("takePickedFile", () => {
  it("hands on the picked file and empties the input, so the same file can be picked again", () => {
    const onFile = vi.fn();
    const a = file("a.jpg", "image/jpeg");
    const input = { files: [a], value: "C:\fakepath\a.jpg" };
    takePickedFile(input, onFile);
    expect(onFile).toHaveBeenCalledWith(a);
    expect(input.value).toBe("");
  });

  it("does nothing but empty the input when the picker was cancelled", () => {
    const onFile = vi.fn();
    const input = { files: [] as File[], value: "" };
    takePickedFile(input, onFile);
    expect(onFile).not.toHaveBeenCalled();
    expect(input.value).toBe("");
    takePickedFile({ files: null, value: "" }, onFile);
    expect(onFile).not.toHaveBeenCalled();
  });
});
