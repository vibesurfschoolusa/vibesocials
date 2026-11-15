import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob/client", () => ({ upload: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

import { MEDIA_MESSAGES, MediaCard, retentionText, uploadErrorMessage } from "./media-library";

// F1 round 2: Media read "auto-removes in 1 days".
describe("retentionText", () => {
  it("0 days: says soon, as before", () => {
    expect(retentionText(0)).toBe("auto-removes soon");
  });

  it("1 day: singular", () => {
    expect(retentionText(1)).toBe("auto-removes in 1 day");
  });

  it("2 days: plural", () => {
    expect(retentionText(2)).toBe("auto-removes in 2 days");
  });
});

// R5-pages M3: on a phone the card is half the screen wide; the long
// "Use in new post" button pushed Delete out of the card.
describe("MediaCard at phone width", () => {
  const item = {
    id: "m1",
    originalFilename: "a-very-long-file-name-from-the-camera-roll.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 1234,
    baseCaption: "",
    storageLocation: "https://blob.example/a.jpg",
    createdAt: "2026-11-10T10:00:00.000Z",
    lastUsedAt: null,
  };
  const html = renderToStaticMarkup(
    createElement(MediaCard, {
      item,
      onReuse: () => {},
      onDeleteRequest: () => {},
      selected: false,
      canSelect: true,
      onToggleSelect: () => {},
    }),
  );

  it("stacks the two buttons below sm and puts them in a row from sm", () => {
    expect(html).toMatch(/<div class="[^"]*\bflex-col\b[^"]*\bsm:flex-row\b[^"]*"><button/);
  });

  it("lets the Use button shrink and cut its words rather than overflow", () => {
    expect(html).toMatch(/<button[^>]*class="[^"]*\bmin-w-0\b[^"]*"[^>]*>.*<span class="truncate">Use in new post<\/span><\/button>/);
  });

  it("keeps Delete in the card, with its word on a phone and its file in its name", () => {
    expect(html).toMatch(/<button[^>]*aria-label="Delete a-very-long-file-name-from-the-camera-roll.jpg"[^>]*>/);
    expect(html).toMatch(/<span class="sm:sr-only">Delete<\/span>/);
  });
});

// R5-pages L8: what happened and what to do next, never "Unexpected error".
describe("the media library's error sentences", () => {
  const source = readFileSync(fileURLToPath(new URL("./media-library.tsx", import.meta.url)), "utf8");

  it("has no vague sentence left", () => {
    expect(source).not.toMatch(/Unexpected error/);
    expect(source).not.toMatch(/"Failed to /);
    expect(source).not.toMatch(/"Please choose a file/);
  });

  it("says what happened and what to do next", () => {
    for (const text of Object.values(MEDIA_MESSAGES)) {
      expect(text).toMatch(/^Couldn't |^Choose /);
      expect(text.split(". ").length).toBeGreaterThanOrEqual(2);
    }
    expect(MEDIA_MESSAGES.loadNetwork).toBe("Couldn't load your media. Check your connection, then press Retry.");
    expect(MEDIA_MESSAGES.loadMoreNetwork).toBe(
      "Couldn't load more media. Check your connection, then press Load more again.",
    );
    expect(MEDIA_MESSAGES.noFile).toBe("Choose a photo or video first. Then press Upload.");
    expect(MEDIA_MESSAGES.deleteNetwork).toBe("Couldn't delete the file. Check your connection and try again.");
  });

  it("explains a network failure of an upload instead of the browser's words", () => {
    expect(uploadErrorMessage(new TypeError("Failed to fetch"))).toBe(MEDIA_MESSAGES.uploadNetwork);
    expect(uploadErrorMessage(new Error("This workspace's storage is full."))).toBe(
      "This workspace's storage is full.",
    );
    expect(uploadErrorMessage("??")).toBe(MEDIA_MESSAGES.uploadNetwork);
  });
});
