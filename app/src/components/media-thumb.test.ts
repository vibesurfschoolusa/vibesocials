import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MediaThumb, mediaCountBadge } from "./media-thumb";

const photo = { url: "https://abc.public.blob.vercel-storage.com/p.jpg", mimeType: "image/jpeg" };
const render = (count?: number) => renderToStaticMarkup(createElement(MediaThumb, { media: photo, count }));

describe("mediaCountBadge", () => {
  it("shows no badge for one file or an unknown count", () => {
    expect(mediaCountBadge(undefined)).toBeNull();
    expect(mediaCountBadge(0)).toBeNull();
    expect(mediaCountBadge(1)).toBeNull();
  });

  it("shows the number from 2 files up", () => {
    expect(mediaCountBadge(2)).toBe("2");
    expect(mediaCountBadge(10)).toBe("10");
  });
});

describe("MediaThumb", () => {
  it("renders exactly as before without a count or with a count of 1", () => {
    const plain = render();
    // React 19's static markup puts a preload <link> before an <img>.
    expect(plain.replace(/^<link[^>]*>/, "")).toBe(
      `<img src="${photo.url}" alt="" class="h-12 w-12 shrink-0 rounded-[var(--radius)] border border-border object-cover"/>`,
    );
    expect(render(1)).toBe(plain);
  });

  it("adds a badge with the number for several photos", () => {
    const html = render(5);
    expect(html).toContain(`src="${photo.url}"`);
    expect(html).toContain(">5</span>");
    expect(html).toContain('aria-label="5 photos"');
  });

  it("renders nothing without media", () => {
    expect(renderToStaticMarkup(createElement(MediaThumb, { media: null, count: 3 }))).toBe("");
  });
});
