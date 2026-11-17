import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob/client", () => ({ upload: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

import { explainUploadFailure, UPLOAD_OFFLINE_MESSAGE } from "@/lib/uploadFailure";

import { NoAnswerError } from "@/lib/requestNoAnswer";

import {
  MEDIA_MESSAGES,
  MediaCard,
  UPLOAD_LINK_MAYBE_MADE_MESSAGE,
  UPLOAD_LINK_MAYBE_OFF_MESSAGE,
  mediaDeleteFailureText,
  retentionText,
  uploadErrorMessage,
} from "./media-library";

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

  // Lead follow-up (R26 pages L6): the thumbnail opens the file in a new tab;
  // it says so over the image, and its name is "Open <file> (opens in a new tab)".
  it("the thumbnail says it opens a new tab, in sight and in its name", () => {
    const thumb = html.slice(html.indexOf('<a href="'), html.indexOf("</a>") + 4);
    expect(thumb).toContain('target="_blank"');
    expect(thumb).not.toContain("aria-label=");
    expect(thumb).toContain('<span class="sr-only">Open a-very-long-file-name-from-the-camera-roll.jpg</span>');
    expect(thumb).toMatch(/<span class="[^"]*absolute[^"]*">\(opens in a new tab\)<\/span><\/a>$/);
  });

  it("keeps Delete in the card, with its word on a phone and its file in its name", () => {
    expect(html).toMatch(/<button[^>]*aria-label="Delete a-very-long-file-name-from-the-camera-roll.jpg"[^>]*>/);
    expect(html).toMatch(/<span class="sm:sr-only">Delete<\/span>/);
  });
});

// Review of M3: two cards side by side at 320-430 px cut "Use in new post".
// The page is px-4 below md, so one column gives a card 288 px wide at 320 px,
// 343 px at 375 px and 398 px at 430 px (264, 319 and 374 px inside its p-3):
// the full-width label (about 150 px with its icon and padding) and Delete fit.
describe("the media grid", () => {
  const source = readFileSync(fileURLToPath(new URL("./media-library.tsx", import.meta.url)), "utf8");

  it("is one column below sm, for the list and for its loading placeholders", () => {
    const grids = source.match(/className="grid grid-cols-[^"]*"/g) ?? [];
    expect(grids).toHaveLength(2);
    for (const grid of grids) {
      expect(grid).toBe('className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"');
    }
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
      // R28 NN2: a lost answer starts with the shared lead-in (lib/answerLost).
      expect(text).toMatch(/^Couldn't |^Choose |^Vibe Socials' answer didn't reach you/);
      expect(text.split(". ").length).toBeGreaterThanOrEqual(2);
    }
    expect(MEDIA_MESSAGES.loadNetwork).toBe("Couldn't load your media. Check your connection, then press Retry.");
    expect(MEDIA_MESSAGES.loadMoreNetwork).toBe(
      "Couldn't load more media. Check your connection, then press Load more again.",
    );
    expect(MEDIA_MESSAGES.noFile).toBe("Choose a photo or video first. Then press Upload.");
  });

  it("explains a network failure of an upload instead of the browser's words", () => {
    expect(uploadErrorMessage(new TypeError("Failed to fetch"))).toBe(MEDIA_MESSAGES.uploadNetwork);
    expect(uploadErrorMessage(new Error("This workspace's storage is full."))).toBe(
      "This workspace's storage is full.",
    );
    expect(uploadErrorMessage("??")).toBe(MEDIA_MESSAGES.uploadNetwork);
  });

  // R24 JJ2 follow-up: offline, the upload's own failure (explained in
  // lib/uploadFailure.ts) and the save's failed fetch read as one sentence.
  it("offline: the upload and the save say the same sentence", async () => {
    const offline = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    const explained = await explainUploadFailure(new TypeError("Failed to fetch"), "ws-1", offline);
    expect(explained.message).toBe(UPLOAD_OFFLINE_MESSAGE);
    expect(uploadErrorMessage(explained)).toBe(MEDIA_MESSAGES.uploadNetwork);
    expect(uploadErrorMessage(new TypeError("Failed to fetch"))).toBe(MEDIA_MESSAGES.uploadNetwork);
    expect(MEDIA_MESSAGES.uploadNetwork).toBe("Couldn't upload the file. Check your connection and try again.");
  });
});

// R27 MM3 (pages L1): the upload link's "Create link" is replaced by the new
// link, so focus fell to the page. It goes to the new Copy button.
describe("Client upload link: focus after Create link", () => {
  it("the press hands focus to the new Copy button", () => {
    const source = readFileSync(fileURLToPath(new URL("./media-library.tsx", import.meta.url)), "utf8");
    const create = source.slice(source.indexOf("async function handleCreate("), source.indexOf("async function copyUrl("));
    expect(create).toMatch(/const pressed = event\?\.currentTarget \?\? null;/);
    expect(create).toMatch(/await makeLink\(\);\s+(\/\/[^\n]*\n\s+)?focusAfterPress\(pressed, \(\) => copyRef\.current\);/);
    expect(source).toMatch(/<Button ref=\{copyRef\} type="button" variant="outline" onClick=\{onCopy\}>/);
    expect(source).toMatch(/copyRef=\{copyRef\}/);
  });
});

// R28 NN2 (client-journey L1, pages L1): Replace and Turn off on the upload
// link, saving an upload and deleting a file may all have gone through when
// the answer is lost. Each says so and where to check.
describe("Media: a lost answer may have gone through", () => {
  const source = readFileSync(fileURLToPath(new URL("./media-library.tsx", import.meta.url)), "utf8");

  it("the upload link's Create, Replace and Turn off say what may have happened", () => {
    expect(UPLOAD_LINK_MAYBE_MADE_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so a new upload link may have been made, which turns any old one off. If your connection dropped, reconnect first. Reload this page and copy the link before you send it.",
    );
    expect(UPLOAD_LINK_MAYBE_OFF_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so the upload link may have been turned off. If your connection dropped, reconnect first. Reload this page to see.",
    );
    expect(source).toMatch(/unreachableText=\{confirm === "replace" \? UPLOAD_LINK_MAYBE_MADE_MESSAGE : UPLOAD_LINK_MAYBE_OFF_MESSAGE\}/);
    expect(source).toMatch(/confirmFailureText\(error, UPLOAD_LINK_MAYBE_MADE_MESSAGE\)/);
  });

  it("a lost answer after the link was made reads the link again, so the panel shows the one that works", () => {
    const panel = source.slice(source.indexOf("function UploadLinkPanel"), source.indexOf("export interface UploadLinkPanelViewProps"));
    expect(panel).toMatch(/const readLink = useCallback\(/);
    expect(panel).toMatch(/catch \(error\) \{\s+if \(isNoAnswer\(error\)\) void readLink\(\);\s+throw error;/);
  });

  it("saving an upload whose answer is lost: it may be in the library", () => {
    expect(uploadErrorMessage(new NoAnswerError(new TypeError("Failed to fetch")))).toBe(MEDIA_MESSAGES.saveLost);
    expect(MEDIA_MESSAGES.saveLost).toBe(
      "Vibe Socials' answer didn't reach you, so the file may have been saved to your library. If your connection dropped, reconnect first. Reload this page to see it before you upload it again.",
    );
    expect(source).toMatch(/await fetchOrNoAnswer\("\/api\/media", \{/);
  });

  // R32 publishing L1: the library's reads name the workspace it was drawn for;
  // the route's refusal sentence is what the page then says.
  it("reads the first page and Load more for the page's workspace", () => {
    expect(source).toContain('fetch(withWorkspaceId("/api/media", workspaceId))');
    expect(source).toContain("fetch(withWorkspaceId(`/api/media?cursor=${encodeURIComponent(nextCursor)}`, workspaceId))");
  });

  it("deleting a file: no answer or an unreadable 5xx may have deleted it", () => {
    expect(MEDIA_MESSAGES.deleteLost).toBe(
      "Vibe Socials' answer didn't reach you, so the file may have been deleted. If your connection dropped, reconnect first. Reload this page to see.",
    );
    expect(mediaDeleteFailureText(502, null)).toBe(MEDIA_MESSAGES.deleteLost);
    expect(mediaDeleteFailureText(409, { error: "It is used by a scheduled post." })).toBe("It is used by a scheduled post.");
    // R31 (lead follow-up): a 404 says the file is gone (never "Not found"), and the list reloads.
    expect(mediaDeleteFailureText(404, null)).toBe("This file no longer exists.");
    expect(mediaDeleteFailureText(404, { error: "Not found" })).toBe("This file no longer exists.");
    expect(mediaDeleteFailureText(400, null)).toBe(MEDIA_MESSAGES.deleteFailed);
    // R42 pages-a L4: the route's own sentence for each status, never text it didn't write.
    const inUse =
      "A post that hasn't gone out yet uses this file. If it's a draft, awaiting approval or scheduled, delete or cancel it in Queue first. If it's pending or in progress, wait until it has finished.";
    expect(mediaDeleteFailureText(409, { error: inUse, code: "MEDIA_IN_USE" })).toBe(inUse);
    const nothingChanged = "Couldn't delete the file. Try again in a moment.";
    expect(mediaDeleteFailureText(500, { error: nothingChanged, code: "MEDIA_DELETE_FAILED" })).toBe(nothingChanged);
    // A 5xx the route didn't write (a gateway's JSON, or HTML read as null) may come after the delete.
    expect(mediaDeleteFailureText(504, { error: "FUNCTION_INVOCATION_TIMEOUT" })).toBe(MEDIA_MESSAGES.deleteLost);
    expect(mediaDeleteFailureText(500, null)).toBe(MEDIA_MESSAGES.deleteLost);
    const remove = source.slice(source.indexOf("const handleConfirmDelete"), source.indexOf("return (", source.indexOf("const handleConfirmDelete")));
    // R31 pages L2: with the workspace the library was drawn for (a DELETE has no body).
    expect(remove).toMatch(/await fetchOrNoAnswer\(withWorkspaceId\(`\/api\/media\/\$\{target\.id\}`, workspaceId\), \{ method: "DELETE" \}\)/);
    expect(remove).toMatch(/toast\.error\(MEDIA_MESSAGES\.deleteLost\)/);
    // R32 pages L2: a file already gone leaves the list and the Add many choice, as a delete does; no reload.
    expect(remove).toMatch(/if \(response\.status === 404\) \{\s+(\/\/[^\n]*\n\s+)*forgetItem\(target\.id\);\s+return;\s+\}/);
    expect(remove).not.toContain("fetchItems");
    expect(remove.match(/forgetItem\(target\.id\)/g)).toHaveLength(2);
    const forget = source.slice(source.indexOf("const forgetItem"), source.indexOf("const handleConfirmDelete"));
    expect(forget).toMatch(/setItems\(\(prev\) => removeMediaItem\(prev, id\)\)/);
    expect(forget).toMatch(/next\.delete\(id\)/);
  });
});
