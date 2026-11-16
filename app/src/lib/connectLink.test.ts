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
import type { ShownControl } from "./oauthResult";

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
    describeConnectLinkResult(new URLSearchParams(query));

  it("connected", () => {
    expect(describe_({ success: "instagram_connected" })).toEqual({ variant: "success", message: "Instagram is connected." });
    expect(describe_({ success: "google_business_profile_connected" })?.message).toBe(
      "Google Business Profile is connected. The person who sent you this link will choose the business location.",
    );
  });

  // R14-client-journey L2: a Business Profile reconnect keeps its saved location.
  it("Business Profile connected with a location already saved: only that it is connected", () => {
    expect(
      describeConnectLinkResult(new URLSearchParams({ success: "google_business_profile_connected" }), { locationKept: true }),
    ).toEqual({ variant: "success", message: "Google Business Profile is connected." });
    expect(describeConnectLinkResult(new URLSearchParams({ success: "instagram_connected" }), { locationKept: true })?.message).toBe(
      "Instagram is connected.",
    );
  });

  it("said no on the platform's screen: only the wrapper's <platform>_cancelled", () => {
    for (const error of ["x_cancelled", "linkedin_cancelled", "google_business_profile_cancelled"]) {
      expect(describe_({ error })?.message, error).toBe("You cancelled. Nothing was connected.");
    }
  });

  it("a callback's own denied or auth_failed code is never read as a cancellation", () => {
    expect(describe_({ error: "youtube_oauth_denied" })?.message).toBe(
      "We couldn't connect YouTube. Try again, or tell the person who sent you this link.",
    );
    expect(describe_({ error: "linkedin_auth_failed" })?.message).toBe(
      "We couldn't connect LinkedIn. Try again, or tell the person who sent you this link.",
    );
    for (const error of ["access_denied", "x_auth_denied"]) {
      expect(describe_({ error })?.message, error).not.toContain("cancelled");
    }
  });

  // R27 platform-clients L3: the visitor unticked the upload permission.
  it("YouTube without the upload permission: what to allow, in the visitor's words", () => {
    expect(describe_({ error: "youtube_upload_not_allowed" })).toEqual({
      variant: "danger",
      message:
        "YouTube wasn't connected: the permission to upload videos wasn't allowed. Press Connect again and, on Google's screen, allow \"Manage your YouTube videos\".",
    });
  });

  it("Business Profile signed in without the permission: what to allow, in the visitor's words", () => {
    expect(describe_({ error: "google_business_profile_permission_missing" })).toEqual({
      variant: "danger",
      message:
        "Google didn't give Vibe Socials access to the Business Profile, so nothing changed. Press Reconnect and, on Google's screen, allow access to the Business Profile.",
    });
  });

  // R28 (new-customer L6, platform-clients L2 and L3, pages L4): the control the row shows.
  it("a missing Google permission names the control the row shows", () => {
    const withShown = (error: string, shown: ShownControl) =>
      describeConnectLinkResult(new URLSearchParams({ error }), { shown: () => shown })?.message;
    expect(withShown("youtube_upload_not_allowed", "reconnect")).toBe(
      "YouTube wasn't reconnected: the permission to upload videos wasn't allowed. Press Reconnect and, on Google's screen, allow \"Manage your YouTube videos\".",
    );
    expect(withShown("youtube_upload_not_allowed", "connect")).toMatch(/Press Connect again/);
    expect(withShown("youtube_readonly_not_allowed", "connect")).toBe(
      "YouTube wasn't connected: the permission to see your YouTube account wasn't allowed. Press Connect again and, on Google's screen, allow \"View your YouTube account\".",
    );
    expect(withShown("youtube_readonly_not_allowed", "reconnect")).toMatch(/Press Reconnect and/);
    expect(withShown("google_business_profile_permission_missing", "connect")).toBe(
      "Google didn't give Vibe Socials access to the Business Profile, so nothing changed. Press Connect and, on Google's screen, allow access to the Business Profile.",
    );
    expect(withShown("google_business_profile_permission_missing", "reconnect")).toMatch(/Press Reconnect and/);
    // A working row shows no button on this page: no control is named.
    for (const error of ["youtube_upload_not_allowed", "youtube_readonly_not_allowed", "google_business_profile_permission_missing"]) {
      const message = withShown(error, "connected") ?? "";
      expect(message, error).toMatch(/stays connected as before\.$/);
      expect(message, error).not.toMatch(/Press|Click|Settings/);
    }
  });

  it("a place already taken", () => {
    expect(describe_({ error: "facebook_page_already_connected" })?.message).toBe(
      "Facebook Page is already connected. Ask the person who sent you this link if it should be changed.",
    );
  });

  it("the known causes, in a visitor's words that never send them to Settings", () => {
    const causes = {
      facebook_page_no_pages: /Facebook Page/,
      instagram_no_instagram_account: /Instagram/,
      linkedin_no_admin_pages: /Super admin/,
      pinterest_no_boards: /board/,
      youtube_upload_not_allowed: /Manage your YouTube videos/,
      youtube_readonly_not_allowed: /View your YouTube account/,
      google_business_profile_permission_missing: /allow access/,
    };
    for (const [error, pattern] of Object.entries(causes)) {
      const message = describe_({ error })?.message ?? "";
      expect(message, error).toMatch(pattern);
      expect(message, error).not.toMatch(/Settings/);
    }
    expect(describe_({ linkedin_setup: "true" })?.message).toMatch(/Super admin/);
  });

  // R29 OO1 lead follow-up: /c shows Reconnect on a flagged or ending-soon row
  // (app/c/[token]/page.tsx: form(connection ? "Reconnect" : "Connect")), so
  // a cause names the button the row shows, with the page's "press".
  it("a cause names the row's own button: Connect, Reconnect, or none on a working row", () => {
    const withShown = (query: Record<string, string>, shown: ShownControl) =>
      describeConnectLinkResult(new URLSearchParams(query), { shown: () => shown })?.message ?? "";
    for (const error of ["linkedin_no_admin_pages", "pinterest_no_boards", "facebook_page_no_pages", "instagram_no_instagram_account"]) {
      expect(withShown({ error }, "connect"), error).toMatch(/, then press Connect again\.$/);
      const reconnect = withShown({ error }, "reconnect");
      expect(reconnect, error).toMatch(/, then press Reconnect\. Your existing connection is unchanged\.$/);
      expect(reconnect, error).not.toMatch(/\bConnect\b/);
      const connected = withShown({ error }, "connected");
      expect(connected, error).not.toMatch(/\b(Re)?[Cc]onnect again\b|press (Re)?Connect/);
    }
    expect(withShown({ linkedin_setup: "true" }, "reconnect")).toMatch(/press Reconnect\./);
    expect(describe_({ error: "pinterest_no_boards" })?.message).toBe(
      "This Pinterest account has no board we can post to, and every Pin goes on a board. Create a board on Pinterest (not a secret one), then press Connect again.",
    );
  });

  it("anything else names the platform and the workspace, never the code", () => {
    for (const error of ["tiktok_token_exchange_failed", "x_session_expired", "tiktok_connect_failed"]) {
      const message = describe_({ error })?.message ?? "";
      expect(message).toMatch(/^We couldn't connect (TikTok|X)\. Try again, or tell the person who sent you this link\.$/);
      expect(message).not.toContain(error);
    }
    expect(describe_({ error: "oauth_session_mismatch" })?.message).toBe(
      "We couldn't connect the account. Try again, or tell the person who sent you this link.",
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
