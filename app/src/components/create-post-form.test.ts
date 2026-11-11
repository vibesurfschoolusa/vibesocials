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
  FILE_LOST_MESSAGE,
  fileLostBlocksSubmit,
  fileLostNoticeShown,
  fileSubmitBlock,
  hasNoFile,
  isTextPostMode,
  lastPhotoRemovalClearsCaption,
  needsSubmitConfirm,
  nextFileLostNotice,
  nextPreparingPick,
  noFileSubmitError,
  scheduleWhenText,
  platformListAlert,
  repeatCautionNote,
  sharedFileOnItsWay,
  showLocationField,
  submitButtonLabel,
  textOnlyNotice,
  textPostConfirmCopy,
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

describe("showLocationField", () => {
  it("hides Location on a text post, which nothing reads it for, and keeps it with a file", () => {
    expect(showLocationField({ noFile: true })).toBe(false);
    expect(showLocationField({ noFile: false })).toBe(true);
  });
});

// Step 2: a file shared into the Android app (?shared=1) arrives after the page
// opens. Until it has arrived or failed it counts as a file, as a pick being
// prepared does.
describe("a shared file on its way", () => {
  const nothing = { reuseLoading: false, hasReuseItem: false, hasUploadFile: false, photoCount: 0 };
  const notBlocked = { preparingFile: false, preparingPhotos: false, photosNotReady: false };

  it("opened with ?shared=1 and the file not yet taken: not text mode, and sending is blocked", () => {
    const pending = sharedFileOnItsWay("1", false);
    expect(pending).toBe(true);
    expect(isTextPostMode({ ...nothing, sharedFilePending: pending })).toBe(false);
    expect(fileSubmitBlock({ ...notBlocked, sharedFilePending: pending })).toBe(
      "Wait until the shared file has arrived, then press the button again.",
    );
  });

  it("taken and attached: a file post", () => {
    const pending = sharedFileOnItsWay("1", true);
    expect(pending).toBe(false);
    expect(isTextPostMode({ ...nothing, hasUploadFile: true, sharedFilePending: pending })).toBe(false);
    expect(fileSubmitBlock({ ...notBlocked, sharedFilePending: pending })).toBeNull();
  });

  it("the take fails or finds nothing: back to no file, text mode allowed", () => {
    const pending = sharedFileOnItsWay("1", true);
    expect(isTextPostMode({ ...nothing, sharedFilePending: pending })).toBe(true);
    expect(fileSubmitBlock({ ...notBlocked, sharedFilePending: pending })).toBeNull();
  });

  it("opened without ?shared=: unchanged", () => {
    expect(sharedFileOnItsWay(null, false)).toBe(false);
    expect(sharedFileOnItsWay("0", false)).toBe(false);
    expect(isTextPostMode({ ...nothing, sharedFilePending: false })).toBe(true);
  });

  it("isTextPostMode takes the switch value it is given", () => {
    expect(isTextPostMode(nothing, false)).toBe(false);
    expect(isTextPostMode(nothing, true)).toBe(true);
  });
});

// Step 2 review: in text mode the page says plainly that the post has no photo.
describe("the page says a text post has no photo", () => {
  type Platform = Parameters<typeof textOnlyNotice>[0]["connected"][number];

  it("labels: 'without a photo' in text mode, main's labels with a file", () => {
    expect(submitButtonLabel({ mode: "now", noFile: true, loading: false })).toBe("Publish without a photo");
    expect(submitButtonLabel({ mode: "schedule", noFile: true, loading: false })).toBe("Schedule without a photo");
    expect(submitButtonLabel({ mode: "draft", noFile: true, loading: false })).toBe("Save draft without a photo");
    expect(submitButtonLabel({ mode: "now", noFile: false, loading: false })).toBe("Publish post");
    expect(submitButtonLabel({ mode: "schedule", noFile: false, loading: false })).toBe("Schedule post");
    expect(submitButtonLabel({ mode: "draft", noFile: false, loading: false })).toBe("Save draft");
    expect(submitButtonLabel({ mode: "now", noFile: false, loading: true })).toBe("Publishing…");
    expect(submitButtonLabel({ mode: "schedule", noFile: true, loading: true })).toBe("Scheduling…");
    expect(submitButtonLabel({ mode: "draft", noFile: false, loading: true })).toBe("Saving…");
  });

  it("(a) only text platforms selected: one sentence naming them", () => {
    const connected: Platform[] = ["x", "linkedin"];
    expect(textOnlyNotice({ noFile: true, connected, deselected: new Set(), selected: ["x", "linkedin"] })).toBe(
      "This post has no photo or video. It goes to X and LinkedIn as text only.",
    );
  });

  it("(b) text platforms plus Instagram: the second sentence names the skipped one", () => {
    const connected: Platform[] = ["instagram", "facebook_page", "x", "google_business_profile"];
    expect(
      textOnlyNotice({
        noFile: true,
        connected,
        deselected: new Set(),
        selected: ["facebook_page", "x", "google_business_profile"],
      }),
    ).toBe(
      "This post has no photo or video. It goes to Facebook Page, X and Google Business Profile as text only. Instagram needs a photo or video and is skipped.",
    );
    expect(
      textOnlyNotice({
        noFile: true,
        connected: ["instagram", "tiktok", "x"],
        deselected: new Set(),
        selected: ["x"],
      }),
    ).toBe("This post has no photo or video. It goes to X as text only. Instagram and TikTok need a photo or video and are skipped.");
  });

  it("a file-only platform the person unticked is not named as skipped", () => {
    expect(
      textOnlyNotice({ noFile: true, connected: ["instagram", "x"], deselected: new Set<Platform>(["instagram"]), selected: ["x"] }),
    ).toBe("This post has no photo or video. It goes to X as text only.");
  });

  it("(c) only file-only platforms connected: no line (nothing can be sent; the existing message shows on an attempt)", () => {
    expect(textOnlyNotice({ noFile: true, connected: ["instagram", "tiktok"], deselected: new Set(), selected: [] })).toBeNull();
    expect(submitButtonLabel({ mode: "now", noFile: true, loading: false })).toBe("Publish without a photo");
    expect(
      noFileSubmitError({ caption: "hi", selectedCount: 0, allDisabled: true }),
    ).toBe("None of your connected platforms can publish a post without a photo or video. Add a photo or video.");
  });

  it("with a file there is no line", () => {
    expect(textOnlyNotice({ noFile: false, connected: ["x"], deselected: new Set(), selected: ["x"] })).toBeNull();
  });

  it("Publish asks in both kinds, Schedule asks only for a text post, a draft never asks", () => {
    expect(needsSubmitConfirm({ mode: "now", noFile: false })).toBe(true);
    expect(needsSubmitConfirm({ mode: "now", noFile: true })).toBe(true);
    expect(needsSubmitConfirm({ mode: "schedule", noFile: true })).toBe(true);
    expect(needsSubmitConfirm({ mode: "schedule", noFile: false })).toBe(false);
    expect(needsSubmitConfirm({ mode: "draft", noFile: true })).toBe(false);
    expect(needsSubmitConfirm({ mode: "draft", noFile: false })).toBe(false);
  });

  const NOTICE = "This post has no photo or video. It goes to X as text only.";

  it("the Publish confirmation carries the line", () => {
    expect(
      textPostConfirmCopy({ mode: "now", holdsForApproval: false, platforms: ["X"], notice: NOTICE, whenText: null }),
    ).toEqual({
      title: "Publish to 1 platform now?",
      lead: "X",
      notice: NOTICE,
      trail: "This publishes immediately and can't be undone here.",
      confirmText: "Publish without a photo",
    });
  });

  it("the Schedule confirmation carries the line and the time", () => {
    expect(
      textPostConfirmCopy({
        mode: "schedule",
        holdsForApproval: false,
        platforms: ["X", "LinkedIn"],
        notice: NOTICE,
        whenText: "Mon, Dec 1, 9:00 AM",
      }),
    ).toEqual({
      title: "Schedule without a photo?",
      lead: "It publishes Mon, Dec 1, 9:00 AM to X and LinkedIn.",
      notice: NOTICE,
      trail: null,
      confirmText: "Schedule without a photo",
    });
  });

  it("a held member is told the post goes for approval, with the line", () => {
    const copy = textPostConfirmCopy({ mode: "schedule", holdsForApproval: true, platforms: ["X"], notice: NOTICE, whenText: "Mon" });
    expect(copy.title).toBe("Submit for approval?");
    expect(copy.notice).toBe(NOTICE);
    expect(copy.confirmText).toBe("Submit for approval");
  });
});

describe("a file that went away leaves a notice that stays", () => {
  it("each way a file goes away sets the notice", () => {
    for (const reason of ["prepare-failed", "library-failed", "photos-failed"] as const) {
      expect(nextFileLostNotice("none", { type: "lost", reason })).toBe("fresh");
    }
    expect(FILE_LOST_MESSAGE).toBe("The photo or video could not be added. Add it again, or continue without one.");
  });

  it("attaching a file clears it, and so does dismissing it", () => {
    expect(nextFileLostNotice("fresh", { type: "attached" })).toBe("none");
    expect(nextFileLostNotice("seen", { type: "attached" })).toBe("none");
    expect(nextFileLostNotice("fresh", { type: "dismissed" })).toBe("none");
  });

  it("the first press while it shows stops before any dialog; the notice survives the press", () => {
    expect(fileLostBlocksSubmit("fresh")).toBe(true);
    const afterPress = nextFileLostNotice("fresh", { type: "pressed" });
    expect(afterPress).toBe("seen");
    expect(fileLostNoticeShown(afterPress)).toBe(true);
    expect(fileLostBlocksSubmit(afterPress)).toBe(false);
    expect(fileLostBlocksSubmit("none")).toBe(false);
    expect(nextFileLostNotice("none", { type: "pressed" })).toBe("none");
  });
});

describe("removing the last photo", () => {
  it("clears the caption only when it is still the unedited AI caption and no photo is left", () => {
    expect(lastPhotoRemovalClearsCaption({ remaining: 0, caption: "AI wrote this", lastAiCaption: "AI wrote this" })).toBe(true);
    expect(lastPhotoRemovalClearsCaption({ remaining: 0, caption: "I edited it", lastAiCaption: "AI wrote this" })).toBe(false);
    expect(lastPhotoRemovalClearsCaption({ remaining: 1, caption: "AI wrote this", lastAiCaption: "AI wrote this" })).toBe(false);
    expect(lastPhotoRemovalClearsCaption({ remaining: 0, caption: "mine", lastAiCaption: null })).toBe(false);
  });
});

describe("scheduleWhenText", () => {
  it("says the chosen time, or nothing when there is no valid one", () => {
    expect(scheduleWhenText("")).toBeNull();
    expect(scheduleWhenText("2030-12-02T09:00")).toMatch(/2|Dec/);
  });
});
