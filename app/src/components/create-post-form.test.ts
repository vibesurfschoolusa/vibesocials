import { describe, expect, it } from "vitest";

import { buildTextPostBody, hasNoFile, noFileSubmitError } from "./create-post-form";

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
