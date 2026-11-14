import { describe, expect, it, vi } from "vitest";

import { storyVideoLengthRefusal } from "@/lib/storyPlacement";

import {
  BULK_IMPROVE_FAILED_TEXT,
  autoCaptionRequestBody,
  buildBulkRowBody,
  bulkExtrasBlock,
  bulkGoogleMetadataError,
  describePhotoOnce,
  initialBulkGoogleMetadata,
  requestImprovedCaption,
  rowStoryRefusal,
  siblingCaptions,
  wantsAltText,
  type BulkBodyRow,
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
  location: "",
  googleMetadata: { postType: "update" as const, button: { type: "BOOK" as const, url: "https://example.com" } },
  stories: { instagram: false, facebook: false },
  coverFields: {},
};

describe("Add many: the body for one row", () => {
  for (const reuse of [false, true]) {
    const label = reuse ? "Media reuse body" : "upload body";
    const asRow = (row: BulkBodyRow) => (reuse ? { ...row, mediaItemId: "media_1" } : row);

    it(`${label}: carries the batch location, trimmed, as Create sends it`, () => {
      const body = buildBulkRowBody({ ...BASE, row: asRow(photoRow()), platforms: ["instagram"], location: " Miami Beach " });
      expect(body.location).toBe("Miami Beach");
      expect(reuse ? "mediaItemId" in body : "blobUrl" in body).toBe(true);
    });

    it(`${label}: no location field when it is blank`, () => {
      const body = buildBulkRowBody({ ...BASE, row: asRow(photoRow()), platforms: ["instagram"] });
      expect(body.location).toBeUndefined();
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
    const result = await requestImprovedCaption("Sunny day", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, caption: "Better" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/posts/enhance-caption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caption: "Sunny day" }),
    });
  });

  it("a refusal, an empty answer or no answer: not ok, with the plain line", async () => {
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: "Server text" }), { status: 500 }));
    expect(await requestImprovedCaption("x", refused as unknown as typeof fetch)).toEqual({ ok: false, error: BULK_IMPROVE_FAILED_TEXT });
    const empty = vi.fn(async () => new Response(JSON.stringify({ enhancedCaption: "  " }), { status: 200 }));
    expect(await requestImprovedCaption("x", empty as unknown as typeof fetch)).toEqual({ ok: false, error: BULK_IMPROVE_FAILED_TEXT });
    const thrown = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await requestImprovedCaption("x", thrown as unknown as typeof fetch)).toEqual({ ok: false, error: BULK_IMPROVE_FAILED_TEXT });
    expect(BULK_IMPROVE_FAILED_TEXT).not.toMatch(/[()]/);
  });
});

describe("Add many: alt text auto-fill", () => {
  it("is wanted once for a photo with an uploaded file, never for a video", () => {
    expect(wantsAltText({ mimeType: "image/jpeg", uploaded: true, altTextAsked: false })).toBe(true);
    expect(wantsAltText({ mimeType: "image/jpeg", uploaded: true, altTextAsked: true })).toBe(false);
    expect(wantsAltText({ mimeType: "image/jpeg", uploaded: false, altTextAsked: false })).toBe(false);
    expect(wantsAltText({ mimeType: "video/mp4", uploaded: true, altTextAsked: false })).toBe(false);
  });

  it("asks the AI the way Create's Write it for me does and fills an empty field", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ altText: "A surfer" }), { status: 200 }));
    const text = await describePhotoOnce(BLOB, fetchImpl as unknown as typeof fetch);
    expect(text).toBe("A surfer");
    expect(fetchImpl).toHaveBeenCalledWith("/api/posts/auto-caption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blobUrl: BLOB.url, mimeType: BLOB.mimeType, purpose: "altText" }),
    });
  });

  it("a failure gives an empty description, without throwing", async () => {
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 429 }));
    expect(await describePhotoOnce(BLOB, refused as unknown as typeof fetch)).toBe("");
    const thrown = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await describePhotoOnce(BLOB, thrown as unknown as typeof fetch)).toBe("");
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
    const body = autoCaptionRequestBody(rows, "r2", { url: VIDEO_BLOB.url, mimeType: VIDEO_BLOB.mimeType }, ["data:image/jpeg;base64,AA"]);
    expect(body).toEqual({
      blobUrl: VIDEO_BLOB.url,
      mimeType: VIDEO_BLOB.mimeType,
      bulk: true,
      frames: ["data:image/jpeg;base64,AA"],
      avoidCaptions: ["Fresh caption for row one"],
    });
  });

  it("the first row, with nothing written yet, sends today's body", () => {
    const body = autoCaptionRequestBody([{ id: "r1", caption: "" }, { id: "r2", caption: "" }], "r1", BLOB, []);
    expect(body).toEqual({ blobUrl: BLOB.url, mimeType: BLOB.mimeType, bulk: true });
  });
});
