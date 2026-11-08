import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertPostTargetsValid, PostTargetingError } from "@/lib/postTargets";

import {
  buildPostInfo,
  getTikTokCreatorInfo,
  TIKTOK_CREATOR_CANNOT_POST,
  tiktokClient,
} from "./tiktokClient";
import type { PublishContext, TikTokPostMetadata } from "./types";

// What TikTok's Direct Post audit checks (developers.tiktok.com/doc/content-sharing-guidelines
// and .../content-posting-api-reference-direct-post), pinned 2026-11-08 after the audit was
// rejected for UX-guideline reasons.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const ctxWith = (tiktokMetadata?: Partial<TikTokPostMetadata>): PublishContext =>
  ({
    user: { id: "user-1" } as unknown as User,
    socialConnection: {} as SocialConnection,
    mediaItem: {} as MediaItem,
    caption: "hello",
    tiktokMetadata: tiktokMetadata as TikTokPostMetadata | undefined,
  }) as PublishContext;

const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? null;
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildPostInfo: only the API's fields, only the user's choices", () => {
  it("sends brand_content_toggle and brand_organic_toggle (not the old non-API fields)", () => {
    const info = buildPostInfo(
      ctxWith({ privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: false, disableDuet: true, disableStitch: true, brandedContent: true, brandOrganic: true }),
      "Surf's up",
    );
    expect(info).toEqual({
      title: "Surf's up",
      privacy_level: "PUBLIC_TO_EVERYONE",
      disable_comment: false,
      disable_duet: true,
      disable_stitch: true,
      video_cover_timestamp_ms: 1000,
      brand_content_toggle: true,
      brand_organic_toggle: true,
    });
    expect(info).not.toHaveProperty("disclosure_settings");
    expect(info).not.toHaveProperty("brand_content_type");
    expect(info).not.toHaveProperty("brand_organic_type");
  });

  it("always sends brand_content_toggle (TikTok marks it required), false when not chosen", () => {
    const info = buildPostInfo(ctxWith({ privacyLevel: "SELF_ONLY", disableComment: true, disableDuet: true, disableStitch: true }), "t");
    expect(info.brand_content_toggle).toBe(false);
    expect(info.brand_organic_toggle).toBe(false);
  });

  it("invents no privacy: a post without one is refused (TIKTOK_PRIVACY_REQUIRED)", () => {
    expect(codeOf(() => buildPostInfo(ctxWith(undefined), "t"))).toBe("TIKTOK_PRIVACY_REQUIRED");
    expect(codeOf(() => buildPostInfo(ctxWith({ privacyLevel: "  " }), "t"))).toBe("TIKTOK_PRIVACY_REQUIRED");
  });

  it("leaves interactions off when the choice is missing (guideline 2c)", () => {
    const info = buildPostInfo(ctxWith({ privacyLevel: "SELF_ONLY" }), "t");
    expect([info.disable_comment, info.disable_duet, info.disable_stitch]).toEqual([true, true, true]);
  });

  it("refuses branded content set to private (guideline 3b)", () => {
    expect(
      codeOf(() => buildPostInfo(ctxWith({ privacyLevel: "SELF_ONLY", brandedContent: true }), "t")),
    ).toBe("TIKTOK_BRANDED_CONTENT_PRIVATE");
    // "Your brand" alone may be private.
    expect(codeOf(() => buildPostInfo(ctxWith({ privacyLevel: "SELF_ONLY", brandOrganic: true }), "t"))).toBeNull();
  });
});

describe("POST /api/posts targeting: branded content can't be private", () => {
  it("refuses tiktok + branded content + SELF_ONLY with TIKTOK_BRANDED_CONTENT_PRIVATE", () => {
    let error: unknown;
    try {
      assertPostTargetsValid(["tiktok"], "video/mp4", { privacyLevel: "SELF_ONLY", brandedContent: true });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PostTargetingError);
    expect((error as PostTargetingError).code).toBe("TIKTOK_BRANDED_CONTENT_PRIVATE");
  });

  it("allows branded content when public, and ignores the rule when TikTok isn't a target", () => {
    expect(() =>
      assertPostTargetsValid(["tiktok"], "video/mp4", { privacyLevel: "MUTUAL_FOLLOW_FRIENDS", brandedContent: true }),
    ).not.toThrow();
    expect(() =>
      assertPostTargetsValid(["youtube"], "video/mp4", { privacyLevel: "SELF_ONLY", brandedContent: true }),
    ).not.toThrow();
  });
});

describe("getTikTokCreatorInfo", () => {
  it("returns the creator's nickname for the posting screen (guideline 1a)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          data: {
            creator_nickname: "Vibe Surf School USA",
            creator_username: "vibe.surf.school",
            creator_avatar_url: "https://p16.example/a.webp",
            privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
            max_video_post_duration_sec: 600,
          },
          error: { code: "ok", message: "" },
        }),
      ),
    );

    await expect(getTikTokCreatorInfo("token")).resolves.toMatchObject({
      creatorNickname: "Vibe Surf School USA",
      creatorUsername: "vibe.surf.school",
      privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
      maxVideoPostDurationSec: 600,
    });
  });

  it.each([
    ["spam_risk_too_many_posts", /posting limit/],
    ["spam_risk_user_banned_from_posting", /can't post right now/],
    ["reached_active_user_cap", /limit of accounts/],
    ["some_new_code", /can't post right now/],
  ])("stops with TIKTOK_CREATOR_CANNOT_POST when TikTok answers 200 + %s (guideline 1b)", async (code, message) => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: {}, error: { code, message: "x" } })));

    const error = await getTikTokCreatorInfo("token").then(
      () => null,
      (e: unknown) => e as Error & { code?: string; tiktokErrorCode?: string },
    );

    expect(error?.code).toBe(TIKTOK_CREATOR_CANNOT_POST);
    expect(error?.tiktokErrorCode).toBe(code);
    expect(error?.message).toMatch(message);
  });

  it("invents no privacy options when TikTok returns none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: { creator_username: "a" }, error: { code: "ok" } })));
    await expect(getTikTokCreatorInfo("token")).resolves.toMatchObject({ privacyLevelOptions: [], creatorNickname: "a" });
  });
});

describe("tiktokClient.publishVideo: checks against the latest creator info", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  const ctx = (privacyLevel: string): PublishContext =>
    ({
      user: { id: "user-1" } as unknown as User,
      socialConnection: {
        id: "conn-tt",
        platform: "tiktok",
        accessToken: "token",
        refreshToken: "refresh",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      } as unknown as SocialConnection,
      mediaItem: { mimeType: "video/mp4", storageLocation: "https://blob.example.com/v.mp4" } as unknown as MediaItem,
      caption: "hello",
      tiktokMetadata: { privacyLevel, disableComment: true, disableDuet: true, disableStitch: true },
    }) as PublishContext;

  it("stops before uploading when the chosen privacy is no longer offered (TIKTOK_PRIVACY_NOT_AVAILABLE)", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      if (String(input).includes("creator_info")) {
        return json({ data: { creator_username: "a", privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await tiktokClient.publishVideo(ctx("PUBLIC_TO_EVERYONE")).then(
      () => null,
      (e: unknown) => e as { code?: string },
    );

    expect(error?.code).toBe("TIKTOK_PRIVACY_NOT_AVAILABLE");
    expect(fetchMock).toHaveBeenCalledTimes(1); // creator_info only: nothing uploaded
  });

  it("stops before uploading when TikTok says the creator can't post now, keeping TikTok's reason", async () => {
    const fetchMock = vi.fn(async () => json({ data: {}, error: { code: "spam_risk_too_many_posts" } }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await tiktokClient.publishVideo(ctx("SELF_ONLY")).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    );

    expect(error?.code).toBe(TIKTOK_CREATOR_CANNOT_POST);
    expect(error?.message).toMatch(/posting limit/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
