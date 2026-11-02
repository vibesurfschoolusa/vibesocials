import type { Platform } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { buildReusePostBody, buildUploadPostBody } from "./createPostRequest";

// 2026-11-01 audit (M3) + final review (T9): the composer sends the id of the
// workspace its page was rendered for, and POST /api/posts refuses (409) when the
// cookie's workspace differs. The composer has no component tests, so the two
// request bodies are built by these pure functions and pinned here: a body that
// loses `workspaceId` silently turns the protection off. What the browser sends
// is the JSON text, so each case checks the parsed JSON, not the object.
const WORKSPACE_ID = "ws-rendered-for";

const BLOB = {
  url: "https://abc123.public.blob.vercel-storage.com/1700000000000-ab12cd34-cat.png",
  filename: "cat.png",
  mimeType: "image/png",
  sizeBytes: 1234,
} as const;

function sent(body: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

describe("buildReusePostBody", () => {
  const input = {
    mediaItemId: "media-1",
    baseCaption: "hello",
    location: "Lisbon",
    platforms: ["x", "linkedin"] as Platform[],
    deferred: {},
    workspaceId: WORKSPACE_ID,
  };

  it("sends the workspace id the page was rendered for", () => {
    expect(sent(buildReusePostBody(input)).workspaceId).toBe(WORKSPACE_ID);
  });

  it("builds the reuse body: the media item, caption, location and platforms", () => {
    expect(sent(buildReusePostBody(input))).toEqual({
      mediaItemId: "media-1",
      baseCaption: "hello",
      location: "Lisbon",
      platforms: ["x", "linkedin"],
      workspaceId: WORKSPACE_ID,
    });
  });

  it("keeps workspaceId alongside the draft and schedule fields", () => {
    expect(
      sent(buildReusePostBody({ ...input, platforms: ["x"], deferred: { draft: true } })),
    ).toMatchObject({ draft: true, workspaceId: WORKSPACE_ID });
    expect(
      sent(
        buildReusePostBody({
          ...input,
          platforms: ["x"],
          deferred: { scheduledFor: "2026-12-01T10:00:00.000Z" },
        }),
      ),
    ).toMatchObject({ scheduledFor: "2026-12-01T10:00:00.000Z", workspaceId: WORKSPACE_ID });
  });

  it("omits a blank location and trims a padded one", () => {
    expect(sent(buildReusePostBody({ ...input, platforms: ["x"], location: "   " }))).not.toHaveProperty(
      "location",
    );
    expect(sent(buildReusePostBody({ ...input, platforms: ["x"], location: "  Porto " })).location).toBe(
      "Porto",
    );
  });

  it("attaches per-platform overrides and platform metadata only when given", () => {
    const plain = sent(buildReusePostBody({ ...input, platforms: ["x"] }));
    expect(plain).not.toHaveProperty("perPlatformOverrides");
    expect(plain).not.toHaveProperty("tiktokMetadata");
    expect(plain).not.toHaveProperty("youtubeMetadata");

    const full = sent(
      buildReusePostBody({
        ...input,
        platforms: ["tiktok", "youtube"],
        perPlatformOverrides: { tiktok: "tt caption" },
        tiktokMetadata: {
          privacyLevel: "PUBLIC_TO_EVERYONE",
          disableComment: false,
          disableDuet: false,
          disableStitch: false,
        },
        youtubeMetadata: { privacyStatus: "unlisted" },
      }),
    );
    expect(full).toMatchObject({
      perPlatformOverrides: { tiktok: "tt caption" },
      tiktokMetadata: { privacyLevel: "PUBLIC_TO_EVERYONE" },
      youtubeMetadata: { privacyStatus: "unlisted" },
      workspaceId: WORKSPACE_ID,
    });
  });

  it("requires a workspace id at compile time", () => {
    // `npx tsc --noEmit` fails on an unused @ts-expect-error, so making the
    // field optional again fails the gate. The runtime call is only to run the line.
    // @ts-expect-error workspaceId is required
    const body = buildReusePostBody({ mediaItemId: "m", baseCaption: "c", location: "", platforms: [], deferred: {} });
    expect(body.mediaItemId).toBe("m");
  });
});

describe("buildUploadPostBody", () => {
  const input = {
    blob: BLOB,
    baseCaption: "hello",
    location: "Lisbon",
    platforms: ["x"] as Platform[],
    deferred: {},
    workspaceId: WORKSPACE_ID,
  };

  it("sends the workspace id the page was rendered for", () => {
    expect(sent(buildUploadPostBody(input)).workspaceId).toBe(WORKSPACE_ID);
  });

  it("builds the upload body: the blob, caption, location and platforms", () => {
    expect(sent(buildUploadPostBody(input))).toEqual({
      blobUrl: BLOB.url,
      filename: "cat.png",
      mimeType: "image/png",
      sizeBytes: 1234,
      baseCaption: "hello",
      location: "Lisbon",
      platforms: ["x"],
      workspaceId: WORKSPACE_ID,
    });
  });

  it("keeps workspaceId alongside the draft and schedule fields", () => {
    expect(sent(buildUploadPostBody({ ...input, deferred: { draft: true } }))).toMatchObject({
      draft: true,
      workspaceId: WORKSPACE_ID,
    });
    expect(
      sent(buildUploadPostBody({ ...input, deferred: { scheduledFor: "2026-12-01T10:00:00.000Z" } })),
    ).toMatchObject({ scheduledFor: "2026-12-01T10:00:00.000Z", workspaceId: WORKSPACE_ID });
  });

  it("omits a blank location and trims a padded one", () => {
    expect(sent(buildUploadPostBody({ ...input, location: "" }))).not.toHaveProperty("location");
    expect(sent(buildUploadPostBody({ ...input, location: "  Porto " })).location).toBe("Porto");
  });

  it("attaches platform metadata only when given", () => {
    const plain = sent(buildUploadPostBody(input));
    expect(plain).not.toHaveProperty("tiktokMetadata");
    expect(plain).not.toHaveProperty("youtubeMetadata");

    expect(
      sent(buildUploadPostBody({ ...input, youtubeMetadata: { privacyStatus: "private" } })),
    ).toMatchObject({ youtubeMetadata: { privacyStatus: "private" }, workspaceId: WORKSPACE_ID });
  });

  it("requires a workspace id at compile time", () => {
    // @ts-expect-error workspaceId is required
    const body = buildUploadPostBody({ blob: BLOB, baseCaption: "c", location: "", platforms: [], deferred: {} });
    expect(body.blobUrl).toBe(BLOB.url);
  });
});
