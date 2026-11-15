import { createElement } from "react";
import type { Platform } from "@prisma/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BULK_IMPROVE_FAILED_TEXT } from "./bulkExtras";
import { BulkPostRow } from "./bulk-post-row";
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
    expect(improve).toContain("disabled");
    expect(improve).toMatch(/aria-busy="true"|Improving/);
    expect(textarea(render(row()))).not.toContain("readOnly");
  });

  it("a failure says so in one plain line under the box", () => {
    const html = render(row({ improveError: BULK_IMPROVE_FAILED_TEXT }));
    expect(html).toContain(`<p class="text-sm text-muted-foreground">${BULK_IMPROVE_FAILED_TEXT}</p>`);
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
