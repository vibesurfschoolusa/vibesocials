import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob/client", () => ({ upload: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

import { MediaFilePicker, MEDIA_ACCEPT, pickDroppedFile } from "./media-library";

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
