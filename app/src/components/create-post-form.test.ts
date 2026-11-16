import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Platform } from "@prisma/client";
import { deriveComposerPlatforms } from "@/lib/postTargets";
import { REPEAT_X_NOTE } from "@/lib/repeatSchedule";

// The release switch (platformLimits.ts textPostsEnabled), overridden per test.
const textPosts = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/platformLimits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platformLimits")>()),
  textPostsEnabled: () => textPosts.enabled,
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildTextPostBody,
  captionsAfterReuseDismissed,
  CreatePostFormSkeleton,
  LibraryFileStatus,
  UntouchedSubmitStatus,
  captionsAfterReuseLoaded,
  NothingConnectedState,
  composerPageState,
  composerPageView,
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
  nextPickJudgment,
  CHOOSE_FILE_MESSAGE,
  LIBRARY_FILE_WAIT_MESSAGE,
  revealRefusal,
  uploadErrorAfterLibraryLoad,
  notSentBanner,
  noFileSubmitError,
  photosFailureLosesFile,
  photoSetTypeKeyOf,
  judgedMimeType,
  scheduleWhenText,
  platformListAlert,
  pressCountsAsTry,
  repeatCautionNote,
  sharedFileOnItsWay,
  submitButtonLabel,
  submitFirstStep,
  textOnlyNotice,
  textPostConfirmCopy,
  type PickEvent,
  UNTOUCHED_SUBMIT_MESSAGE,
  untouchedSubmitMessage,
} from "./create-post-form";

// R22 new-customer L1 (review M1, L4): a photo still being prepared holds the
// picked file, so it is judged by the type it will have once prepared
// (preparedTypeOf), and every photo keeps its place in the numbering.
describe("photoSetTypeKeyOf and judgedMimeType", () => {
  type Status = "preparing" | "waiting" | "uploaded";
  const photo = (name: string, type: string, status: Status, size = 10) => ({
    file: new File([new Uint8Array(size)], name, { type }),
    status,
  });
  const all: Platform[] = ["instagram", "facebook_page", "linkedin", "x", "tiktok", "youtube"];
  const reasons = (photos: ReturnType<typeof photo>[]) => {
    const key = photoSetTypeKeyOf(photos);
    const v = composerPageView({
      pageState: "file",
      connected: all,
      deselected: new Set(),
      mimeType: judgedMimeType(photos, null),
      mimeTypes: key ? key.split(" ") : [],
      mode: "now",
      loading: false,
      triedSend: true,
    });
    return { v, by: Object.fromEntries(v.choices.map((c) => [c.platform, c.disabledReason])) };
  };

  it("4 Windows HEICs being prepared: TikTok and YouTube greyed from the first frame, no false reason for the photo platforms", () => {
    const heics = [1, 2, 3, 4].map((n) => photo(`IMG_${n}.HEIC`, "", "preparing"));
    expect(photoSetTypeKeyOf(heics)).toBe("image/jpeg image/jpeg image/jpeg image/jpeg");
    const { v, by } = reasons(heics);
    expect(by.tiktok).not.toBeNull();
    expect(by.youtube).not.toBeNull();
    expect([by.instagram, by.facebook_page, by.linkedin, by.x]).toEqual([null, null, null, null]);
    expect(v.selected).toEqual(["instagram", "facebook_page", "linkedin", "x"]);
    expect(v.platformAlert).toBeNull();
  });

  it("a big WebP in place 2 being prepared is judged as the JPEG it becomes", () => {
    const set = [photo("a.jpg", "image/jpeg", "uploaded"), photo("b.webp", "image/webp", "preparing", 4_600_000)];
    expect(photoSetTypeKeyOf(set)).toBe("image/jpeg image/jpeg");
    expect(reasons(set).by.facebook_page).toBeNull();
    expect(reasons(set).by.linkedin).toBeNull();
  });

  it("numbers every photo over the whole set, preparing ones included, after a move", () => {
    const heic = photo("IMG_1.HEIC", "", "preparing");
    const jpg = photo("a.jpg", "image/jpeg", "uploaded");
    const webp = photo("small.webp", "image/webp", "preparing");
    expect(reasons([heic, jpg, webp]).by.linkedin).toBe("photo 3 is WebP; JPG or PNG only");
    expect(reasons([webp, heic, jpg]).by.linkedin).toBe("photo 1 is WebP; JPG or PNG only");
  });

  it("a ready photo is judged by its own type; with no set, the single file's", () => {
    expect(photoSetTypeKeyOf([photo("a.png", "image/png", "waiting")])).toBe("image/png");
    expect(judgedMimeType([photo("IMG_1.HEIC", "", "preparing")], null)).toBe("image/jpeg");
    expect(judgedMimeType([], "video/mp4")).toBe("video/mp4");
    expect(judgedMimeType([], null)).toBeNull();
  });
});

// R22 second review: a single pick is judged by the type it will have while
// it prepares, and judged on nothing again once the pick ends.
describe("nextPickJudgment", () => {
  const all: Platform[] = ["instagram", "facebook_page", "linkedin", "x", "tiktok", "youtube"];
  const view = (mimeType: string | null) =>
    Object.fromEntries(
      composerPageView({
        pageState: "file",
        connected: all,
        deselected: new Set(),
        mimeType: judgedMimeType([], mimeType),
        mimeTypes: [],
        mode: "now",
        loading: false,
        triedSend: false,
      }).choices.map((c) => [c.platform, c.disabledReason]),
    );
  const pick = (name: string, type: string, size = 10) => new File([new Uint8Array(size)], name, { type });

  it("one Windows HEIC preparing: TikTok and YouTube greyed from the first frame", () => {
    const judged = nextPickJudgment(null, { type: "pick", selection: 1, file: pick("IMG_1.HEIC", "") });
    expect(judged).toEqual({ selection: 1, mimeType: "image/jpeg" });
    const by = view(judged?.mimeType ?? null);
    expect(by.tiktok).not.toBeNull();
    expect(by.youtube).not.toBeNull();
    expect([by.instagram, by.facebook_page, by.linkedin, by.x]).toEqual([null, null, null, null]);
  });

  it("an 8 MB JPEG preparing is judged as a JPEG", () => {
    expect(nextPickJudgment(null, { type: "pick", selection: 2, file: pick("a.jpg", "image/jpeg", 8_000_000) })?.mimeType).toBe(
      "image/jpeg",
    );
  });

  it("a video pick is judged as the video it stays", () => {
    const judged = nextPickJudgment(null, { type: "pick", selection: 3, file: pick("a.mp4", "video/mp4") });
    expect(view(judged?.mimeType ?? null)).toEqual(view("video/mp4"));
  });

  it("the pick ending (ready or failed) or a clear goes back to no judgment; an older pick settling changes nothing", () => {
    const judged = nextPickJudgment(null, { type: "pick", selection: 4, file: pick("IMG_1.HEIC", "") });
    expect(nextPickJudgment(judged, { type: "settled", selection: 4 })).toBeNull();
    expect(nextPickJudgment(judged, { type: "clear" })).toBeNull();
    expect(nextPickJudgment(judged, { type: "settled", selection: 3 })).toBe(judged);
    expect(view(null)).toEqual(Object.fromEntries(all.map((p) => [p, null])));
  });
});

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

  // R28 new-customer addendum L10: a text post is sent with its main caption
  // (the route refuses one without it), so text written only in a platform's
  // own caption box gets the step that is true: write the Caption.
  it("text only in a platform's own caption: asks for the Caption, not for something to post", () => {
    expect(noFileSubmitError({ caption: " ", ownCaptionWritten: true, selectedCount: 1, allDisabled: false })).toBe(
      "Write your text in the Caption box too. A post without a photo needs it, even when a platform has its own caption.",
    );
    expect(noFileSubmitError({ caption: " ", ownCaptionWritten: false, selectedCount: 1, allDisabled: false })).toBe(
      "Write something to post, or add a photo or video.",
    );
    expect(noFileSubmitError({ caption: "hi", ownCaptionWritten: true, selectedCount: 1, allDisabled: false })).toBeNull();
  });

  it("the press passes whether a platform's own caption has text", () => {
    const raw = readFileSync(new URL("./create-post-form.tsx", import.meta.url), "utf8");
    expect(raw).toMatch(/noFileSubmitError\(\{\s*caption: uploadCaption,\s*ownCaptionWritten: Object\.values\(platformOverrides \?\? \{\}\)\.some\(/);
  });
});

// R28 pages addendum L8: while the connections load, a screen reader hears it.
describe("CreatePostFormSkeleton", () => {
  it("says what is loading in a status line and hides the skeletons", () => {
    const html = renderToStaticMarkup(createElement(CreatePostFormSkeleton, { status: "Loading your connections…" }));
    expect(html).toMatch(/<p class="sr-only">Loading your connections…<\/p>/);
    expect(html).toMatch(/<div[^>]*aria-hidden="true"[^>]*>(?:<div[^>]*><\/div>){4}<\/div>/);
  });

  it("the connections loading branch names the connections", () => {
    const raw = readFileSync(new URL("./create-post-form.tsx", import.meta.url), "utf8");
    expect(raw).toMatch(/if \(composerGate === "loading"\) \{[\s\S]*?<CreatePostFormSkeleton status="Loading your connections…" \/>/);
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

// R20 publishing L1: no platform uses a post's location. YouTube deprecated
// recordingDetails' location fields in 2017 and Instagram never sends a
// location_id, so Create has no Location field to promise otherwise.
describe("no Location field on Create", () => {
  const raw = readFileSync(new URL("./create-post-form.tsx", import.meta.url), "utf8");
  const source = raw.replace(/\s+/g, " ");

  it("renders no Location field, help or place search", () => {
    expect(source).not.toContain('id="post-location"');
    expect(source).not.toContain("LocationAutocomplete");
    expect(source).not.toContain("Pick a place from the list");
    expect(source).not.toMatch(/\buploadLocation\b/);
    expect(source).not.toContain("showLocation");
  });

  it("builds the photo types from photoSetTypeKeyOf", () => {
    expect(source).toContain("const photoSetTypeKey = photoSetTypeKeyOf(photoSet);");
    expect(source).toContain("const judgedType = judgedMimeType(photoSet, activeMimeType ?? pickJudgment?.mimeType ?? null);");
    expect(source).toContain("mimeType: judgedType,");
  });

  it("sends no location in a post's body", () => {
    expect(source).not.toMatch(/location: uploadLocation/);
    expect(raw).not.toMatch(/^\s*location:/m);
  });

  // TikTok's audit: the Create page's TikTok parts are frozen. Every line that
  // names TikTok, and the TikTok settings block, hash as on main 4faccbf.
  it("leaves every TikTok line byte-identical", () => {
    const lines = raw.split("\n").filter((line) => /tiktok/i.test(line));
    expect(lines).toHaveLength(83);
    expect(createHash("sha256").update(lines.join("\n")).digest("hex")).toBe(
      "161ae7727b30994cd3f9dbb41d554034e789f948940a2de60249b368d42edcb9",
    );
    const start = raw.indexOf("{tiktokSelected && activeMimeType && (");
    const block = raw.slice(start, raw.indexOf("\n        )}", start) + 11);
    expect(block).toContain("<TikTokPostSettings");
    expect(createHash("sha256").update(block).digest("hex")).toBe(
      "87d50c1ee4da4b36f1dc08a4dda3b33b26caf48da7db578c5cd94a8c3a459c54",
    );
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

  it("the Schedule confirmation of a repeating text post says how many more follow", () => {
    const base = { mode: "schedule" as const, holdsForApproval: false, platforms: ["X"], notice: NOTICE, whenText: "Mon, Dec 1, 9:00 AM" };
    expect(textPostConfirmCopy({ ...base, repeatCount: 4 }).lead).toBe(
      "It publishes Mon, Dec 1, 9:00 AM to X, then repeats 3 more times.",
    );
    expect(textPostConfirmCopy({ ...base, repeatCount: 2 }).lead).toBe(
      "It publishes Mon, Dec 1, 9:00 AM to X, then repeats 1 more time.",
    );
    // One post, or no repeat given: the sentence is the plain one.
    expect(textPostConfirmCopy({ ...base, repeatCount: 1 }).lead).toBe("It publishes Mon, Dec 1, 9:00 AM to X.");
    expect(textPostConfirmCopy(base).lead).toBe("It publishes Mon, Dec 1, 9:00 AM to X.");
    // A held series says it too.
    expect(textPostConfirmCopy({ ...base, holdsForApproval: true, repeatCount: 3 }).lead).toBe(
      "An owner will review this post before it publishes Mon, Dec 1, 9:00 AM to X, then repeats 2 more times.",
    );
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

  it("the form's own reset clears it, so a new post never starts with an old notice", () => {
    // After a successful submit, "Remove all", removing the last photo, or clearing the pick.
    for (const state of ["none", "fresh", "seen"] as const) {
      expect(nextFileLostNotice(state, { type: "reset" })).toBe("none");
    }
  });

  it("photos that fail to prepare lose a file only when nothing stays attached", () => {
    // Added to photos that stay attached: nothing went away, no notice.
    expect(photosFailureLosesFile({ attachedBefore: 2 })).toBe(false);
    expect(photosFailureLosesFile({ attachedBefore: 1 })).toBe(false);
    // They replaced what was attached: the page is left with no file.
    expect(photosFailureLosesFile({ attachedBefore: 0 })).toBe(true);
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

// Go-live check F2 item 1: a page nobody has touched (no file, no text) is not a
// text post yet. It looks like the page with a file until text is typed.
describe("the untouched Create page", () => {
  type Platform = Parameters<typeof textOnlyNotice>[0]["connected"][number];
  const nothing = { reuseLoading: false, hasReuseItem: false, hasUploadFile: false, photoCount: 0 };
  const connected: Platform[] = ["instagram", "facebook_page", "tiktok", "x", "youtube"];
  const empty = { ...nothing, caption: "", overrides: null, connected, deselected: new Set<Platform>() };
  afterEach(() => {
    textPosts.enabled = true;
  });

  /** What the page shows for a state: the platform list, the notice and the button. */
  function page(state: ReturnType<typeof composerPageState>, deselected: Set<Platform> = new Set()) {
    const textPage = state === "text";
    const { choices, selected } = deriveComposerPlatforms(connected, deselected, null, { noFile: textPage });
    return {
      disabled: choices.filter((c) => c.disabledReason !== null).map((c) => c.platform),
      selected,
      notice: textOnlyNotice({ noFile: textPage, connected, deselected, selected }),
      button: submitButtonLabel({ mode: "now", noFile: textPage, loading: false }),
    };
  }

  it("untouched: every platform selectable and ticked, no notice, the button as with a file", () => {
    expect(composerPageState(empty, true)).toBe("untouched");
    expect(page("untouched")).toEqual({ disabled: [], selected: connected, notice: null, button: "Publish post" });
  });

  it("whitespace alone, in the main or a per-platform caption, is still untouched", () => {
    expect(composerPageState({ ...empty, caption: "  \t " }, true)).toBe("untouched");
    expect(composerPageState({ ...empty, overrides: { x: "   " } }, true)).toBe("untouched");
  });

  it("text typed: today's text post page; cleared again: untouched", () => {
    expect(composerPageState({ ...empty, caption: "Open today" }, true)).toBe("text");
    expect(page("text").disabled).toEqual(["instagram", "tiktok", "youtube"]);
    expect(page("text").button).toBe("Publish without a photo");
    expect(page("text").notice).toContain("This post has no photo or video.");
    expect(composerPageState({ ...empty, caption: "" }, true)).toBe("untouched");
  });

  it("a per-platform caption typed while the main one is empty is text", () => {
    expect(composerPageState({ ...empty, overrides: { x: "Only on X" } }, true)).toBe("text");
  });

  it("a file, with or without text, is the page with a file", () => {
    expect(composerPageState({ ...empty, hasUploadFile: true }, true)).toBe("file");
    expect(composerPageState({ ...empty, hasUploadFile: true, caption: "Hi" }, true)).toBe("file");
    expect(composerPageState({ ...empty, photoCount: 3 }, true)).toBe("file");
    expect(composerPageState({ ...empty, hasReuseItem: true }, true)).toBe("file");
  });

  it("the file removed: text present is a text post, no text is untouched", () => {
    expect(composerPageState({ ...empty, caption: "Hi" }, true)).toBe("text");
    expect(composerPageState(empty, true)).toBe("untouched");
  });

  it("a shared file on its way and a library item loading count as files, as today", () => {
    expect(composerPageState({ ...empty, sharedFilePending: true }, true)).toBe("file");
    expect(composerPageState({ ...empty, reuseLoading: true }, true)).toBe("file");
    expect(composerPageState({ ...empty, preparingFile: true }, true)).toBe("file");
  });

  it("text posts switched off: always the page with a file, exactly today's", () => {
    textPosts.enabled = false;
    expect(composerPageState(empty)).toBe("file");
    expect(composerPageState({ ...empty, caption: "Hi" })).toBe("file");
    expect(composerPageState(empty, false)).toBe("file");
  });

  it("a hand-made selection is kept across untouched, text and file", () => {
    const deselected = new Set<Platform>(["x"]);
    expect(page("untouched", deselected).selected).toEqual(["instagram", "facebook_page", "tiktok", "youtube"]);
    expect(page("text", deselected).selected).toEqual(["facebook_page"]);
    expect(page("untouched", deselected).selected).toEqual(["instagram", "facebook_page", "tiktok", "youtube"]);
  });

  it("a workspace whose platforms all need a file: selectable while untouched, greyed once text is typed", () => {
    const onlyMedia: Platform[] = ["instagram", "tiktok", "youtube"];
    const untouched = deriveComposerPlatforms(onlyMedia, new Set(), null, { noFile: false });
    expect(untouched.selected).toEqual(onlyMedia);
    const text = deriveComposerPlatforms(onlyMedia, new Set(), null, { noFile: true });
    expect(text.selected).toEqual([]);
    expect(platformListAlert({ selectedCount: 0, allDisabled: true, noFile: true, triedSend: false })).toBeNull();
  });

  it("draft and schedule read as with a file while untouched", () => {
    expect(submitButtonLabel({ mode: "schedule", noFile: false, loading: false })).toBe("Schedule post");
    expect(submitButtonLabel({ mode: "draft", noFile: false, loading: false })).toBe("Save draft");
  });

  it("pressing the button while untouched sends nothing and says what to do, by the button", () => {
    expect(UNTOUCHED_SUBMIT_MESSAGE).toBe("Add a photo or video, or write the text of your post.");
    expect(untouchedSubmitMessage({ untouched: true, pressed: true, connected: ["x"] })).toBe(UNTOUCHED_SUBMIT_MESSAGE);
    expect(untouchedSubmitMessage({ untouched: true, pressed: false, connected: ["x"] })).toBeNull();
    // Text typed or a file added: the sentence goes.
    expect(untouchedSubmitMessage({ untouched: false, pressed: true, connected: ["x"] })).toBeNull();
  });

  it("the lost-file notice is unchanged: it is shown while there is no file, text or not", () => {
    const fresh = nextFileLostNotice("none", { type: "lost", reason: "library-failed" });
    expect(composerPageState(empty, true) !== "file" && fileLostNoticeShown(fresh)).toBe(true);
    expect(fileLostBlocksSubmit(fresh)).toBe(true);
  });
});

// F2 fix round 1, item 1: a platform's own caption counts as text only when that
// platform takes a post without a photo. Otherwise typing into Instagram's box
// turned the page into a text post, greyed Instagram out and hid its own box.
describe("composerPageState: own captions for platforms that need a file", () => {
  type Platform = Parameters<typeof textOnlyNotice>[0]["connected"][number];
  const connected: Platform[] = ["instagram", "tiktok", "youtube", "x", "linkedin"];
  const nothing = { reuseLoading: false, hasReuseItem: false, hasUploadFile: false, photoCount: 0, caption: "", connected, deselected: new Set<Platform>() };
  afterEach(() => {
    textPosts.enabled = true;
  });

  function selectedFor(overrides: Partial<Record<Platform, string>>) {
    const state = composerPageState({ ...nothing, overrides }, true);
    return deriveComposerPlatforms(connected, new Set(), null, { noFile: state === "text" }).selected;
  }

  it("own caption for Instagram only: stays untouched, Instagram stays ticked", () => {
    expect(composerPageState({ ...nothing, overrides: { instagram: "a" } }, true)).toBe("untouched");
    expect(selectedFor({ instagram: "a" })).toContain("instagram");
  });

  it("own caption for TikTok only: stays untouched, TikTok stays ticked", () => {
    expect(composerPageState({ ...nothing, overrides: { tiktok: "a" } }, true)).toBe("untouched");
    expect(selectedFor({ tiktok: "a" })).toContain("tiktok");
  });

  it("own caption for YouTube only: stays untouched, YouTube stays ticked", () => {
    expect(composerPageState({ ...nothing, overrides: { youtube: "a" } }, true)).toBe("untouched");
    expect(selectedFor({ youtube: "a" })).toContain("youtube");
  });

  it("own caption for X or LinkedIn only: a text post, as before", () => {
    expect(composerPageState({ ...nothing, overrides: { x: "a" } }, true)).toBe("text");
    expect(composerPageState({ ...nothing, overrides: { linkedin: "a" } }, true)).toBe("text");
  });

  it("both kinds typed: a text post", () => {
    expect(composerPageState({ ...nothing, overrides: { instagram: "a", x: "b" } }, true)).toBe("text");
  });

  it("main caption typed: a text post, as before", () => {
    expect(composerPageState({ ...nothing, caption: "Hi", overrides: null }, true)).toBe("text");
  });

  it("a file attached with any captions: the file page, as before", () => {
    for (const overrides of [{ instagram: "a" }, { x: "b" }, { instagram: "a", x: "b" }]) {
      expect(composerPageState({ ...nothing, hasUploadFile: true, caption: "Hi", overrides }, true)).toBe("file");
    }
  });

  it("Instagram's caption, then the main one: a text post, Instagram's caption kept for a file later", () => {
    const overrides = { instagram: "For the photo" };
    expect(composerPageState({ ...nothing, overrides }, true)).toBe("untouched");
    expect(composerPageState({ ...nothing, caption: "Open today", overrides }, true)).toBe("text");
    expect(overrides).toEqual({ instagram: "For the photo" });
    expect(composerPageState({ ...nothing, caption: "Open today", overrides, hasUploadFile: true }, true)).toBe("file");
  });

  it("text posts switched off: the old page", () => {
    textPosts.enabled = false;
    expect(composerPageState({ ...nothing, overrides: { instagram: "a" } })).toBe("file");
    expect(composerPageState({ ...nothing, overrides: { x: "a" } })).toBe("file");
  });
});

// F2 fix round 1, item 2: where every connected platform needs a file, text can
// go nowhere, so the untouched press asks only for a file and is not a try.
describe("the untouched press where every platform needs a file", () => {
  type Platform = Parameters<typeof textOnlyNotice>[0]["connected"][number];
  const pressed = { untouched: true, pressed: true };

  it("all need a file: the short sentence", () => {
    const connected: Platform[] = ["instagram", "tiktok", "youtube"];
    expect(untouchedSubmitMessage({ ...pressed, connected })).toBe("Add a photo or video.");
  });

  it("all need a file: typing after the press shows no red line until the person presses again", () => {
    expect(pressCountsAsTry("untouched")).toBe(false);
    expect(pressCountsAsTry("text")).toBe(true);
    expect(pressCountsAsTry("file")).toBe(true);
    // The first letter typed: a text post whose platforms all need a file, not yet tried.
    expect(platformListAlert({ selectedCount: 0, allDisabled: true, noFile: true, triedSend: false })).toBeNull();
    // Pressed again, now as a text post: the line shows.
    expect(platformListAlert({ selectedCount: 0, allDisabled: true, noFile: true, triedSend: true })).toBe(
      "None of your connected platforms can publish a post without a photo or video.",
    );
  });

  it("at least one takes text: today's sentence", () => {
    const connected: Platform[] = ["instagram", "x"];
    expect(untouchedSubmitMessage({ ...pressed, connected })).toBe(
      "Add a photo or video, or write the text of your post.",
    );
  });

  it("no platform connected at all: as today", () => {
    expect(untouchedSubmitMessage({ ...pressed, connected: [] })).toBe(
      "Add a photo or video, or write the text of your post.",
    );
  });
});

// F2 fix round 1, item 3: the form takes what it shows (composerPageView) and
// the first decisions of a press (submitFirstStep) from these helpers, fed by
// composerPageState, so the tests below run the form's own chain.
describe("the form's chain: composerPageState, composerPageView, submitFirstStep", () => {
  type Platform = Parameters<typeof textOnlyNotice>[0]["connected"][number];
  const connected: Platform[] = ["instagram", "x", "youtube"];
  const nothing = { reuseLoading: false, hasReuseItem: false, hasUploadFile: false, photoCount: 0, overrides: null, connected, deselected: new Set<Platform>() };

  function view(caption: string, extra: Partial<typeof nothing> = {}, triedSend = false) {
    const pageState = composerPageState({ ...nothing, ...extra, caption }, true);
    return {
      pageState,
      ...composerPageView({
        pageState,
        connected,
        deselected: new Set(),
        mimeType: extra.hasUploadFile ? "image/jpeg" : null,
        mode: "now",
        loading: false,
        triedSend,
      }),
    };
  }

  it("untouched: every platform selectable, no notice, the file page's button", () => {
    const v = view("");
    expect(v.untouched).toBe(true);
    expect(v.noFile).toBe(true);
    expect(v.selected).toEqual(connected);
    expect(v.textNotice).toBeNull();
    expect(v.buttonLabel).toBe("Publish post");
    expect(v.platformAlert).toBeNull();
  });

  it("text: the photo platforms greyed out, the notice and the text post's button", () => {
    const v = view("Open today");
    expect(v.untouched).toBe(false);
    expect(v.selected).toEqual(["x"]);
    expect(v.textNotice).toContain("This post has no photo or video.");
    expect(v.buttonLabel).toBe("Publish without a photo");
  });

  it("file: the file page", () => {
    const v = view("Hi", { hasUploadFile: true });
    expect(v.noFile).toBe(false);
    expect(v.selected).toEqual(["instagram", "x"]);
    expect(v.textNotice).toBeNull();
    expect(v.buttonLabel).toBe("Publish post");
  });

  const go = { fileLost: "none" as const, fileBlock: null };

  it("untouched: the press stops with the sentence and is not a try", () => {
    expect(submitFirstStep({ ...go, pageState: view("").pageState })).toEqual({ stop: "untouched", countsAsTry: false });
  });

  it("text or file: the press goes on and is a try", () => {
    expect(submitFirstStep({ ...go, pageState: view("Hi").pageState })).toEqual({ stop: null, countsAsTry: true });
    expect(submitFirstStep({ ...go, pageState: view("Hi", { hasUploadFile: true }).pageState })).toEqual({
      stop: null,
      countsAsTry: true,
    });
  });

  it("a fresh lost-file notice comes first, before the untouched stop", () => {
    expect(submitFirstStep({ ...go, pageState: "untouched", fileLost: "fresh" })).toEqual({
      stop: "file-lost",
      countsAsTry: false,
    });
    // Seen once: the next press goes on to the untouched stop.
    expect(submitFirstStep({ ...go, pageState: "untouched", fileLost: "seen" })).toEqual({
      stop: "untouched",
      countsAsTry: false,
    });
  });

  it("a file still being prepared or shared stops with its wait sentence", () => {
    const fileBlock = "Wait until the file is ready, then press the button again.";
    expect(submitFirstStep({ ...go, pageState: "file", fileBlock })).toEqual({
      stop: "wait",
      message: fileBlock,
      countsAsTry: true,
    });
  });
});

// F2 fix round 2, item 2: an own caption counts as text only for a platform that
// takes text, is connected and is ticked. X's caption with X unticked kept the
// page a text post with nothing on it to say why.
describe("composerPageState: own captions the person can no longer see", () => {
  type Platform = Parameters<typeof textOnlyNotice>[0]["connected"][number];
  const connected: Platform[] = ["instagram", "x"];
  const base = { reuseLoading: false, hasReuseItem: false, hasUploadFile: false, photoCount: 0, caption: "", connected };
  const ticked = new Set<Platform>();
  const xUnticked = new Set<Platform>(["x"]);

  it("X's own caption with X ticked: a text post, as now", () => {
    expect(composerPageState({ ...base, overrides: { x: "Hi" }, deselected: ticked }, true)).toBe("text");
  });

  it("X unticked: untouched again; X's caption is kept and counts again when X is ticked again", () => {
    const overrides = { x: "Hi" };
    expect(composerPageState({ ...base, overrides, deselected: xUnticked }, true)).toBe("untouched");
    expect(overrides).toEqual({ x: "Hi" });
    expect(composerPageState({ ...base, overrides, deselected: ticked }, true)).toBe("text");
  });

  it("X not connected: its caption does not count", () => {
    expect(composerPageState({ ...base, connected: ["instagram"], overrides: { x: "Hi" }, deselected: ticked }, true)).toBe(
      "untouched",
    );
  });

  it("Instagram's own caption never counts, as now", () => {
    expect(composerPageState({ ...base, overrides: { instagram: "Hi" }, deselected: ticked }, true)).toBe("untouched");
  });

  it("the main caption always counts, whatever is unticked", () => {
    expect(composerPageState({ ...base, caption: "Hi", overrides: null, deselected: new Set<Platform>(["x", "instagram"]) }, true)).toBe(
      "text",
    );
  });

  it("with a file: the file page", () => {
    expect(composerPageState({ ...base, hasUploadFile: true, overrides: { x: "Hi" }, deselected: xUnticked }, true)).toBe("file");
  });
});

// F2 fix round 2, item 3: the Repeat caution behaves as with a file on the
// untouched page, and exactly as before on the text-post and file pages.
describe("composerPageView: the Repeat caution", () => {
  type Platform = Parameters<typeof textOnlyNotice>[0]["connected"][number];
  const connected: Platform[] = ["instagram", "x"];
  const base = {
    reuseLoading: false,
    hasReuseItem: false,
    hasUploadFile: false,
    photoCount: 0,
    caption: "",
    overrides: null,
    connected,
    deselected: new Set<Platform>(),
  };
  const TEXT_NOTE =
    "Platforms may refuse a post whose text is the same as a recent one. Change the text of each repeat in the Queue.";
  afterEach(() => {
    textPosts.enabled = true;
  });

  function view(state: Partial<typeof base>, enabled?: boolean) {
    const s = { ...base, ...state };
    return composerPageView({
      pageState: composerPageState(s, enabled),
      connected,
      deselected: s.deselected,
      mimeType: s.hasUploadFile ? "image/jpeg" : null,
      mode: "schedule",
      loading: false,
      triedSend: false,
    });
  }

  it("untouched: X's note, as with a file, and no Location", () => {
    const v = view({}, true);
    expect(v).not.toHaveProperty("showLocation");
    expect(v.repeatNote).toBe(REPEAT_X_NOTE);
  });

  it("text only: the text-post caution, as now", () => {
    const v = view({ caption: "Open today" }, true);
    expect(v).not.toHaveProperty("showLocation");
    expect(v.repeatNote).toBe(TEXT_NOTE);
  });

  it("with a file: X's note, as now, and no Location", () => {
    const v = view({ caption: "Hi", hasUploadFile: true }, true);
    expect(v).not.toHaveProperty("showLocation");
    expect(v.repeatNote).toBe(REPEAT_X_NOTE);
    // X unticked: no note with a file, as now.
    expect(view({ caption: "Hi", hasUploadFile: true, deselected: new Set<Platform>(["x"]) }, true).repeatNote).toBeNull();
  });

  it("text posts switched off: the old page, X's note", () => {
    textPosts.enabled = false;
    for (const caption of ["", "Hi"]) {
      const v = view({ caption });
      expect(v).not.toHaveProperty("showLocation");
      expect(v.repeatNote).toBe(REPEAT_X_NOTE);
    }
  });
});

// G1 review: a "Post now" whose chosen platforms were not sent says so.
describe("notSentBanner", () => {
  it("every platform dead: a warning instead of the green confirmation", () => {
    const text = "Nothing was sent: Reconnect X in Settings, then use Retry in Activity.";
    expect(notSentBanner({ allFailed: true, text })).toEqual({ kind: "warning", title: "Not posted", text });
  });

  it("one dead, one healthy: the usual confirmation plus a line naming the dead one", () => {
    const text = "Not sent to X: Reconnect X in Settings, then use Retry in Activity.";
    expect(notSentBanner({ allFailed: false, text })).toEqual({ kind: "line", text });
  });

  it("healthy: nothing changes", () => {
    expect(notSentBanner(null)).toBeNull();
  });
});

// R11-client-journey L2: only the owner can connect, so a member is not sent to Settings.
describe("NothingConnectedState", () => {
  it("owner: connect in Settings, with the button", () => {
    const html = renderToStaticMarkup(createElement(NothingConnectedState, { isMember: false }));
    expect(html).toContain("Connect at least one in Settings");
    expect(html).toContain('href="/settings#connections"');
    expect(html).toContain("Go to connections");
  });

  it("member: the owner can connect, no link into Settings", () => {
    const html = renderToStaticMarkup(createElement(NothingConnectedState, { isMember: true }));
    expect(html).toContain("The workspace owner can connect accounts for this workspace.");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("Settings");
  });
});

// R12-pages L2: with no posting times saved, Create's prompt knows a member
// (posting-times-prompt.tsx), and nothing else of the form changed for it.
describe("Create's posting-times prompt", () => {
  it("is the shared prompt, given the viewer's role", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const source = readFileSync(path.join(__dirname, "create-post-form.tsx"), "utf8");
    expect(source).toContain("<SetPostingTimesPrompt isMember={isMember} />");
    expect(source).not.toContain("Set your posting times");
  });
});

// R21 platform-clients M1: the Publish to list judges every photo of a post
// with several, so a WebP second or third greys LinkedIn out as a first does.
describe("composerPageView: several photos", () => {
  type Platform = Parameters<typeof textOnlyNotice>[0]["connected"][number];
  const connected: Platform[] = ["linkedin", "instagram", "google_business_profile"];
  function view(mimeTypes: readonly string[]) {
    return composerPageView({
      pageState: "file",
      connected,
      deselected: new Set<Platform>(),
      mimeType: mimeTypes[0],
      mimeTypes,
      mode: "now",
      loading: false,
      triedSend: false,
    });
  }

  it.each([
    ["first", ["image/webp", "image/jpeg", "image/jpeg"], 1],
    ["middle", ["image/jpeg", "image/webp", "image/jpeg"], 2],
    ["last", ["image/jpeg", "image/jpeg", "image/webp"], 3],
  ] as const)("a WebP %s: LinkedIn is greyed out naming the photo", (_where, types, n) => {
    const v = view(types);
    expect(v.choices.find((c) => c.platform === "linkedin")?.disabledReason).toBe(
      `photo ${n} is WebP; JPG or PNG only`,
    );
    expect(v.selected).toEqual(n === 1 ? ["instagram"] : ["instagram", "google_business_profile"]);
  });

  it("all JPEG: every platform stays chosen", () => {
    expect(view(["image/jpeg", "image/jpeg"]).selected).toEqual(connected);
  });
});

// R24 new-customer L3: both AI caption buttons go through one request helper
// (lib/captionRequest.ts), so neither shows the browser's "Failed to fetch".
describe("the AI caption buttons' requests", () => {
  const raw = readFileSync(new URL("./create-post-form.tsx", import.meta.url), "utf8");
  function body(name: string): string {
    const start = raw.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const end = raw.indexOf("\n  }\n", start);
    return raw.slice(start, end);
  }

  it.each(["handleEnhanceCaption", "runAutoCaptionFromMedia"])("%s uses requestCaption and never shows a raw error", (name) => {
    const handler = body(name);
    expect(handler).toContain("requestCaption(");
    expect(handler).not.toMatch(/\bfetch\(/);
    expect(handler).not.toMatch(/\.message\b/);
  });
});

// R24 JJ2 follow-up: a failed press keeps the form. The post goes through
// sendPostRequest, and the catch only says why and ends the busy state.
describe("the Post button's failure", () => {
  const raw = readFileSync(new URL("./create-post-form.tsx", import.meta.url), "utf8");
  const start = raw.indexOf("async function performSubmit(");
  const submit = raw.slice(start, raw.indexOf("\n  }\n", start));

  it("sends the post through sendPostRequest", () => {
    expect(submit).toContain("await sendPostRequest(");
    expect(submit).not.toMatch(/\bfetch\("\/api\/posts"/);
  });

  it("the catch shows submitErrorText and clears nothing", () => {
    const catchBlock = submit.slice(submit.lastIndexOf("} catch (err: unknown) {"));
    expect(catchBlock.replace(/\s+/g, " ")).toBe(
      "} catch (err: unknown) { // Nothing is cleared: the person's post stays as it was (lib/postSubmitFailure.ts). toast.error(submitErrorText(err, { mode: publishMode, holdsForApproval })); setUploadLoading(false); }",
    );
  });
});

// R24 JJ2 review: the success banner's link follows postDestination, the rule
// the success text and the lost-connection sentence use.
describe("the success banner's link", () => {
  const raw = readFileSync(new URL("./create-post-form.tsx", import.meta.url), "utf8");
  it("reads postDestination", () => {
    expect(raw).toContain('href={postDestination(submittedMode, awaitingApproval) === "activity" ? "/activity" : "/queue"}');
    expect(raw).not.toContain('!awaitingApproval && submittedMode === "now"');
  });
});

// KK4: the "Publishing didn't start" banner says what the toast says, from the
// one rule in composerSubmitOutcome (the usual sentence, or the longer one when
// the route couldn't mark the results failed).
describe("the Publishing didn't start banner", () => {
  const source = readFileSync(new URL("./create-post-form.tsx", import.meta.url), "utf8").replace(/\s+/g, " ");

  it("keeps the dispatch-failed outcome's own sentence and shows it, not a fixed one", () => {
    expect(source).toContain(
      'setDispatchFailed(outcome.kind === "dispatch_failed" ? outcome.toast : null);',
    );
    expect(source).toContain("<p>{dispatchFailed}</p>");
    expect(source).not.toContain("COMPOSER_DISPATCH_FAILED_MESSAGE");
  });
});

// R26 LL3 item 5: the AI buttons keep keyboard focus while busy (Button's
// loading ignores the press), and item 4: the connections line says the
// hook's own sentence, never the browser's.
describe("Create's AI buttons and connections line", () => {
  const source = readFileSync(new URL("./create-post-form.tsx", import.meta.url), "utf8");
  it("Caption from media and Improve caption are loading, not disabled, while busy", () => {
    expect(source).toContain(
      "loading={autoCaptionLoading}\n                disabled={!(photoSet.length > 0 ? photoSet[0].blob : uploadedBlob)}",
    );
    expect(source).toContain("loading={enhancingCaption}\n                disabled={!uploadCaption.trim()}");
  });
  it("the connections line falls back to the hook's sentence", () => {
    expect(source).toContain("{connectionsError ?? CONNECTIONS_FAILED_TEXT}");
  });
});

// R27 pages L12 and L9 (non-TikTok parts of Create).
describe("Create at phone width and its status line", () => {
  const source = readFileSync(new URL("./create-post-form.tsx", import.meta.url), "utf8");

  it("the AI caption buttons' row wraps", () => {
    const at = source.indexOf("Caption from media\n");
    const row = source.slice(source.lastIndexOf("<div", source.lastIndexOf("<Button", at)), at);
    expect(row).toMatch(/<div className="flex flex-wrap items-center gap-2">/);
  });

  // R30 PP2: the form is one of the composer's four views, so its region sits
  // with the library line as the first children of every view (UntouchedSubmitStatus);
  // the visible copy by the button is hidden from screen readers.
  it("the line by the button for an untouched form is a region from the first render", () => {
    expect(renderToStaticMarkup(createElement(UntouchedSubmitStatus, { message: null }))).toBe('<p class="sr-only"></p>');
    expect(renderToStaticMarkup(createElement(UntouchedSubmitStatus, { message: "Add a file" }))).toBe(
      '<p class="sr-only">Add a file</p>',
    );
    expect(source).toContain("const untouchedStatus = <UntouchedSubmitStatus message={untouchedMessage} />;");
    expect(source).toMatch(/<p className="text-sm text-muted-foreground empty:sr-only" aria-hidden>\s*\{untouchedMessage\}\s*<\/p>/);
    expect(source).not.toContain("{untouchedMessage ? (");
  });
});

// R27 MM4 item 8 and review: the connections Retry, and the status line's gap.
describe("Create: connections Retry and the status line", () => {
  const source = readFileSync(new URL("./create-post-form.tsx", import.meta.url), "utf8");

  it("Retry, which the loading skeleton replaces, keeps focus off the page body", () => {
    expect(source).toMatch(
      /<Button\s+ref=\{connectionsRetryRef\}\s+size="sm"\s+variant="outline"\s+onClick=\{\(event\) => \{\s*focusAfterPress\(event\.currentTarget, \(\) => connectionsRetryRef\.current\);\s*reloadConnections\(\);/,
    );
  });

  it("the empty status line takes no room in the row", () => {
    expect(source).toMatch(/<p className="text-sm text-muted-foreground empty:sr-only" aria-hidden>\s*\{untouchedMessage\}/);
  });
});

// R29 publishing L3: "Use a different file instead" clears only the captions
// still the reused item's own; what the person typed stays.
describe("captionsAfterReuseDismissed", () => {
  const item = { baseCaption: "Sunset surf", perPlatformOverrides: { x: "Sunset surf on X", instagram: "IG sunset" } };

  it("untouched: both are cleared", () => {
    expect(captionsAfterReuseDismissed(item, "Sunset surf", { x: "Sunset surf on X", instagram: "IG sunset" })).toEqual({
      caption: "",
      overrides: null,
    });
  });

  it("the caption rewritten and an X caption changed: both stay; the untouched Instagram one goes", () => {
    expect(captionsAfterReuseDismissed(item, "My own words", { x: "My X words", instagram: "IG sunset" })).toEqual({
      caption: "My own words",
      overrides: { x: "My X words" },
    });
  });

  it("a platform caption added that the item didn't have stays", () => {
    expect(
      captionsAfterReuseDismissed({ baseCaption: null, perPlatformOverrides: null }, "", { facebook_page: "New FB text" }),
    ).toEqual({ caption: "", overrides: { facebook_page: "New FB text" } });
  });

  it("the handler uses it", () => {
    const raw = readFileSync(new URL("./create-post-form.tsx", import.meta.url), "utf8");
    const start = raw.indexOf("const handleDismissReuse = useCallback(");
    const body = raw.slice(start, raw.indexOf("}, [", start));
    expect(body).toContain("captionsAfterReuseDismissed(");
    expect(body).not.toContain('setUploadCaption("")');
    expect(body).not.toContain("setPlatformOverrides(null)");
  });
});

// R29 pages L6: while a file from Media loads, a status line says so, on the
// page from the first render (its text changes, the region stays).
describe("LibraryFileStatus", () => {
  it("says the file is loading, and is empty otherwise", () => {
    expect(renderToStaticMarkup(createElement(LibraryFileStatus, { loading: true }))).toBe(
      '<p class="sr-only">Loading the file from your library…</p>',
    );
    expect(renderToStaticMarkup(createElement(LibraryFileStatus, { loading: false }))).toBe(
      '<p class="sr-only"></p>',
    );
  });

  // Review of R29 L6: the region is the first child of every view the
  // composer renders (the connections skeleton, its error, nothing connected,
  // the form), so it stays mounted from the first render; its text is set
  // only on a frame after that render, and empties once the file has loaded.
  const raw = readFileSync(new URL("./create-post-form.tsx", import.meta.url), "utf8").replace(/\s+/g, " ");

  it("is the first child of every view, so it is on the page from the first render", () => {
    expect(raw).toMatch(/if \(composerGate === "loading"\) \{[^}]*?return \( <> \{libraryStatus\} \{untouchedStatus\} <CreatePostFormSkeleton /);
    expect(raw).toContain('if (composerGate === "error") { return ( <> {libraryStatus} {untouchedStatus} <Card className="p-6">');
    expect(raw).toContain('if (composerGate === "connect") { return ( <> {libraryStatus} {untouchedStatus} <NothingConnectedState');
    expect(raw).toContain('return ( <> {libraryStatus} {untouchedStatus} <Card className="p-6"> <form id="create-post-form"');
    expect(raw).not.toContain("<LibraryFileStatus loading={reuseLoading} />");
    expect(raw.match(/<LibraryFileStatus /g)).toHaveLength(1);
  });

  it("gets its text only after it is on the page, and loses it once the file has loaded", () => {
    expect(raw).toContain("const libraryStatus = <LibraryFileStatus loading={libraryStatusReady && reuseLoading} />;");
    expect(raw).toContain(
      "useEffect(() => { const frame = requestAnimationFrame(() => setLibraryStatusReady(true)); return () => cancelAnimationFrame(frame); }, []);",
    );
    expect(raw).toContain("const [libraryStatusReady, setLibraryStatusReady] = useState(false);");
  });
});

// R30 new-customer L1: on a weak signal the caption boxes are editable before
// the ?mediaItemId= item arrives; its captions then replaced what was typed.
// The item's captions now fill only the boxes still as they started (empty),
// the same rule as captionsAfterReuseDismissed.
describe("captionsAfterReuseLoaded", () => {
  const item = { baseCaption: "Sunset surf", perPlatformOverrides: { x: "Sunset surf on X", instagram: "IG sunset" } };

  it("nothing typed: the item's captions fill the boxes", () => {
    expect(captionsAfterReuseLoaded(item, "", null)).toEqual({
      caption: "Sunset surf",
      overrides: { x: "Sunset surf on X", instagram: "IG sunset" },
    });
  });

  it("a caption typed and an X caption typed: both stay; the empty Instagram box gets the item's", () => {
    expect(captionsAfterReuseLoaded(item, "My own words", { x: "My X words" })).toEqual({
      caption: "My own words",
      overrides: { x: "My X words", instagram: "IG sunset" },
    });
  });

  it("an item with no captions erases nothing", () => {
    expect(captionsAfterReuseLoaded({ baseCaption: null, perPlatformOverrides: null }, "Typed", { facebook_page: "FB" })).toEqual({
      caption: "Typed",
      overrides: { facebook_page: "FB" },
    });
    expect(captionsAfterReuseLoaded({ baseCaption: null, perPlatformOverrides: null }, "", null)).toEqual({
      caption: "",
      overrides: null,
    });
  });

  it("the load uses it on the boxes as they are when the item arrives", () => {
    const raw = readFileSync(new URL("./create-post-form.tsx", import.meta.url), "utf8");
    const start = raw.indexOf("const item = data.item;");
    const body = raw.slice(start, raw.indexOf("setReuseLoading(false);", start));
    expect(body).toMatch(/setUploadCaption\(\(current\) => captionsAfterReuseLoaded\(item, current, null\)\.caption\)/);
    expect(body).toMatch(/setPlatformOverrides\(\(current\) => captionsAfterReuseLoaded\(item, "", current\)\.overrides\)/);
    expect(body).not.toContain('setUploadCaption(item.baseCaption ?? "")');
  });
});

// R31 publishing L7: a file still loading from Media is a file on its way. The
// press waits for it, and its arrival takes away a "choose a file" line that a
// press made while it loaded.
describe("a file still loading from Media", () => {
  const notBlocked = { preparingFile: false, preparingPhotos: false, photosNotReady: false };

  it("blocks the press with its own wait sentence", () => {
    expect(LIBRARY_FILE_WAIT_MESSAGE).toBe(
      "Wait until the file from your library has loaded, then press the button again.",
    );
    expect(fileSubmitBlock({ ...notBlocked, reuseLoading: true })).toBe(LIBRARY_FILE_WAIT_MESSAGE);
    expect(fileSubmitBlock({ ...notBlocked, reuseLoading: false })).toBeNull();
  });

  it("the file loaded: a choose-a-file or wait line goes; any other line stays", () => {
    expect(uploadErrorAfterLibraryLoad(CHOOSE_FILE_MESSAGE, "loaded")).toBeNull();
    expect(uploadErrorAfterLibraryLoad(LIBRARY_FILE_WAIT_MESSAGE, "loaded")).toBeNull();
    expect(uploadErrorAfterLibraryLoad("Please enter a caption for this post.", "loaded")).toBe(
      "Please enter a caption for this post.",
    );
    expect(uploadErrorAfterLibraryLoad(null, "loaded")).toBeNull();
  });

  it("the load failed: the wait line goes (nothing is coming); choose a file stays true", () => {
    expect(uploadErrorAfterLibraryLoad(LIBRARY_FILE_WAIT_MESSAGE, "failed")).toBeNull();
    expect(uploadErrorAfterLibraryLoad(CHOOSE_FILE_MESSAGE, "failed")).toBe(CHOOSE_FILE_MESSAGE);
  });

  it("the form passes reuseLoading to both blocks and clears the line when the load ends", () => {
    const raw = readFileSync(new URL("./create-post-form.tsx", import.meta.url), "utf8");
    const submit = raw.slice(raw.indexOf("async function handleUploadSubmit("), raw.indexOf("async function handleEnhanceCaption("));
    expect(submit).toMatch(/preparingFile \|\| sharedPendingNow \|\| reuseLoading\s*\?\s*fileSubmitBlock\(\{[^}]*reuseLoading,/);
    const control = raw.slice(raw.indexOf("const control = submitControl({"), raw.indexOf("return (", raw.indexOf("const control = submitControl({")));
    expect(control).toMatch(/fileBlock: fileSubmitBlock\(\{[^}]*reuseLoading,/);
    const load = raw.slice(raw.indexOf("if (!reuseMediaItemId) return;"), raw.indexOf("}, [reuseMediaItemId, toast]);"));
    expect(load.match(/setUploadError\(\(current\) => uploadErrorAfterLibraryLoad\(current, "failed"\)\)/g)).toHaveLength(2);
    expect(load.match(/setUploadError\(\(current\) => uploadErrorAfterLibraryLoad\(current, "loaded"\)\)/g)).toHaveLength(1);
    expect(submit).toContain("setUploadError(CHOOSE_FILE_MESSAGE)");
  });
});

// R31 pages A1: a refused press said why only at the top of the form, far from
// the button pressed. The line is scrolled into view and takes focus, on every
// refused press (the same sentence twice too), and the phone bar shows it.
describe("a refused press shows its reason where the person is", () => {
  const fakeElement = () => {
    const calls: string[] = [];
    return {
      calls,
      el: {
        scrollIntoView: (options: ScrollIntoViewOptions) => calls.push(`scroll ${options.block} ${options.behavior}`),
        focus: (options: FocusOptions) => calls.push(`focus ${options.preventScroll}`),
      },
    };
  };

  it("revealRefusal scrolls the line into view, then focuses it without a second jump", () => {
    const smooth = fakeElement();
    revealRefusal(smooth.el, false);
    expect(smooth.calls).toEqual(["scroll nearest smooth", "focus true"]);
    const reduced = fakeElement();
    revealRefusal(reduced.el, true);
    expect(reduced.calls).toEqual(["scroll nearest auto", "focus true"]);
    expect(() => revealRefusal(null, false)).not.toThrow();
  });

  it("every press past the first checks is counted, and the count brings the line on the page into view", () => {
    const raw = readFileSync(new URL("./create-post-form.tsx", import.meta.url), "utf8");
    const submit = raw.slice(raw.indexOf("async function handleUploadSubmit("), raw.indexOf("async function handleEnhanceCaption("));
    // Counted with the clear, before any refusal, so the same sentence twice is shown twice.
    expect(submit).toMatch(/setUploadError\(null\);\s*setShowSuccess\(false\);\s*setPressCount\(\(count\) => count \+ 1\);\s*if \(first\.stop === "wait"\)/);
    expect(raw).toMatch(/if \(pressCount === 0\) return;[\s\S]{0,200}revealRefusal\(uploadErrorRef\.current, reduce\);\s*\}, \[pressCount\]\);/);
    expect(raw).toMatch(/<Alert ref=\{uploadErrorRef\} tabIndex=\{-1\} variant="danger" className="scroll-mt-24">\{uploadError\}<\/Alert>/);
  });

  // R31 lead review: the top bar is sticky, see-through and 64px tall (h-16);
  // a line scrolled to the top must stop below it (scroll-mt-24 is 96px).
  it("the error line and the success banners scroll to below the sticky top bar", () => {
    const raw = readFileSync(new URL("./create-post-form.tsx", import.meta.url), "utf8");
    const bar = readFileSync(new URL("./shell/top-bar.tsx", import.meta.url), "utf8");
    expect(bar).toContain("sticky top-0 z-20 flex h-16");
    expect(raw).toContain('<Alert ref={uploadErrorRef} tabIndex={-1} variant="danger" className="scroll-mt-24">');
    const banners = raw.match(/<div ref=\{successRef\}[^>]*>/g) ?? [];
    expect(banners).toHaveLength(3);
    for (const banner of banners) expect(banner).toBe('<div ref={successRef} className="scroll-mt-24">');
  });

  it("the phone bar's reason is the form's line", () => {
    const raw = readFileSync(new URL("./create-post-form.tsx", import.meta.url), "utf8");
    const control = raw.slice(raw.indexOf("const control = submitControl({"), raw.indexOf("return (", raw.indexOf("const control = submitControl({")));
    expect(control).toContain("pageError: uploadError,");
  });
});
