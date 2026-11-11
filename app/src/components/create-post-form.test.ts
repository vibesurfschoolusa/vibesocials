import { afterEach, describe, expect, it, vi } from "vitest";

import { REPEAT_X_NOTE } from "@/lib/repeatSchedule";

// The release switch (platformLimits.ts textPostsEnabled), overridden per test.
const textPosts = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/platformLimits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platformLimits")>()),
  textPostsEnabled: () => textPosts.enabled,
}));

import {
  buildTextPostBody,
  fileSubmitBlock,
  hasNoFile,
  isTextPostMode,
  nextPreparingPick,
  noFileSubmitError,
  platformListAlert,
  repeatCautionNote,
  type PickEvent,
} from "./create-post-form";

// Posts without a photo (2026-11-10): the Create page's pure helpers.
describe("hasNoFile", () => {
  const none = { reuseLoading: false, hasReuseItem: false, hasUploadFile: false, photoCount: 0 };

  it("is true only when nothing is attached and no reused item is loading", () => {
    expect(hasNoFile(none)).toBe(true);
    expect(hasNoFile({ ...none, hasUploadFile: true })).toBe(false);
    expect(hasNoFile({ ...none, hasReuseItem: true })).toBe(false);
    expect(hasNoFile({ ...none, photoCount: 2 })).toBe(false);
    // While a library item loads the page is not yet a text post.
    expect(hasNoFile({ ...none, reuseLoading: true })).toBe(false);
  });
});

describe("noFileSubmitError", () => {
  it("asks for text when there is none", () => {
    expect(noFileSubmitError({ caption: "  ", selectedCount: 1, allDisabled: false })).toBe(
      "Write something to post, or add a photo or video.",
    );
  });

  it("says which platforms can take text when none of the connected ones can", () => {
    expect(noFileSubmitError({ caption: "hi", selectedCount: 0, allDisabled: true })).toBe(
      "None of your connected platforms can publish a post without a photo or video. Add a photo or video.",
    );
  });

  it("asks for a platform when the person unticked them all", () => {
    expect(noFileSubmitError({ caption: "hi", selectedCount: 0, allDisabled: false })).toBe(
      "Select at least one platform to publish to.",
    );
  });

  it("is null for a valid text post", () => {
    expect(noFileSubmitError({ caption: "hi", selectedCount: 2, allDisabled: false })).toBeNull();
  });
});

describe("buildTextPostBody", () => {
  it("sends textOnly with the text and no file fields", () => {
    const body = buildTextPostBody({
      baseCaption: "Lessons cancelled today",
      platforms: ["x", "google_business_profile"],
      deferred: { scheduledFor: "2026-12-01T09:00:00.000Z" },
      workspaceId: "ws-1",
      perPlatformOverrides: { x: "Short", linkedin: "not selected", google_business_profile: "" },
      googleMetadata: { postType: "update", button: { type: "CALL" } },
    });

    expect(body).toEqual({
      textOnly: true,
      baseCaption: "Lessons cancelled today",
      platforms: ["x", "google_business_profile"],
      scheduledFor: "2026-12-01T09:00:00.000Z",
      workspaceId: "ws-1",
      perPlatformOverrides: { x: "Short" },
      googleMetadata: { postType: "update", button: { type: "CALL" } },
    });
    for (const field of ["blobUrl", "mediaItemId", "media", "filename", "mimeType", "sizeBytes", "altText"]) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it("leaves out empty overrides and absent Google options", () => {
    expect(
      buildTextPostBody({ baseCaption: "hi", platforms: ["x"], deferred: { draft: true }, workspaceId: "ws-1" }),
    ).toEqual({ textOnly: true, baseCaption: "hi", platforms: ["x"], draft: true, workspaceId: "ws-1" });
  });
});

// Fix round 1: a single pick that is still being prepared (HEIC conversion,
// shrinking) counts as a file, so the page never sends it as a text post.
describe("a pick being prepared", () => {
  const nothing = { reuseLoading: false, hasReuseItem: false, hasUploadFile: false, photoCount: 0 };

  function run(events: PickEvent[]): number | null {
    return events.reduce<number | null>(nextPreparingPick, null);
  }

  it("pick then submit at once: still a file, and sending is blocked", () => {
    const preparing = run([{ type: "pick", selection: 1 }]);
    expect(preparing).toBe(1);
    expect(hasNoFile({ ...nothing, preparingFile: preparing !== null })).toBe(false);
    expect(fileSubmitBlock({ preparingFile: preparing !== null, preparingPhotos: false, photosNotReady: false })).toBe(
      "Wait until the file is ready, then press the button again.",
    );
  });

  it("pick, wait, submit: the prepared file makes a photo post", () => {
    const preparing = run([{ type: "pick", selection: 1 }, { type: "settled", selection: 1 }]);
    expect(preparing).toBeNull();
    expect(hasNoFile({ ...nothing, hasUploadFile: true, preparingFile: false })).toBe(false);
    expect(fileSubmitBlock({ preparingFile: false, preparingPhotos: false, photosNotReady: false })).toBeNull();
  });

  it("pick, cancel the pick, submit with text: a text post", () => {
    const preparing = run([{ type: "pick", selection: 1 }, { type: "clear" }, { type: "settled", selection: 1 }]);
    expect(preparing).toBeNull();
    expect(hasNoFile({ ...nothing, preparingFile: false })).toBe(true);
  });

  it("a failed preparation goes back to no file", () => {
    // attachPickedFile settles the pick on failure too, before its toast.
    const preparing = run([{ type: "pick", selection: 1 }, { type: "settled", selection: 1 }]);
    expect(hasNoFile({ ...nothing, preparingFile: preparing !== null })).toBe(true);
  });

  it("an older pick settling never ends a newer pick's preparation", () => {
    expect(run([{ type: "pick", selection: 1 }, { type: "pick", selection: 2 }, { type: "settled", selection: 1 }])).toBe(2);
  });

  it("several photos being prepared still block as before", () => {
    expect(fileSubmitBlock({ preparingFile: false, preparingPhotos: true, photosNotReady: false })).not.toBeNull();
    expect(fileSubmitBlock({ preparingFile: false, preparingPhotos: false, photosNotReady: true })).toBe(
      "Wait until every photo has uploaded, or remove the ones that failed.",
    );
  });
});

describe("isTextPostMode follows the release switch", () => {
  const nothing = { reuseLoading: false, hasReuseItem: false, hasUploadFile: false, photoCount: 0 };
  afterEach(() => {
    textPosts.enabled = true;
  });

  it("switched on: no file attached is a text post", () => {
    textPosts.enabled = true;
    expect(isTextPostMode(nothing)).toBe(true);
    expect(isTextPostMode({ ...nothing, hasUploadFile: true })).toBe(false);
  });

  it("switched off: never a text post, so the page is main's (a file is required)", () => {
    textPosts.enabled = false;
    expect(isTextPostMode(nothing)).toBe(false);
    expect(isTextPostMode({ ...nothing, preparingFile: true })).toBe(false);
  });
});

describe("repeatCautionNote", () => {
  const TEXT_NOTE =
    "Platforms may refuse a post whose text is the same as a recent one. Change the text of each repeat in the Queue.";

  it("a repeating text post gets the caution for every platform, in place of the X one", () => {
    expect(repeatCautionNote({ noFile: true, xSelected: true })).toBe(TEXT_NOTE);
    expect(repeatCautionNote({ noFile: true, xSelected: false })).toBe(TEXT_NOTE);
  });

  it("with a file the X caution stays as it is", () => {
    expect(repeatCautionNote({ noFile: false, xSelected: true })).toBe(REPEAT_X_NOTE);
    expect(repeatCautionNote({ noFile: false, xSelected: false })).toBeNull();
  });
});

describe("platformListAlert", () => {
  it("a text post whose connected platforms all need a file says so only once the person tries to send", () => {
    const state = { selectedCount: 0, allDisabled: true, noFile: true };
    expect(platformListAlert({ ...state, triedSend: false })).toBeNull();
    expect(platformListAlert({ ...state, triedSend: true })).toBe(
      "None of your connected platforms can publish a post without a photo or video.",
    );
  });

  it("with a file it shows as before, without waiting for a send", () => {
    expect(platformListAlert({ selectedCount: 0, allDisabled: true, noFile: false, triedSend: false })).toBe(
      "None of your connected platforms can publish this media.",
    );
    expect(platformListAlert({ selectedCount: 0, allDisabled: false, noFile: false, triedSend: false })).toBe(
      "Select at least one platform.",
    );
    expect(platformListAlert({ selectedCount: 1, allDisabled: false, noFile: false, triedSend: true })).toBeNull();
  });
});
