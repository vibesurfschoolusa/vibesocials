import { describe, expect, it, vi } from "vitest";

import { storyVideoLengthRefusal } from "@/lib/storyPlacement";

import {
  BULK_COVER_FAILED_TEXT,
  BULK_IMPROVE_FAILED_TEXT,
  BULK_IMPROVE_LOST_TEXT,
  autoCaptionRequestBody,
  coverUploadFailedText,
  buildBulkRowBody,
  bulkExtrasBlock,
  bulkGoogleMetadataError,
  bulkRowResultText,
  bulkStoryChoice,
  AI_CAPTIONS_STORAGE_KEY,
  captionThenDescribe,
  describePhotoOnce,
  readAiCaptionsChoice,
  saveAiCaptionsChoice,
  improveFailedText,
  initialBulkGoogleMetadata,
  requestImprovedCaption,
  rowStoryRefusal,
  siblingCaptions,
  wantsAltText,
  type BulkBodyRow,
  automaticRequestMayGo,
  rowAiRequests,
} from "./bulkExtras";

const BLOB = { url: "https://blob.example/a.jpg", filename: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10 };
const VIDEO_BLOB = { url: "https://blob.example/v.mp4", filename: "v.mp4", mimeType: "video/mp4", sizeBytes: 20 };

function photoRow(overrides: Partial<BulkBodyRow> = {}): BulkBodyRow {
  return { mimeType: "image/jpeg", blob: BLOB, mediaItemId: null, caption: "Sunny day", altText: "", ...overrides };
}
function videoRow(overrides: Partial<BulkBodyRow> = {}): BulkBodyRow {
  return { mimeType: "video/mp4", blob: VIDEO_BLOB, mediaItemId: null, caption: "Waves", altText: "", ...overrides };
}

const BASE = {
  deferred: { draft: true },
  workspaceId: "ws_1",
  youtubePrivacy: "unlisted" as const,
  googleMetadata: { postType: "update" as const, button: { type: "BOOK" as const, url: "https://example.com" } },
  stories: { instagram: false, facebook: false },
  coverFields: {},
};

describe("Add many: the body for one row", () => {
  for (const reuse of [false, true]) {
    const label = reuse ? "Media reuse body" : "upload body";
    const asRow = (row: BulkBodyRow) => (reuse ? { ...row, mediaItemId: "media_1" } : row);

    // R20 publishing L1: no platform uses a location, so no row sends one,
    // and the builder no longer names the field at all.
    it(`${label}: no location field`, () => {
      const body = buildBulkRowBody({ ...BASE, row: asRow(photoRow()), platforms: ["instagram", "youtube"] });
      expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty("location");
      expect("location" in body).toBe(false);
      expect(reuse ? "mediaItemId" in body : "blobUrl" in body).toBe(true);
    });

    it(`${label}: googleMetadata only for a photo when Google is chosen`, () => {
      const google = buildBulkRowBody({ ...BASE, row: asRow(photoRow()), platforms: ["google_business_profile"] });
      expect(google.googleMetadata).toEqual(BASE.googleMetadata);
      const noGoogle = buildBulkRowBody({ ...BASE, row: asRow(photoRow()), platforms: ["instagram"] });
      expect("googleMetadata" in noGoogle).toBe(false);
      // A video goes to Google's gallery: Create sends no post options for it.
      const video = buildBulkRowBody({ ...BASE, row: asRow(videoRow()), platforms: ["google_business_profile"] });
      expect("googleMetadata" in video).toBe(false);
    });

    it(`${label}: story placement only for Instagram / Facebook when chosen and the row goes there`, () => {
      const both = buildBulkRowBody({
        ...BASE,
        row: asRow(photoRow()),
        platforms: ["instagram", "facebook_page"],
        stories: { instagram: true, facebook: true },
      });
      expect(both.instagramMetadata).toEqual({ placement: "story" });
      expect(both.facebookMetadata).toEqual({ placement: "story" });
      const feed = buildBulkRowBody({ ...BASE, row: asRow(photoRow()), platforms: ["instagram", "facebook_page"] });
      expect("instagramMetadata" in feed).toBe(false);
      expect("facebookMetadata" in feed).toBe(false);
      // Story chosen, but this row does not go to Instagram.
      const notThere = buildBulkRowBody({
        ...BASE,
        row: asRow(photoRow()),
        platforms: ["facebook_page"],
        stories: { instagram: true, facebook: false },
      });
      expect("instagramMetadata" in notThere).toBe(false);
    });

    it(`${label}: alt text for a photo row only, cleaned`, () => {
      const photo = buildBulkRowBody({ ...BASE, row: asRow(photoRow({ altText: " A surfer\non a wave " })), platforms: ["instagram"] });
      expect(photo.altText).toBe("A surfer on a wave");
      const empty = buildBulkRowBody({ ...BASE, row: asRow(photoRow()), platforms: ["instagram"] });
      expect("altText" in empty).toBe(false);
      const video = buildBulkRowBody({ ...BASE, row: asRow(videoRow({ altText: "Should not go" })), platforms: ["instagram"] });
      expect("altText" in video).toBe(false);
    });

    it(`${label}: cover fields for a video row only, only when given`, () => {
      const cover = { cover: { timeMs: 1200, imageUrl: "https://blob.example/covers/ws_1/x-cover.jpg", mimeType: "image/jpeg", sizeBytes: 5 } };
      const video = buildBulkRowBody({ ...BASE, row: asRow(videoRow()), platforms: ["instagram"], coverFields: cover });
      expect(video.cover).toEqual(cover.cover);
      const none = buildBulkRowBody({ ...BASE, row: asRow(videoRow()), platforms: ["instagram"] });
      expect("cover" in none).toBe(false);
      const photo = buildBulkRowBody({ ...BASE, row: asRow(photoRow()), platforms: ["instagram"], coverFields: cover });
      expect("cover" in photo).toBe(false);
    });
  }

  it("keeps today's fields: caption, platforms, deferred, workspace, YouTube privacy", () => {
    const body = buildBulkRowBody({ ...BASE, row: videoRow(), platforms: ["youtube"], deferred: { scheduledFor: "2026-12-01T10:00:00.000Z" } });
    expect(body).toMatchObject({
      blobUrl: VIDEO_BLOB.url,
      baseCaption: "Waves",
      platforms: ["youtube"],
      scheduledFor: "2026-12-01T10:00:00.000Z",
      workspaceId: "ws_1",
      youtubeMetadata: { privacyStatus: "unlisted" },
    });
  });
});

describe("Add many: Improve", () => {
  it("sends the caption to enhance-caption exactly as Create does and returns the answer", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ enhancedCaption: "Better" }), { status: 200 }));
    const result = await requestImprovedCaption("Sunny day", "ws-1", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, caption: "Better" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/posts/enhance-caption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caption: "Sunny day", workspaceId: "ws-1" }),
    });
  });

  it("a refusal, an empty answer or no answer: not ok, with the plain line", async () => {
    const refused = vi.fn(async () => Response.json({ error: "Server text" }, { status: 500 }));
    expect(await requestImprovedCaption("x", "ws-1", refused as unknown as typeof fetch)).toEqual({ ok: false, error: BULK_IMPROVE_FAILED_TEXT });
    const empty = vi.fn(async () => new Response(JSON.stringify({ enhancedCaption: "  " }), { status: 200 }));
    expect(await requestImprovedCaption("x", "ws-1", empty as unknown as typeof fetch)).toEqual({ ok: false, error: BULK_IMPROVE_FAILED_TEXT });
    const thrown = vi.fn(async () => {
      throw new Error("offline");
    });
    // Lead review 3 (R28 NN2): no answer: the AI may have run; the improved caption isn't shown.
    expect(await requestImprovedCaption("x", "ws-1", thrown as unknown as typeof fetch)).toEqual({ ok: false, error: BULK_IMPROVE_LOST_TEXT });
    // R29 OO1: a gateway's page is no answer too: the AI may have run.
    const gateway = vi.fn(async () => new Response("<html>504</html>", { status: 504, headers: { "content-type": "text/html" } }));
    expect(await requestImprovedCaption("x", "ws-1", gateway as unknown as typeof fetch)).toEqual({ ok: false, error: BULK_IMPROVE_LOST_TEXT });
    expect(BULK_IMPROVE_LOST_TEXT).toBe(
      "Vibe Socials' answer didn't reach you, so the improved caption isn't shown. If your connection dropped, reconnect first. The caption is as it was; try again, or edit it yourself.",
    );
    expect(BULK_IMPROVE_FAILED_TEXT).not.toMatch(/[()]/);
  });
});

describe("Add many: alt text auto-fill", () => {
  it("is wanted once for a photo with an uploaded file, never for a video", () => {
    const computer = { mediaItemId: null };
    expect(wantsAltText({ ...computer, mimeType: "image/jpeg", uploaded: true, altTextAsked: false })).toBe(true);
    expect(wantsAltText({ ...computer, mimeType: "image/jpeg", uploaded: true, altTextAsked: true })).toBe(false);
    expect(wantsAltText({ ...computer, mimeType: "image/jpeg", uploaded: false, altTextAsked: false })).toBe(false);
    expect(wantsAltText({ ...computer, mimeType: "video/mp4", uploaded: true, altTextAsked: false })).toBe(false);
  });

  // P1 fix 1: the Media DTO carries no description, and the reuse path writes
  // altText over the stored one, so a Media photo is never described unseen.
  it("never for a Media photo: its saved description must not be overwritten unseen", () => {
    expect(wantsAltText({ mediaItemId: "media_1", mimeType: "image/jpeg", uploaded: true, altTextAsked: false })).toBe(false);
  });

  it("a Media photo with an empty field sends no altText, so the server keeps the stored one", () => {
    const body = buildBulkRowBody({ ...BASE, row: photoRow({ mediaItemId: "media_1", altText: "  " }), platforms: ["instagram"] });
    expect("altText" in body).toBe(false);
    const typed = buildBulkRowBody({ ...BASE, row: photoRow({ mediaItemId: "media_1", altText: "Typed by hand" }), platforms: ["instagram"] });
    expect(typed.altText).toBe("Typed by hand");
  });

  it("asks the AI the way Create's Write it for me does and fills an empty field", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ altText: "A surfer" }), { status: 200 }));
    const text = await describePhotoOnce(BLOB, "ws-1", fetchImpl as unknown as typeof fetch);
    expect(text).toBe("A surfer");
    expect(fetchImpl).toHaveBeenCalledWith("/api/posts/auto-caption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blobUrl: BLOB.url, mimeType: BLOB.mimeType, purpose: "altText", workspaceId: "ws-1" }),
    });
  });

  it("a failure gives an empty description, without throwing", async () => {
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 429 }));
    expect(await describePhotoOnce(BLOB, "ws-1", refused as unknown as typeof fetch)).toBe("");
    const thrown = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await describePhotoOnce(BLOB, "ws-1", thrown as unknown as typeof fetch)).toBe("");
  });
});

describe("Add many: avoidCaptions", () => {
  const rows = (captions: string[]) => captions.map((caption, index) => ({ id: `r${index}`, caption }));

  it("other rows' non-empty captions, trimmed, never the row's own", () => {
    expect(siblingCaptions(rows(["  Mine ", " One ", "", "   ", "Two"]), "r0")).toEqual(["One", "Two"]);
  });

  it("at most 10, each at most 300 characters", () => {
    const many = rows(Array.from({ length: 15 }, (_, i) => `${i}`.padEnd(400, "x")));
    const result = siblingCaptions(many, "r0");
    expect(result).toHaveLength(10);
    expect(result.every((caption) => caption.length === 300)).toBe(true);
    expect(result[0].startsWith("1")).toBe(true);
  });

  it("none when no other row has text", () => {
    expect(siblingCaptions(rows(["Mine", ""]), "r0")).toEqual([]);
  });
});

describe("Add many: a row that cannot be a Story", () => {
  it("a video too long for an Instagram Story says why", () => {
    expect(
      rowStoryRefusal({ mimeType: "video/mp4", durationSec: 75, platforms: ["instagram"], stories: { instagram: true, facebook: false } }),
    ).toBe(storyVideoLengthRefusal("instagram", 75));
  });

  it("Facebook's own limit when Instagram is fine", () => {
    expect(
      rowStoryRefusal({ mimeType: "video/mp4", durationSec: 95, platforms: ["facebook_page"], stories: { instagram: true, facebook: true } }),
    ).toBe(storyVideoLengthRefusal("facebook_page", 95));
  });

  it("nothing for a photo, a feed post, a platform the row skips, or an unknown length", () => {
    const stories = { instagram: true, facebook: true };
    expect(rowStoryRefusal({ mimeType: "image/jpeg", durationSec: null, platforms: ["instagram"], stories })).toBeNull();
    expect(rowStoryRefusal({ mimeType: "video/mp4", durationSec: 75, platforms: ["instagram"], stories: { instagram: false, facebook: false } })).toBeNull();
    expect(rowStoryRefusal({ mimeType: "video/mp4", durationSec: 75, platforms: ["youtube"], stories })).toBeNull();
    expect(rowStoryRefusal({ mimeType: "video/mp4", durationSec: null, platforms: ["instagram"], stories })).toBeNull();
  });

  it("blocks the send with that reason, and a bad Google link blocks a photo row going to Google", () => {
    const stories = { instagram: true, facebook: false };
    expect(
      bulkExtrasBlock({ mimeType: "video/mp4", durationSec: 75, platforms: ["instagram"], stories, googleError: null }),
    ).toBe(storyVideoLengthRefusal("instagram", 75));
    const googleError = bulkGoogleMetadataError({ postType: "update", button: { type: "BOOK", url: "www.example" } });
    expect(googleError).not.toBeNull();
    expect(bulkExtrasBlock({ mimeType: "image/jpeg", durationSec: null, platforms: ["google_business_profile"], stories, googleError })).toBe(googleError);
    expect(bulkExtrasBlock({ mimeType: "video/mp4", durationSec: 10, platforms: ["google_business_profile"], stories, googleError })).toBeNull();
  });
});

describe("Add many: the batch Google options", () => {
  it("start from the workspace's default button, as Create does", () => {
    expect(initialBulkGoogleMetadata({ type: "BOOK", url: "https://example.com" })).toEqual({
      postType: "update",
      button: { type: "BOOK", url: "https://example.com" },
    });
    expect(initialBulkGoogleMetadata(null)).toEqual({ postType: "update" });
  });

  it("a good update has no error; a CALL button needs no link", () => {
    expect(bulkGoogleMetadataError({ postType: "update" })).toBeNull();
    expect(bulkGoogleMetadataError({ postType: "update", button: { type: "CALL" } })).toBeNull();
    expect(bulkGoogleMetadataError({ postType: "update", button: { type: "BOOK", url: "" } })).toMatch(/https:\/\//);
  });
});

describe("Add many: avoidCaptions in the caption request", () => {
  it("the second row's request carries the caption the first row was just given", () => {
    // As runWork leaves the rows: row 1 captioned a moment ago, row 2 about to be asked.
    const rows = [
      { id: "r1", caption: "Fresh caption for row one" },
      { id: "r2", caption: "" },
    ];
    const body = autoCaptionRequestBody(rows, "r2", { url: VIDEO_BLOB.url, mimeType: VIDEO_BLOB.mimeType }, ["data:image/jpeg;base64,AA"], "ws-1");
    expect(body).toEqual({
      blobUrl: VIDEO_BLOB.url,
      mimeType: VIDEO_BLOB.mimeType,
      bulk: true,
      frames: ["data:image/jpeg;base64,AA"],
      avoidCaptions: ["Fresh caption for row one"],
      workspaceId: "ws-1",
    });
  });

  it("the first row, with nothing written yet, sends today's body", () => {
    const body = autoCaptionRequestBody([{ id: "r1", caption: "" }, { id: "r2", caption: "" }], "r1", BLOB, [], "ws-1");
    expect(body).toEqual({ blobUrl: BLOB.url, mimeType: BLOB.mimeType, bulk: true, workspaceId: "ws-1" });
  });
});

// P1 fix 1: the line tells the truth about why Improve failed.
describe("Add many: why Improve failed", () => {
  const answer = (status: number, body: unknown) =>
    vi.fn(async () => Response.json(body, { status })) as unknown as typeof fetch;

  it("maps each status to its own sentence", () => {
    expect(improveFailedText(429, "AI_WORKSPACE_DAILY_LIMIT")).toBe(
      "The caption was not improved: your workspace has reached today's AI limit. Try again tomorrow, or edit it yourself.",
    );
    expect(improveFailedText(429, undefined)).toBe(
      "The caption was not improved: too many requests. Wait a few minutes, then try again.",
    );
    expect(improveFailedText(403, "WORKSPACE_PAUSED")).toBe(
      "The caption was not improved: this workspace can't use AI right now. See the notice at the top of the page.",
    );
    const tooLong = "The caption was not improved: it is too long to improve. Shorten it, or edit it yourself.";
    expect(improveFailedText(413, undefined)).toBe(tooLong);
    expect(improveFailedText(400, "AI_INPUT_TOO_LONG")).toBe(tooLong);
    expect(improveFailedText(500, undefined)).toBe(BULK_IMPROVE_FAILED_TEXT);
    expect(improveFailedText(504, undefined)).toBe(BULK_IMPROVE_FAILED_TEXT);
    expect(improveFailedText(null, undefined)).toBe(BULK_IMPROVE_FAILED_TEXT);
  });

  it("requestImprovedCaption returns the mapped sentence and never a caption on failure", async () => {
    for (const [status, body, expected] of [
      [429, { error: "x", code: "AI_WORKSPACE_DAILY_LIMIT" }, improveFailedText(429, "AI_WORKSPACE_DAILY_LIMIT")],
      [429, { error: "Too many requests, slow down." }, improveFailedText(429, undefined)],
      [403, { error: "Paused", code: "WORKSPACE_PAUSED" }, improveFailedText(403, "WORKSPACE_PAUSED")],
      [413, { error: "big" }, improveFailedText(413, undefined)],
      [400, { error: "too long", code: "AI_INPUT_TOO_LONG" }, improveFailedText(400, "AI_INPUT_TOO_LONG")],
      [500, { error: "Server text" }, BULK_IMPROVE_FAILED_TEXT],
    ] as const) {
      const result = await requestImprovedCaption("Keep me", "ws-1", answer(status, body));
      // Not ok: the form keeps the caption it has (it only replaces on ok).
      expect(result).toEqual({ ok: false, error: expected });
    }
  });

  it("no sentence has brackets", () => {
    for (const [status, code] of [[429, "AI_WORKSPACE_DAILY_LIMIT"], [429, undefined], [403, undefined], [413, undefined], [400, undefined], [null, undefined]] as const) {
      expect(improveFailedText(status, code)).not.toMatch(/[()]/);
    }
  });
});

// P1 fix 1: the description does not depend on how the caption went.
describe("Add many: caption, then description", () => {
  function fakeRow(overrides: Partial<{ mediaItemId: string | null; mimeType: string }> = {}) {
    const state = { mediaItemId: null as string | null, mimeType: "image/jpeg", uploaded: true, altTextAsked: false, ...overrides };
    const describe = vi.fn(async () => {
      state.altTextAsked = true;
    });
    return { state, describe, row: () => state };
  }

  it("caption ok: described once", async () => {
    const fake = fakeRow();
    await captionThenDescribe("r1", { writeCaption: async () => {}, row: fake.row, describe: fake.describe });
    expect(fake.describe).toHaveBeenCalledTimes(1);
  });

  it("caption failed (it returned early, or threw): still described once", async () => {
    const fake = fakeRow();
    await captionThenDescribe("r1", { writeCaption: async () => {}, row: fake.row, describe: fake.describe });
    const thrower = fakeRow();
    await expect(
      captionThenDescribe("r1", {
        writeCaption: async () => {
          throw new Error("504");
        },
        row: thrower.row,
        describe: thrower.describe,
      }),
    ).rejects.toThrow("504");
    expect(fake.describe).toHaveBeenCalledTimes(1);
    expect(thrower.describe).toHaveBeenCalledTimes(1);
  });

  it("Write again after either: no second description", async () => {
    const fake = fakeRow();
    const steps = { writeCaption: async () => {}, row: fake.row, describe: fake.describe };
    await captionThenDescribe("r1", steps);
    await captionThenDescribe("r1", steps);
    expect(fake.describe).toHaveBeenCalledTimes(1);
  });

  it("a Media photo and a video: never described automatically", async () => {
    for (const overrides of [{ mediaItemId: "media_1" }, { mimeType: "video/mp4" }]) {
      const fake = fakeRow(overrides);
      await captionThenDescribe("r1", { writeCaption: async () => {}, row: fake.row, describe: fake.describe });
      expect(fake.describe).not.toHaveBeenCalled();
    }
  });
});

// Q1 (2026-11-14): the batch's "Feed and Story" choice.
describe("Add many: Feed and Story", () => {
  it("sends both in each row body that goes there, upload and Media reuse", () => {
    for (const mediaItemId of [null, "media_1"]) {
      const body = buildBulkRowBody({
        ...BASE,
        row: photoRow({ mediaItemId }),
        platforms: ["instagram", "facebook_page"],
        stories: { instagram: "both", facebook: true },
      });
      expect(body.instagramMetadata).toEqual({ placement: "both" });
      expect(body.facebookMetadata).toEqual({ placement: "story" });
    }
    const notThere = buildBulkRowBody({ ...BASE, row: photoRow(), platforms: ["x"], stories: { instagram: "both", facebook: "both" } });
    expect("instagramMetadata" in notThere).toBe(false);
    expect("facebookMetadata" in notThere).toBe(false);
  });

  it("refuses a video too long for a Story on the row, before sending", () => {
    const stories = { instagram: "both" as const, facebook: false };
    expect(rowStoryRefusal({ mimeType: "video/mp4", durationSec: 75, platforms: ["instagram"], stories })).toBe(
      storyVideoLengthRefusal("instagram", 75),
    );
    expect(
      bulkExtrasBlock({ mimeType: "video/mp4", durationSec: 75, platforms: ["instagram"], stories, googleError: null }),
    ).toBe(storyVideoLengthRefusal("instagram", 75));
    expect(rowStoryRefusal({ mimeType: "video/mp4", durationSec: 30, platforms: ["instagram"], stories })).toBeNull();
  });

  it("names the row result", () => {
    const both = { storyPostJobId: "job-s" };
    expect(bulkRowResultText({ heldForApproval: false, mode: "schedule", body: both })).toBe("Scheduled (feed and Story)");
    expect(bulkRowResultText({ heldForApproval: false, mode: "draft", body: both })).toBe("Saved as drafts (feed and Story)");
    expect(bulkRowResultText({ heldForApproval: true, mode: "schedule", body: both })).toBe("Sent for approval");
    // Without a Story job, today's words.
    expect(bulkRowResultText({ heldForApproval: false, mode: "schedule", body: {} })).toBe("Scheduled");
    expect(bulkRowResultText({ heldForApproval: false, mode: "draft", body: null })).toBe("Saved as a draft");
    expect(bulkRowResultText({ heldForApproval: true, mode: "draft", body: {} })).toBe("Sent for approval");
  });
});

describe("bulkStoryChoice (the batch control to the row's choice)", () => {
  it("Feed, Story, Feed and Story", () => {
    expect(bulkStoryChoice("feed")).toBe(false);
    expect(bulkStoryChoice("story")).toBe(true);
    expect(bulkStoryChoice("both")).toBe("both");
  });
});

// F7 (R1 M2): "Write captions with AI" off sends no file to the AI.
describe("Add many: Write captions with AI off", () => {
  it("writes no caption and asks for no description, only reads the file locally", async () => {
    const writeCaption = vi.fn(async () => {});
    const describePhoto = vi.fn(async () => {});
    const withoutAi = vi.fn(async () => {});
    const row = () => ({ mediaItemId: null, mimeType: "image/jpeg", uploaded: true, altTextAsked: false });

    await captionThenDescribe("r1", { writeCaption, row, describe: describePhoto, withoutAi }, { ai: { current: false } });

    expect(writeCaption).not.toHaveBeenCalled();
    expect(describePhoto).not.toHaveBeenCalled();
    expect(withoutAi).toHaveBeenCalledWith("r1");
  });

  it("on (the default) writes the caption, then the description, as before", async () => {
    const order: string[] = [];
    const row = () => ({ mediaItemId: null, mimeType: "image/jpeg", uploaded: true, altTextAsked: false });
    await captionThenDescribe("r1", {
      writeCaption: async () => void order.push("caption"),
      row,
      describe: async () => void order.push("describe"),
      withoutAi: async () => void order.push("local"),
    });
    expect(order).toEqual(["caption", "describe"]);
  });

  // R39 publishing L1: the switch is read again after the caption, before the description.
  it("turned off while the caption is written: no description", async () => {
    const aiSwitch = { current: true };
    const describePhoto = vi.fn(async () => {});
    const row = () => ({ mediaItemId: null, mimeType: "image/jpeg", uploaded: true, altTextAsked: false });
    await captionThenDescribe(
      "r1",
      {
        writeCaption: async () => {
          aiSwitch.current = false;
        },
        row,
        describe: describePhoto,
      },
      { ai: aiSwitch },
    );
    expect(describePhoto).not.toHaveBeenCalled();
  });
});

describe("Add many: the AI captions choice is remembered in this browser", () => {
  function memory(initial: Record<string, string> = {}) {
    const values = { ...initial };
    return {
      values,
      getItem: (key: string) => values[key] ?? null,
      setItem: (key: string, value: string) => {
        values[key] = value;
      },
    };
  }

  it("is on when nothing was saved", () => {
    expect(readAiCaptionsChoice(() => memory())).toBe(true);
  });

  it("reads back what was saved", () => {
    const storage = memory();
    saveAiCaptionsChoice(() => storage, false);
    expect(storage.values[AI_CAPTIONS_STORAGE_KEY]).toBe("off");
    expect(readAiCaptionsChoice(() => storage)).toBe(false);
    saveAiCaptionsChoice(() => storage, true);
    expect(readAiCaptionsChoice(() => storage)).toBe(true);
  });

  it("is on when storage is missing, blocked or holds anything else", () => {
    expect(readAiCaptionsChoice(() => null)).toBe(true);
    expect(
      readAiCaptionsChoice(() => {
        throw new Error("SecurityError");
      }),
    ).toBe(true);
    expect(readAiCaptionsChoice(() => memory({ [AI_CAPTIONS_STORAGE_KEY]: "maybe" }))).toBe(true);
  });

  it("a storage failure on save is not an error", () => {
    expect(() =>
      saveAiCaptionsChoice(
        () => ({
          setItem: () => {
            throw new Error("QuotaExceeded");
          },
        }),
        false,
      ),
    ).not.toThrow();
  });
});

// R21 publishing-flow L1: a 401 reads the shared signed-out sentence, and a
// cover upload's failure goes through explainUploadFailure.
describe("signed out, and cover upload failures", () => {
  const SIGNED_OUT = "You were signed out. Sign in again.";
  const answer = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

  it("Improve answered 401: the signed-out sentence", () => {
    expect(improveFailedText(401, undefined)).toBe(SIGNED_OUT);
  });

  it("a cover upload refused because the session ended: the signed-out sentence", async () => {
    const fetchImpl = answer(401, { error: SIGNED_OUT });
    await expect(coverUploadFailedText(new Error("Failed to retrieve the client token"), "ws-1", fetchImpl)).resolves.toBe(SIGNED_OUT);
    expect(fetchImpl).toHaveBeenCalledWith("/api/upload?workspaceId=ws-1", { method: "GET" });
  });

  it("a cover upload refused because storage is full: the route's sentence", async () => {
    const full = "Your workspace's storage is full. Delete files in Media, then try again.";
    const fetchImpl = answer(200, { storageFull: true, error: full });
    await expect(coverUploadFailedText(new Error("Failed to retrieve the client token"), "ws-1", fetchImpl)).resolves.toBe(full);
  });

  // R24 JJ2 follow-up: a cover that never reached us says so, on Create and in Add many.
  it("a cover upload offline: the offline upload sentence", async () => {
    const offline = vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(coverUploadFailedText(new TypeError("Load failed"), "ws-1", offline as unknown as typeof fetch)).resolves.toBe(
      "We couldn't reach Vibe Socials, so the file wasn't uploaded. Check your connection and try again.",
    );
  });

  it("any other failure: the cover sentence", async () => {
    const fetchImpl = answer(200, {});
    await expect(coverUploadFailedText(new Error("network down"), "ws-1", fetchImpl)).resolves.toBe(BULK_COVER_FAILED_TEXT);
  });
});

// R31 (lead follow-up): another workspace's answer says the shared sentence;
// the row's caption is left as typed (Improve changes nothing on a refusal).
describe("Add many: a page for another workspace", () => {
  it("Improve says the shared sentence", async () => {
    const refused = vi.fn(async () => Response.json({ error: "You switched workspace in another tab. Reload this page, then try again.", code: "WORKSPACE_CHANGED" }, { status: 409 }));
    expect(await requestImprovedCaption("Keep me", "ws-1", refused as unknown as typeof fetch)).toEqual({
      ok: false,
      error: "You switched workspace in another tab. Reload this page, then try again.",
    });
    expect(improveFailedText(400, "MISSING_WORKSPACE_ID")).toBe("This page is out of date. Reload it, then try again.");
  });
});

describe("R41 publishing L1: an automatic request reads the box it writes into", () => {
  const on = { current: true };
  it("an empty box, or Write again over text: it goes", () => {
    expect(automaticRequestMayGo(on, true, { text: "" })).toBe(true);
    expect(automaticRequestMayGo(on, true, { text: "  " })).toBe(true);
    expect(automaticRequestMayGo(on, true, { text: "Typed", overwrite: true })).toBe(true);
  });
  it("typed text without Write again: nothing is asked", () => {
    expect(automaticRequestMayGo(on, true, { text: "Typed" })).toBe(false);
    expect(automaticRequestMayGo(on, true, { text: "Typed", overwrite: false })).toBe(false);
  });
  it("no box given: only the switch and the media decide, as on Create", () => {
    expect(automaticRequestMayGo(on, true)).toBe(true);
    expect(automaticRequestMayGo({ current: false }, true)).toBe(false);
    expect(automaticRequestMayGo(on, false)).toBe(false);
  });
});

describe("R41: rowAiRequests", () => {
  it("letting a box go aborts its request; the other box keeps its own", () => {
    const requests = rowAiRequests();
    const caption = requests.start("r1", "caption");
    const alt = requests.start("r1", "altText");
    expect(requests.letGo("r1", "caption")).toBe(true);
    expect(caption.live()).toBe(false);
    expect(caption.signal.aborted).toBe(true);
    expect(alt.live()).toBe(true);
    expect(requests.letGo("r1", "caption")).toBe(false);
  });
  it("an ended request is not let go, and a new press lets the old one go", () => {
    const requests = rowAiRequests();
    const first = requests.start("r1", "altText");
    const second = requests.start("r1", "altText");
    expect(first.live()).toBe(false);
    second.end();
    expect(second.live()).toBe(true);
    expect(requests.letGo("r1", "altText")).toBe(false);
  });
});
