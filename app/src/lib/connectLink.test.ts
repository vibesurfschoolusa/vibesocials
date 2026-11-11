import { describe, expect, it } from "vitest";

import {
  CONNECT_LINK_REOPEN_MESSAGE,
  configuredConnectLinkPlatforms,
  connectLinkPlatformConfigured,
  connectLinkUrl,
  describeConnectLinkResult,
  isConnectLinkTokenShape,
  parseConnectLinkPlatforms,
} from "./connectLink";

const ALL_ENV = {
  TIKTOK_CLIENT_KEY: "k",
  TIKTOK_CLIENT_SECRET: "s",
  TIKTOK_REDIRECT_URI: "r",
  GOOGLE_GBP_CLIENT_ID: "k",
  GOOGLE_GBP_CLIENT_SECRET: "s",
  GOOGLE_GBP_REDIRECT_URI: "r",
  YOUTUBE_REDIRECT_URI: "r",
  FACEBOOK_APP_ID: "k",
  FACEBOOK_APP_SECRET: "s",
  INSTAGRAM_REDIRECT_URI: "r",
  FACEBOOK_PAGE_REDIRECT_URI: "r",
  LINKEDIN_CLIENT_ID: "k",
  LINKEDIN_CLIENT_SECRET: "s",
  LINKEDIN_REDIRECT_URI: "r",
  PINTEREST_APP_ID: "k",
  PINTEREST_APP_SECRET: "s",
  PINTEREST_REDIRECT_URI: "r",
  X_CONSUMER_KEY: "k",
  X_CONSUMER_SECRET: "s",
  X_CALLBACK_URL: "r",
};

describe("the link's address and token", () => {
  it("is /c/<token> on the app's own address", () => {
    expect(connectLinkUrl("https://vibesocials.wtf", "abc")).toBe("https://vibesocials.wtf/c/abc");
  });

  it("only a 43-character base64url token is worth a lookup", () => {
    expect(isConnectLinkTokenShape("A".repeat(43))).toBe(true);
    expect(isConnectLinkTokenShape("A".repeat(42))).toBe(false);
    expect(isConnectLinkTokenShape(`${"A".repeat(42)}.`)).toBe(false);
  });
});

describe("which platforms are configured", () => {
  it("needs every variable the start and the callback read", () => {
    expect(connectLinkPlatformConfigured("tiktok", ALL_ENV)).toBe(true);
    expect(connectLinkPlatformConfigured("tiktok", { ...ALL_ENV, TIKTOK_CLIENT_SECRET: "" })).toBe(false);
    expect(connectLinkPlatformConfigured("youtube", { ...ALL_ENV, YOUTUBE_REDIRECT_URI: undefined })).toBe(false);
    expect(connectLinkPlatformConfigured("pinterest", { ...ALL_ENV, PINTEREST_APP_ID: " " })).toBe(false);
    expect(connectLinkPlatformConfigured("x", { ...ALL_ENV, X_CALLBACK_URL: "" })).toBe(false);
  });

  it("lists them in the app's order", () => {
    expect(configuredConnectLinkPlatforms(ALL_ENV)).toHaveLength(8);
    expect(configuredConnectLinkPlatforms({ TIKTOK_CLIENT_KEY: "k", TIKTOK_CLIENT_SECRET: "s", TIKTOK_REDIRECT_URI: "r" })).toEqual([
      "tiktok",
    ]);
  });
});

describe("the platforms an owner offers", () => {
  it("takes at least one configured platform, once each, in the app's order", () => {
    expect(parseConnectLinkPlatforms(["instagram", "tiktok", "tiktok"], ALL_ENV)).toEqual({
      ok: true,
      platforms: ["tiktok", "instagram"],
    });
  });

  it("refuses none, an unknown one, an unconfigured one, and anything not a list", () => {
    expect(parseConnectLinkPlatforms([], ALL_ENV)).toMatchObject({ ok: false });
    expect(parseConnectLinkPlatforms(undefined, ALL_ENV)).toMatchObject({ ok: false });
    expect(parseConnectLinkPlatforms("tiktok", ALL_ENV)).toMatchObject({ ok: false });
    expect(parseConnectLinkPlatforms(["myspace"], ALL_ENV)).toMatchObject({ ok: false });
    expect(parseConnectLinkPlatforms(["tiktok"], {})).toMatchObject({ ok: false });
  });
});

describe("the sentence the visitor reads after a flow", () => {
  const describe_ = (query: Record<string, string>) =>
    describeConnectLinkResult(new URLSearchParams(query), "Surf Co");

  it("connected", () => {
    expect(describe_({ success: "instagram_connected" })).toEqual({ variant: "success", message: "Instagram is connected." });
    expect(describe_({ success: "google_business_profile_connected" })?.message).toBe(
      "Google Business Profile is connected. Surf Co will choose the business location.",
    );
  });

  it("said no on the platform's screen", () => {
    for (const error of ["access_denied", "x_auth_denied", "linkedin_auth_failed", "youtube_oauth_denied"]) {
      expect(describe_({ error })?.message, error).toBe("You cancelled. Nothing was connected.");
    }
  });

  it("a place already taken", () => {
    expect(describe_({ error: "facebook_page_already_connected" })?.message).toBe(
      "Facebook Page is already connected. Ask Surf Co if it should be changed.",
    );
  });

  it("the known causes, in a visitor's words that never send them to Settings", () => {
    const causes = {
      facebook_page_no_pages: /Facebook Page/,
      instagram_no_instagram_account: /Instagram/,
      linkedin_no_admin_pages: /Super admin/,
      pinterest_no_boards: /board/,
    };
    for (const [error, pattern] of Object.entries(causes)) {
      const message = describe_({ error })?.message ?? "";
      expect(message, error).toMatch(pattern);
      expect(message, error).not.toMatch(/Settings/);
    }
    expect(describe_({ linkedin_setup: "true" })?.message).toMatch(/Super admin/);
  });

  it("anything else names the platform and the workspace, never the code", () => {
    for (const error of ["tiktok_token_exchange_failed", "x_session_expired", "tiktok_connect_failed"]) {
      const message = describe_({ error })?.message ?? "";
      expect(message).toMatch(/^We couldn't connect (TikTok|X)\. Try again, or tell Surf Co\.$/);
      expect(message).not.toContain(error);
    }
    expect(describe_({ error: "oauth_session_mismatch" })?.message).toBe(
      "We couldn't connect the account. Try again, or tell Surf Co.",
    );
  });

  it("nothing to say without an outcome", () => {
    expect(describe_({})).toBeNull();
  });

  it("the sentence for a flow that cannot be finished in this browser", () => {
    expect(CONNECT_LINK_REOPEN_MESSAGE).toBe(
      "This link has expired or was opened in a different browser. Open the link you were sent again.",
    );
  });
});
