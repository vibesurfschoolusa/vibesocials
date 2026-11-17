import { readFileSync } from "node:fs";

import { createElement } from "react";
import type { Platform } from "@prisma/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BULK_IMPROVE_FAILED_TEXT } from "./bulkExtras";
import { BulkPostRow, captionLocked } from "./bulk-post-row";
import type { BulkRow } from "./bulk-posts-form";

const noop = () => {};

function row(overrides: Partial<BulkRow> = {}): BulkRow {
  return {
    id: "r1",
    fileName: "a.jpg",
    mimeType: "image/jpeg",
    upload: "done",
    progress: null,
    uploadError: null,
    blob: { url: "https://blob.example/a.jpg", filename: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10 },
    mediaItemId: null,
    caption: "Sunny day",
    captionStatus: "done",
    captionOverwrite: false,
    captionError: null,
    improving: false,
    improveError: null,
    altText: "",
    altTextAsked: false,
    altTextWriting: false,
    altTextError: null,
    durationSec: undefined,
    cover: { kind: "default" },
    when: "",
    whenSetByHand: false,
    postId: null,
    uncertain: false,
    uncertainMode: null,
    sending: false,
    result: null,
    sendError: null,
    thumbnail: null,
    ...overrides,
  };
}

function render(
  r: BulkRow,
  extra: {
    storyRefusal?: string | null;
    sendLine?: string | null;
    coverOpen?: boolean;
    locked?: boolean;
    aiCaptions?: boolean;
    skipped?: Platform[];
  } = {},
) {
  return renderToStaticMarkup(
    createElement(BulkPostRow, {
      row: r,
      index: 0,
      count: 1,
      skipped: extra.skipped ?? [],
      locked: extra.locked ?? false,
      minWhen: "2026-11-14T10:00",
      storyRefusal: extra.storyRefusal ?? null,
      sendLine: extra.sendLine ?? null,
      coverOpen: extra.coverOpen ?? false,
      ...(extra.aiCaptions === undefined ? {} : { aiCaptions: extra.aiCaptions }),
      onConfirmInQueue: noop,
      onSendAgain: noop,
      onCaptionChange: noop,
      onAltTextChange: noop,
      onWhenChange: noop,
      onMove: noop,
      onRemove: noop,
      onRetry: noop,
      onWriteAgain: noop,
      onImprove: noop,
      onWriteDescription: noop,
      onCoverOpenChange: noop,
      onCoverChange: noop,
    }),
  );
}

const textarea = (html: string) => html.match(/<textarea[^>]*>/)![0];

describe("Add many row: Improve", () => {
  it("shows Improve beside Write again when the row is editable and has a caption", () => {
    const html = render(row());
    expect(html).toContain(">Write again<");
    expect(html).toContain(">Improve caption<");
  });

  it("no Improve without a caption, or while the row is locked", () => {
    expect(render(row({ caption: "  " }))).not.toContain(">Improve caption<");
    expect(render(row(), { locked: true })).not.toContain(">Improve caption<");
  });

  it("while improving: the button is busy and the caption box is read-only", () => {
    const html = render(row({ improving: true }));
    expect(textarea(html)).toContain("readOnly");
    const improve = html.match(/<button[^>]*>(?:(?!<\/button>).)*Improv(?:(?!<\/button>).)*<\/button>/)![0];
    // A loading Button keeps focus: aria-disabled, not the real attribute (R25 pages L6).
    expect(improve).toContain('aria-disabled="true"');
    expect(improve).not.toMatch(/\sdisabled=""/);
    expect(improve).toMatch(/aria-busy="true"|Improving/);
    expect(textarea(render(row()))).not.toContain("readOnly");
  });

  it("a failure says so in one plain line under the box, in the caption's live region", () => {
    const html = render(row({ improveError: BULK_IMPROVE_FAILED_TEXT }));
    expect(html).toMatch(new RegExp(`<p role="status" id="bulk-row-r1-caption-status" class="[^"]*">${BULK_IMPROVE_FAILED_TEXT}</p>`));
    expect(html.split(BULK_IMPROVE_FAILED_TEXT)).toHaveLength(2);
    expect(html).toContain("Sunny day");
  });
});

describe("Add many row: photo description", () => {
  it("a photo row has the field, with what the AI wrote", () => {
    const html = render(row({ altText: "A surfer on a wave" }));
    expect(html).toContain("Photo description (alt text)");
    expect(html).toContain('value="A surfer on a wave"');
  });

  // P1 fix 1: a Media photo is described only when the user asks.
  it("a Media photo: an empty field and a Write it for me button", () => {
    const html = render(row({ mediaItemId: "media_1" }));
    expect(html).toContain("Photo description (alt text)");
    expect(html).toMatch(/<input[^>]*id="bulk-alt-r1"[^>]*value=""/);
    expect(html).toContain("Write it for me");
  });

  it("a photo from the computer is described automatically: no button", () => {
    expect(render(row())).not.toContain("Write it for me");
  });

  it("a failed Write it for me says why under the field", () => {
    const html = render(row({ mediaItemId: "media_1", altTextError: "The AI couldn't describe this photo." }));
    // React escapes the apostrophe.
    expect(html).toContain("The AI couldn&#x27;t describe this photo.");
  });

  it("a video row has none", () => {
    const html = render(row({ mimeType: "video/mp4", fileName: "v.mp4" }));
    expect(html).not.toContain("Photo description (alt text)");
  });
});

describe("Add many row: video cover", () => {
  const video = () =>
    row({
      mimeType: "video/mp4",
      fileName: "v.mp4",
      blob: { url: "https://blob.example/v.mp4", filename: "v.mp4", mimeType: "video/mp4", sizeBytes: 20 },
      durationSec: 12,
    });

  it("a video row says its cover, platform default by default", () => {
    const html = render(video());
    expect(html).toContain("Cover: Platform default");
    expect(html).not.toContain('name="video-cover"');
  });

  it("open, it shows Create's cover picker", () => {
    const html = render(video(), { coverOpen: true });
    expect(html).toContain('name="video-cover"');
    expect(html).toContain("Platform default");
  });

  it("a photo row has no cover", () => {
    expect(render(row())).not.toContain("Cover:");
  });
});

describe("Add many row: a Story it cannot be", () => {
  it("says why on the row before anything is sent", () => {
    const html = render(row({ mimeType: "video/mp4" }), {
      storyRefusal: "Instagram Stories take videos up to 60 seconds. This one is 75 seconds.",
    });
    expect(html).toContain("Instagram Stories take videos up to 60 seconds. This one is 75 seconds.");
  });
});

// F7 (R1 M2): with "Write captions with AI" off, the row starts with an empty
// box and offers nothing that would send its file to the AI.
describe("Add many row: Write captions with AI off", () => {
  it("shows an empty caption box, no Write again", () => {
    const html = render(row({ caption: "" }), { aiCaptions: false });
    expect(html).toMatch(/<textarea[^>]*placeholder="Write a caption"[^>]*><\/textarea>/);
    expect(html).not.toContain(">Write again<");
  });

  it("still offers Improve once the person has written a caption", () => {
    expect(render(row({ caption: "Typed" }), { aiCaptions: false })).toContain(">Improve caption<");
  });

  it("on (the default) keeps Write again", () => {
    expect(render(row())).toContain(">Write again<");
    expect(render(row(), { aiCaptions: true })).toContain(">Write again<");
  });
});

// Review point 1: with the switch off, a Media photo offers no "Write it for me" either.
describe("Add many row: Media photo description with AI off", () => {
  it("hides Write it for me when the switch is off", () => {
    expect(render(row({ mediaItemId: "m1" }), { aiCaptions: false })).not.toContain(">Write it for me<");
  });

  it("shows it when the switch is on", () => {
    expect(render(row({ mediaItemId: "m1" }))).toContain(">Write it for me<");
  });
});

// R17 CC2 review: the skip line named no reason ("they do not take this kind
// of file"), though Instagram does take video; it now says what each takes.
describe("Add many row: platforms skipped for this file", () => {
  it("names the formats a platform takes when it refuses this one", () => {
    const html = render(row({ fileName: "a.webm", mimeType: "video/webm" }), { skipped: ["instagram"] });
    expect(html).toContain("Skips Instagram (MP4 or MOV only) for this file.");
    expect(html).not.toContain("do not take this kind of file");
  });

  it("names the kind a platform takes when it takes no such file", () => {
    const html = render(row(), { skipped: ["youtube", "tiktok"] });
    expect(html).toContain("Skips YouTube (video only), TikTok (video only) for this file.");
  });

  it("says nothing when no platform is skipped", () => {
    expect(render(row())).not.toContain("Skips ");
  });
});

// R27 pages L9: the row's send line is a status region from the first render;
// only its text changes, so "Sending..." and the result are announced.
describe("Add many row: the send status line", () => {
  it("is on the page before anything is sent, empty", () => {
    const html = render(row());
    expect(html).toMatch(/<div role="status" id="bulk-row-r1-send" class="empty:sr-only"><\/div>/);
  });

  it("the same region carries Sending... and then the result", () => {
    expect(render(row({ sending: true }))).toMatch(/<div role="status" id="bulk-row-r1-send"[^>]*><p[^>]*>Sending\.\.\.<\/p>/);
    const done = render(row({ result: "Scheduled for Sat 14 Nov, 10:00." }));
    expect(done).toMatch(/<div role="status" id="bulk-row-r1-send"[^>]*><div[^>]*>[\s\S]*Scheduled for Sat 14 Nov, 10:00\./);
    // The result box inside is not a second live region.
    expect(done).not.toMatch(/<div role="status" class="flex gap-3/);
  });
});

// R27 MM4 item 8: Write again removes its own button; focus goes to the caption
// box and the row says it is writing.
describe("Add many row: Write again", () => {
  const source = readFileSync(new URL("./bulk-post-row.tsx", import.meta.url), "utf8");

  it("focuses the caption box after the press", () => {
    expect(source).toMatch(/onClick=\{\(event\) => \{\s*focusAfterPress\(event\.currentTarget, \(\) => captionRef\.current\);\s*onWriteAgain\(\);/);
    expect(source).toMatch(/<Textarea\s+ref=\{captionRef\}\s+id=\{captionId\}/);
  });

  it("a status line under the caption, there from the first render, says a new caption is being written", () => {
    const idle = render(row());
    expect(idle).toMatch(/<p role="status" id="bulk-row-r1-caption-status" class="[^"]*empty:sr-only[^"]*"><\/p>/);
    for (const captionStatus of ["waiting", "writing"] as const) {
      expect(render(row({ captionStatus, captionOverwrite: true }))).toMatch(
        /<p role="status" id="bulk-row-r1-caption-status" class="[^"]*">Writing a new caption\.\.\.<\/p>/,
      );
    }
    expect(render(row({ captionStatus: "done", captionOverwrite: true }))).toMatch(/id="bulk-row-r1-caption-status" class="[^"]*"><\/p>/);
  });
});

// R27 MM4 review (medium): after Write again focus is in the caption box, and
// the new caption replaces the text when it comes. So while it is written the
// box is read-only (still focusable, as on Reviews) and the row says why;
// typing then changes nothing, so nothing typed can be lost.
describe("Add many row: the caption box during Write again", () => {
  const rewriting = row({ captionStatus: "writing", captionOverwrite: true, caption: "Old caption" });

  it("is read-only and says so, while staying focusable (not disabled)", () => {
    const box = textarea(render(rewriting));
    expect(box).toMatch(/readOnly=""/);
    expect(box).toContain('aria-readonly="true"');
    expect(box).not.toMatch(/\sdisabled=""/);
    expect(render(rewriting)).toContain("Writing a new caption...");
  });

  it("drops a change while a new caption is written; accepts it otherwise", () => {
    expect(captionLocked(rewriting)).toBe(true);
    expect(captionLocked(row({ captionStatus: "waiting", captionOverwrite: true }))).toBe(true);
    expect(captionLocked(row({ improving: true }))).toBe(true);
    expect(captionLocked(row())).toBe(false);
    // The AI failed: the old text stays and the box unlocks.
    const failed = row({ captionStatus: "failed", captionOverwrite: false, caption: "Old caption" });
    expect(captionLocked(failed)).toBe(false);
    expect(textarea(render(failed))).not.toContain("readOnly");
  });

  it("the row and the form both go through captionLocked", () => {
    const rowSource = readFileSync(new URL("./bulk-post-row.tsx", import.meta.url), "utf8");
    const formSource = readFileSync(new URL("./bulk-posts-form.tsx", import.meta.url), "utf8");
    expect(rowSource).toMatch(/readOnly=\{locked \|\| captionIsLocked\}|readOnly=\{captionIsLocked\}/);
    expect(rowSource).toMatch(/onChange=\{\(event\) => \{\s*if \(!captionIsLocked\) onCaptionChange\(event\.target\.value\);/);
    expect(formSource).toMatch(/onCaptionChange=\{\(caption\) => \{\s*if \(captionLocked\(row\)\) return;/);
  });
});

// R33 pages L7: the row's send line is the one the form passes (rowSendLine), never a stored refusal.
describe("BulkPostRow send line", () => {
  it("shows the line it is given, and none without one", () => {
    expect(render(row({ sendError: "The server said no." }), { sendLine: "Pick a time in the future." })).toContain("Pick a time in the future.");
    expect(render(row({ sendError: "The server said no." }))).not.toContain("The server said no.");
  });
});

// R43 publishing-flow L1: a draft is saved without a time, so its row shows none.
describe("Add many row: a created draft", () => {
  it("says it has no time yet, in place of the date", () => {
    const html = render(row({ postId: "job-d", when: "", result: "Saved as a draft." }));
    expect(html).toContain("No time yet: set it in the Queue");
    expect(html).not.toContain('type="datetime-local"');
  });

  it("a scheduled row keeps its date", () => {
    const html = render(row({ postId: "job-1", when: "2026-11-18T18:00" }));
    expect(html).toContain('value="2026-11-18T18:00"');
    expect(html).not.toContain("No time yet");
  });

  it("the form clears a created draft's time through createdRowWhen", () => {
    const formSource = readFileSync(new URL("./bulk-posts-form.tsx", import.meta.url), "utf8");
    expect(formSource).toMatch(/postId: result\.postId,\s*when: createdRowWhen\(mode, row\.when\),/);
  });
});

// R43 pages-a L4: a caption failure was a plain line, silent for a screen
// reader. Both failures now go in the caption's one status line, which is on
// the page from the first render, so each is announced once.
describe("Add many row: caption failures are announced", () => {
  const WRITE_FAILED = "No caption was written. Write one yourself, or ask again.";

  it("a Write again failure is in the status line, once", () => {
    const html = render(row({ captionStatus: "failed", captionError: WRITE_FAILED }));
    expect(html).toMatch(new RegExp(`<p role="status" id="bulk-row-r1-caption-status" class="[^"]*">${WRITE_FAILED}</p>`));
    expect(html.split(WRITE_FAILED)).toHaveLength(2);
  });

  it("both failures share the one line", () => {
    const html = render(row({ captionStatus: "failed", captionError: WRITE_FAILED, improveError: BULK_IMPROVE_FAILED_TEXT }));
    expect(html).toMatch(
      new RegExp(`<p role="status" id="bulk-row-r1-caption-status" class="[^"]*">${WRITE_FAILED} ${BULK_IMPROVE_FAILED_TEXT}</p>`),
    );
    expect(html.match(/role="status" id="bulk-row-r1-caption/g)).toHaveLength(1);
  });

  it("a new request clears the line: Write again and Improve both empty both failures when they start", () => {
    const formSource = readFileSync(new URL("./bulk-posts-form.tsx", import.meta.url), "utf8");
    expect(formSource).toMatch(/updateRow\(id, \{ improving: true, captionError: null, improveError: null, sendError: null \}\)/);
    expect(formSource).toMatch(/updateRow\(id, \{ captionStatus: "waiting", captionOverwrite: true, captionError: null, improveError: null \}\)/);
    // Once cleared, the line is empty even though the row's caption status is still "failed".
    expect(render(row({ captionStatus: "failed", captionError: null, improving: true }))).toMatch(
      /id="bulk-row-r1-caption-status" class="[^"]*"><\/p>/,
    );
  });
});

// R43 review: the form remembers which button a no-answer send came from, and
// "It is in the Queue" goes through confirmedInQueue with it.
describe("Add many form: It is in the Queue", () => {
  const formSource = readFileSync(new URL("./bulk-posts-form.tsx", import.meta.url), "utf8");

  it("the no-answer branch stores the pressed mode, and markInQueue uses it", () => {
    expect(formSource).toContain("updateRow(id, { sending: false, uncertain: true, uncertainMode: mode });");
    expect(formSource).toMatch(/function markInQueue\(id: string\) \{\s*updateRow\(id, \(row\) => \(\{ \.\.\.confirmedInQueue\(row\), result: "In the Queue" \}\)\);/);
  });

  it("a draft confirmed in the Queue shows no time", () => {
    const html = render(row({ postId: "confirmed-in-queue", when: "", result: "In the Queue" }));
    expect(html).toContain("No time yet: set it in the Queue");
  });
});
