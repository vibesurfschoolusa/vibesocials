import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { describeConnectLinkResult } from "./connectLink";
import {
  describeOAuthResult,
  differentAccountBanner,
  differentAccountKeptMessage,
  shownControl,
  type ShownControl,
} from "./oauthResult";

describe("describeOAuthResult", () => {
  it("returns null when neither param is present", () => {
    expect(describeOAuthResult({ error: null, success: null })).toBeNull();
  });

  it("maps a success code to a success message with the platform label", () => {
    expect(describeOAuthResult({ error: null, success: "youtube_connected" })).toMatchObject({
      variant: "success",
      message: "YouTube connected.",
    });
  });

  it("maps a denied error to a 'you cancelled' message", () => {
    const result = describeOAuthResult({ error: "tiktok_access_denied", success: null });
    expect(result?.variant).toBe("danger");
    expect(result?.message).toContain("TikTok");
    expect(result?.message).toContain("cancelled");
  });

  it("handles platforms whose key contains underscores", () => {
    const result = describeOAuthResult({
      error: "google_business_profile_access_denied",
      success: null,
    });
    expect(result?.message).toContain("Google Business Profile");
  });

  it("falls back to a generic failure for unknown codes", () => {
    const result = describeOAuthResult({ error: "bogus_code", success: null });
    expect(result?.variant).toBe("danger");
    expect(result?.message).toContain("couldn't be connected");
  });

  it("error wins when both params are present", () => {
    const result = describeOAuthResult({
      error: "x_auth_denied",
      success: "x_connected",
    });
    expect(result?.variant).toBe("danger");
  });

  // Team Workspaces (Task 6, design §5): OAuth start/callback routes gate on
  // workspace ownership and redirect `?error=<platform>_not_workspace_owner`
  // when the caller is authenticated but not the workspace owner.
  // F3 (2026-11-14 review): a start from a tab rendered for another workspace
  // is refused (lib/workspace.ts requireOwnerContextForOAuthStart) and lands
  // here on a fresh Settings page for the workspace that is active now.
  describe("_workspace_changed (a start from a stale tab)", () => {
    const MESSAGE =
      "That tab was for another workspace, so nothing was connected. This page shows the workspace you are in now: click Connect again to connect it here.";

    it.each(["youtube", "x", "tiktok", "pinterest", "instagram", "facebook_page", "linkedin", "google_business_profile"])(
      "says what happened for %s, not a generic failure",
      (platform) => {
        expect(describeOAuthResult({ error: `${platform}_workspace_changed`, success: null })).toEqual({
          variant: "danger",
          message: MESSAGE,
          platform,
        });
      },
    );
  });

  describe("_not_workspace_owner (Team Workspaces)", () => {
    it("maps a platform-prefixed not_workspace_owner code to a label-aware message", () => {
      const result = describeOAuthResult({
        error: "facebook_page_not_workspace_owner",
        success: null,
      });
      expect(result).toMatchObject({
        variant: "danger",
        message: "Only the workspace owner can connect accounts. Ask them to connect Facebook Page.",
      });
    });

    it("resolves every platform's not_workspace_owner code to its label", () => {
      const cases: Array<[string, string]> = [
        ["facebook_page_not_workspace_owner", "Facebook Page"],
        ["google_business_profile_not_workspace_owner", "Google Business Profile"],
        ["instagram_not_workspace_owner", "Instagram"],
        ["linkedin_not_workspace_owner", "LinkedIn"],
        ["tiktok_not_workspace_owner", "TikTok"],
        ["x_not_workspace_owner", "X"],
        ["youtube_not_workspace_owner", "YouTube"],
      ];

      for (const [code, label] of cases) {
        const result = describeOAuthResult({ error: code, success: null });
        expect(result?.variant).toBe("danger");
        expect(result?.message).toBe(
          `Only the workspace owner can connect accounts. Ask them to connect ${label}.`,
        );
      }
    });

    it("falls back gracefully for an unprefixed not_workspace_owner code", () => {
      const result = describeOAuthResult({ error: "not_workspace_owner", success: null });
      expect(result).toMatchObject({
        variant: "danger",
        message: "Only the workspace owner can connect accounts. Ask them to connect it.",
      });
    });
  });
});

// Coverage for the literal codes actually emitted today by the 7 routes at
// src/app/api/auth/*/callback/route.ts. The grep suggested in the task brief
// (grep -rho "settings?[a-z_=&]*" ...) only catches routes that build the
// redirect as one literal string; several routes instead build the URL via
// `new URL(...).searchParams.set("error", "<code>")`, so this list was
// compiled by reading all 7 route files directly.
describe("describeOAuthResult — real callback-route codes", () => {
  it("maps every platform's real *_connected success code to its label", () => {
    expect(describeOAuthResult({ error: null, success: "facebook_page_connected" })).toMatchObject({
      variant: "success",
      message: "Facebook Page connected.",
    });
    expect(
      describeOAuthResult({ error: null, success: "google_business_profile_connected" }),
    ).toMatchObject({
      variant: "success",
      message: "Google Business Profile connected.",
    });
    expect(describeOAuthResult({ error: null, success: "instagram_connected" })).toMatchObject({
      variant: "success",
      message: "Instagram connected.",
    });
    expect(describeOAuthResult({ error: null, success: "linkedin_connected" })).toMatchObject({
      variant: "success",
      message: "LinkedIn connected.",
    });
    expect(describeOAuthResult({ error: null, success: "tiktok_connected" })).toMatchObject({
      variant: "success",
      message: "TikTok connected.",
    });
    expect(describeOAuthResult({ error: null, success: "x_connected" })).toMatchObject({
      variant: "success",
      message: "X connected.",
    });
    expect(describeOAuthResult({ error: null, success: "youtube_connected" })).toMatchObject({
      variant: "success",
      message: "YouTube connected.",
    });
  });

  it("resolves X's real denial code (x_auth_denied) to a cancelled X message", () => {
    const result = describeOAuthResult({ error: "x_auth_denied", success: null });
    expect(result).toMatchObject({
      variant: "danger",
      message:
        "You cancelled the X authorization — nothing was connected. Click Connect to try again.",
    });
  });

  it("resolves YouTube's real denial code (youtube_oauth_denied) to a cancelled YouTube message", () => {
    const result = describeOAuthResult({ error: "youtube_oauth_denied", success: null });
    expect(result?.variant).toBe("danger");
    expect(result?.message).toContain("YouTube");
    expect(result?.message).toContain("cancelled");
  });

  it("buckets real invalid_state / missing_params codes as a secure sign-in failure", () => {
    for (const error of [
      "facebook_page_invalid_state",
      "tiktok_invalid_state",
      "youtube_oauth_invalid_state",
      "linkedin_invalid_state",
      "linkedin_missing_params",
      "x_missing_params",
      "youtube_oauth_missing_params",
    ]) {
      const result = describeOAuthResult({ error, success: null });
      expect(result?.variant).toBe("danger");
      expect(result?.message).toContain("couldn't be completed securely");
    }
  });

  it("buckets other real failure codes as a generic connect failure", () => {
    for (const error of [
      "facebook_page_connect_failed",
      "facebook_page_token_exchange_failed",
      "tiktok_connect_failed",
      "x_connect_failed",
      "x_session_expired",
      "youtube_connect_failed",
      "linkedin_config_missing",
      "linkedin_token_exchange_failed",
      "google_business_profile_connect_failed",
    ]) {
      const result = describeOAuthResult({ error, success: null });
      expect(result?.variant).toBe("danger");
      expect(result?.message).toContain("couldn't be connected");
    }
  });

  // R5 new-customer M1: these three are fixed on the platform's side, so a
  // bare "try again" would only repeat the same failure.
  it("names the cause and the next step when the account has no Page, Instagram account or channel", () => {
    expect(describeOAuthResult({ error: "facebook_page_no_pages", success: null })).toMatchObject({
      variant: "danger",
      platform: "facebook_page",
      message:
        "Facebook didn't return a Page. Click Connect again, sign in with a Facebook account that manages your Facebook Page and tick it when Facebook lists the Pages.",
    });
    expect(describeOAuthResult({ error: "instagram_no_instagram_account", success: null })).toMatchObject({
      variant: "danger",
      platform: "instagram",
      message:
        "Facebook didn't return a Page with a linked Instagram account. If your Instagram professional account isn't linked to your Page yet, link it in your Page's settings on Facebook, under Linked accounts, first. Click Connect again, sign in with a Facebook account that manages the Page linked to your Instagram account and tick that Page when Facebook lists the Pages (and its Instagram account, if listed).",
    });
    expect(describeOAuthResult({ error: "youtube_no_channel", success: null })).toMatchObject({
      variant: "danger",
      platform: "youtube",
      message:
        "This Google account has no YouTube channel. Create a channel on YouTube, or sign in with the Google account that owns your channel, then click Connect again.",
    });
  });

  // R53 new-customer L2: a manager who ticked no Page in Meta's list gets
  // these too, so the sentence says only what Facebook returned, then both steps.
  it("no Page, or no Page with Instagram, says what Facebook returned, never that the account manages none", () => {
    for (const error of ["facebook_page_no_pages", "instagram_no_instagram_account"]) {
      const message = describeOAuthResult({ error, success: null })!.message;
      expect(message, error).toMatch(/^Facebook didn't return a Page/);
      expect(message, error).toContain("when Facebook lists the Pages");
      // R53 fix review: the steps in the order they are done, the button first.
      expect(message, error).toContain("Click Connect again, sign in with a Facebook account that manages");
      expect(message, error).not.toMatch(/doesn't manage|None of the Facebook Pages/);
    }
    expect(
      describeOAuthResult({ error: "instagram_no_instagram_account", success: null }, { shown: () => "reconnect" })!.message,
    ).toBe(
      "Facebook didn't return a Page with a linked Instagram account. If your Instagram professional account isn't linked to your Page yet, link it in your Page's settings on Facebook, under Linked accounts, first. Click Reconnect, sign in with a Facebook account that manages the Page linked to your Instagram account and tick that Page when Facebook lists the Pages (and its Instagram account, if listed). Your existing connection is unchanged.",
    );
  });

  it("no Page on a working row: no button to name, the connection unchanged", () => {
    expect(describeOAuthResult({ error: "facebook_page_no_pages", success: null }, { shown: () => "connected" })!.message).toBe(
      "Facebook didn't return a Page. Your existing connection is unchanged.",
    );
    expect(describeOAuthResult({ error: "instagram_no_instagram_account", success: null }, { shown: () => "connected" })!.message).toBe(
      "Facebook didn't return a Page with a linked Instagram account. If your Instagram professional account isn't linked to your Page yet, link it in your Page's settings on Facebook, under Linked accounts. Your existing connection is unchanged.",
    );
  });

  // R53 fix review L1: with no step after it, "link it first" had nothing to
  // come first to; the link step then says where, on its own.
  it("Instagram's link step: 'first' only when the button step follows, on Settings and on /c", () => {
    const settings = (shown: ShownControl) =>
      describeOAuthResult({ error: "instagram_no_instagram_account", success: null }, { shown: () => shown })!.message;
    const link = (shown: ShownControl) =>
      describeConnectLinkResult(new URLSearchParams({ error: "instagram_no_instagram_account" }), { shown: () => shown })!.message;
    for (const message of [settings("connect"), settings("reconnect"), link("connect"), link("reconnect")]) {
      expect(message).toContain("isn't linked to your Page yet, link it in your Page's settings on Facebook, under Linked accounts, first. ");
      expect(message).toMatch(/under Linked accounts, first\. (Click|Press) (Connect again|Reconnect), sign in/);
    }
    for (const message of [settings("reconnect"), link("reconnect")]) {
      expect(message).toMatch(/under Linked accounts, first\. (Click|Press) Reconnect, .*\. Your existing connection is unchanged\.$/);
    }
    for (const message of [settings("connected"), link("connected")]) {
      expect(message).toBe("Facebook didn't return a Page with a linked Instagram account. If your Instagram professional account isn't linked to your Page yet, link it in your Page's settings on Facebook, under Linked accounts. Your existing connection is unchanged.");
      expect(message).not.toContain("first");
    }
  });

  // R54 platform-clients L2: only Instagram's sentence names where to link it.
  it("Facebook Page's no_pages keeps its words with Connect, Reconnect and no button", () => {
    const settings = (shown: ShownControl) =>
      describeOAuthResult({ error: "facebook_page_no_pages", success: null }, { shown: () => shown })!.message;
    expect(settings("connect")).toBe(
      "Facebook didn't return a Page. Click Connect again, sign in with a Facebook account that manages your Facebook Page and tick it when Facebook lists the Pages.",
    );
    expect(settings("reconnect")).toBe(
      "Facebook didn't return a Page. Click Reconnect, sign in with a Facebook account that manages your Facebook Page and tick it when Facebook lists the Pages. Your existing connection is unchanged.",
    );
    expect(settings("connected")).toBe("Facebook didn't return a Page. Your existing connection is unchanged.");
    for (const shown of ["connect", "reconnect", "connected"] as const) expect(settings(shown)).not.toContain("Linked accounts");
  });

  it("the same two on the connect link page, with its press", () => {
    const link = (error: string) => describeConnectLinkResult(new URLSearchParams({ error }))?.message;
    expect(link("facebook_page_no_pages")).toBe(
      "Facebook didn't return a Page. Press Connect again, sign in with a Facebook account that manages your Facebook Page and tick it when Facebook lists the Pages.",
    );
    expect(link("instagram_no_instagram_account")).toBe(
      "Facebook didn't return a Page with a linked Instagram account. If your Instagram professional account isn't linked to your Page yet, link it in your Page's settings on Facebook, under Linked accounts, first. Press Connect again, sign in with a Facebook account that manages the Page linked to your Instagram account and tick that Page when Facebook lists the Pages (and its Instagram account, if listed).",
    );
    // Other causes keep their words.
    expect(link("linkedin_no_admin_pages")).toBe(
      "This LinkedIn account isn't a Super admin of any company page. Sign in to LinkedIn with an account that is a Super admin of your page, then press Connect again.",
    );
    expect(link("youtube_no_channel")).toBe(
      "This Google account has no YouTube channel. Create a channel on YouTube, or sign in with the Google account that owns your channel, then press Connect again.",
    );
  });

  // R44 pages-a L7: the LinkedIn callback passes LinkedIn's own code on.
  // Only its user_cancelled_* codes are a "no"; any other is a failure.
  it("resolves LinkedIn's own cancel codes to a cancelled LinkedIn message", () => {
    for (const error of ["linkedin_user_cancelled_login", "linkedin_user_cancelled_authorize"]) {
      expect(describeOAuthResult({ error, success: null }), error).toMatchObject({
        variant: "danger",
        message:
          "You cancelled the LinkedIn authorization — nothing was connected. Click Connect to try again.",
      });
    }
  });

  it("any other LinkedIn or Google provider code is a failed sign-in, not a cancel", () => {
    for (const [error, message] of [
      ["linkedin_unauthorized_scope_error", "LinkedIn couldn't be connected. Please try again."],
      ["linkedin_auth_failed", "LinkedIn couldn't be connected. Please try again."],
      ["youtube_admin_policy_enforced", "YouTube couldn't be connected. Please try again."],
    ]) {
      expect(describeOAuthResult({ error, success: null })?.message, error).toBe(message);
    }
  });

  // Until R30 the Facebook Page, Instagram, Business Profile and TikTok
  // callbacks sent the provider's own code (access_denied) and a few failures
  // (missing_code_or_state, invalid_state, token_exchange_failed) without a
  // platform name. They all name it now (app/api/auth/oauthErrorCodes.test.ts);
  // an old code still in someone's address bar reads without a platform name.
  it("falls back to the generic account label for real unprefixed codes", () => {
    for (const error of ["missing_code_or_state", "token_exchange_failed"]) {
      const result = describeOAuthResult({ error, success: null });
      expect(result).toMatchObject({
        variant: "danger",
        message: "The account couldn't be connected. Please try again.",
      });
    }
  });

  // Fixed: platformFromCode now returns null (instead of the literal string
  // "The account") when no platform key matches, so each template supplies
  // its own label-less phrasing rather than pairing its built-in article
  // with a fallback noun that already carried one — this used to render as
  // "You cancelled the The account authorization..." / "The The account
  // sign-in..." (doubled article).
  it("treats an unprefixed access_denied code as a cancellation, without a doubled article", () => {
    const result = describeOAuthResult({ error: "access_denied", success: null });
    expect(result).toMatchObject({
      variant: "danger",
      message:
        "You cancelled the authorization — nothing was connected. Click Connect to try again.",
    });
  });

  it("buckets an unprefixed invalid_state code as a secure sign-in failure, without a doubled article", () => {
    const result = describeOAuthResult({ error: "invalid_state", success: null });
    expect(result).toMatchObject({
      variant: "danger",
      message: "The sign-in couldn't be completed securely. Please try connecting again.",
    });
    expect(result?.message.startsWith("The sign-in")).toBe(true);
  });
});

// Audit fixes Task 6: codes added with the OAuth callback session binding
// (lib/oauthCallbackGuard.ts) and the start/callback error handling.
describe("describeOAuthResult — LinkedIn account that administers no page", () => {
  it("says what to do instead of a generic failure", () => {
    expect(describeOAuthResult({ error: "linkedin_no_admin_pages", success: null })).toMatchObject({
      variant: "danger",
      message:
        "This LinkedIn account isn't a Super admin of any company page. Sign in to LinkedIn with an account that is a Super admin of your page, then click Connect again.",
    });
  });
});

// R27 platform-clients L3: the upload permission was unticked on Google's screen.
describe("describeOAuthResult — YouTube without the upload permission", () => {
  it("says nothing was connected and to allow Manage your YouTube videos", () => {
    expect(describeOAuthResult({ error: "youtube_upload_not_allowed", success: null })).toEqual({
      variant: "danger",
      platform: "youtube",
      message:
        "YouTube wasn't connected: the permission to upload videos wasn't allowed. Click Connect again and, on Google's screen, allow \"Manage your YouTube videos\".",
    });
  });
});

// R27 lead review: the in-place sign-in came back without the Business Profile permission.
describe("describeOAuthResult — Business Profile sign-in without the permission", () => {
  it("says nothing changed and to allow access on Google's screen", () => {
    expect(describeOAuthResult({ error: "google_business_profile_permission_missing", success: null })).toEqual({
      variant: "danger",
      platform: "google_business_profile",
      message:
        "Google didn't give Vibe Socials access to your Business Profile, so nothing changed. Sign in to Google again from the Google Business Profile card and, on Google's screen, allow access to your Business Profile.",
    });
  });
});

describe("describeOAuthResult — Pinterest", () => {
  it("an account with no board we can post to is told to create one", () => {
    expect(describeOAuthResult({ error: "pinterest_no_boards", success: null })).toMatchObject({
      variant: "danger",
      message:
        "This Pinterest account has no board we can post to, and every Pin goes on a board. Create a board on Pinterest (not a secret one), then click Connect again.",
    });
  });

  it("saying no on Pinterest's screen reads as a cancellation", () => {
    expect(describeOAuthResult({ error: "pinterest_access_denied", success: null })?.message).toBe(
      "You cancelled the Pinterest authorization — nothing was connected. Click Connect to try again.",
    );
  });

  it("a successful connect names Pinterest", () => {
    expect(describeOAuthResult({ error: null, success: "pinterest_connected" })).toMatchObject({
      variant: "success",
      message: "Pinterest connected.",
    });
  });
});

// The setup-guide link under a Settings error (/help#<anchor>) needs to know
// which platform failed.
describe("describeOAuthResult — which platform it was", () => {
  it("carries the platform for a specific error code", () => {
    expect(describeOAuthResult({ error: "linkedin_no_admin_pages", success: null })?.platform).toBe(
      "linkedin",
    );
    expect(describeOAuthResult({ error: "pinterest_no_boards", success: null })?.platform).toBe(
      "pinterest",
    );
  });

  it("carries the platform for every generic <platform>_connect_failed code", () => {
    for (const platform of [
      "facebook_page",
      "google_business_profile",
      "instagram",
      "linkedin",
      "pinterest",
      "tiktok",
      "x",
      "youtube",
    ] as const) {
      expect(
        describeOAuthResult({ error: `${platform}_connect_failed`, success: null })?.platform,
      ).toBe(platform);
    }
  });

  it("picks the longest matching platform key", () => {
    expect(
      describeOAuthResult({ error: "google_business_profile_access_denied", success: null })
        ?.platform,
    ).toBe("google_business_profile");
  });

  it("carries null when the code names no platform", () => {
    expect(describeOAuthResult({ error: "access_denied", success: null })?.platform).toBeNull();
    expect(
      describeOAuthResult({ error: "oauth_session_mismatch", success: null })?.platform,
    ).toBeNull();
  });

  it("carries the platform on success too", () => {
    expect(describeOAuthResult({ error: null, success: "x_connected" })?.platform).toBe("x");
  });

  it("reads past an empty error to the success code", () => {
    expect(describeOAuthResult({ error: "", success: "x_connected" })).toEqual({
      variant: "success",
      message: "X connected.",
      platform: "x",
    });
  });
});

describe("describeOAuthResult — session binding and connect-failure codes", () => {
  const ALL_PLATFORMS: Array<[string, string]> = [
    ["facebook_page", "Facebook Page"],
    ["google_business_profile", "Google Business Profile"],
    ["instagram", "Instagram"],
    ["linkedin", "LinkedIn"],
    ["tiktok", "TikTok"],
    ["x", "X"],
    ["youtube", "YouTube"],
  ];

  it("explains oauth_session_mismatch (callback finished under a different signed-in account)", () => {
    expect(describeOAuthResult({ error: "oauth_session_mismatch", success: null })).toMatchObject({
      variant: "danger",
      message:
        "That connection was started from a different account. Sign in to the account you want to connect and try again.",
    });
  });

  it("maps every <platform>_not_configured code to a label-aware 'not available yet' message", () => {
    for (const [platform, label] of ALL_PLATFORMS) {
      expect(
        describeOAuthResult({ error: `${platform}_not_configured`, success: null }),
      ).toMatchObject({
        variant: "danger",
        message: `Connecting ${label} isn't available yet. Please try again later.`,
      });
    }
  });

  it("falls back gracefully for an unprefixed not_configured code", () => {
    expect(describeOAuthResult({ error: "not_configured", success: null })).toMatchObject({
      variant: "danger",
      message: "Connecting this account isn't available yet. Please try again later.",
    });
  });

  // <platform>_connect_failed is the callbacks' unexpected-error code
  // (network/parse/DB): a transient failure, so the generic "couldn't be
  // connected. Please try again." copy is the intended message.
  it("maps every <platform>_connect_failed code to the label-aware try-again message", () => {
    for (const [platform, label] of ALL_PLATFORMS) {
      expect(describeOAuthResult({ error: `${platform}_connect_failed`, success: null })).toMatchObject({
        variant: "danger",
        message: `${label} couldn't be connected. Please try again.`,
      });
    }
  });
});

// R28 (new-customer L6, platform-clients L2 and L3, pages L4): a refused
// Google permission names the control the page shows for that platform.
describe("describeOAuthResult — a missing Google permission names the control on the page", () => {
  const youtubeUpload = (shown: ShownControl) =>
    describeOAuthResult({ error: "youtube_upload_not_allowed", success: null }, { shown: () => shown })?.message;

  it("YouTube upload, no connection: Connect", () => {
    expect(youtubeUpload("connect")).toBe(
      "YouTube wasn't connected: the permission to upload videos wasn't allowed. Click Connect again and, on Google's screen, allow \"Manage your YouTube videos\".",
    );
  });

  it("YouTube upload, a row showing Reconnect: Reconnect, never Connect", () => {
    expect(youtubeUpload("reconnect")).toBe(
      "YouTube wasn't reconnected: the permission to upload videos wasn't allowed. Click Reconnect and, on Google's screen, allow \"Manage your YouTube videos\".",
    );
  });

  it("YouTube upload, a working row: nothing changed, no control named", () => {
    const message = youtubeUpload("connected");
    expect(message).toBe("Nothing changed: the permission to upload videos wasn't allowed, and YouTube stays connected as before.");
  });

  it("YouTube without View your YouTube account: its own sentence, for each control", () => {
    const readonly = (shown: ShownControl) =>
      describeOAuthResult({ error: "youtube_readonly_not_allowed", success: null }, { shown: () => shown });
    expect(readonly("connect")).toEqual({
      variant: "danger",
      platform: "youtube",
      message:
        "YouTube wasn't connected: the permission to see your YouTube account wasn't allowed. Click Connect again and, on Google's screen, allow \"View your YouTube account\".",
    });
    expect(readonly("reconnect")?.message).toMatch(/Click Reconnect and, on Google's screen, allow "View your YouTube account"\.$/);
    expect(describeOAuthResult({ error: "youtube_readonly_not_allowed", success: null })?.message).toMatch(/Click Connect again/);
  });

  it("the shown control is asked for the platform the code names", () => {
    const asked: string[] = [];
    describeOAuthResult(
      { error: "google_business_profile_permission_missing", success: null },
      { shown: (platform) => (asked.push(platform), "connected") },
    );
    expect(asked).toEqual(["google_business_profile"]);
  });

  it("Business Profile: Reconnect when the card shows it, Connect with no connection, the sign-in link otherwise", () => {
    const gbp = (shown: ShownControl) =>
      describeOAuthResult({ error: "google_business_profile_permission_missing", success: null }, { shown: () => shown })?.message;
    const lead = "Google didn't give Vibe Socials access to your Business Profile, so nothing changed.";
    const allow = "on Google's screen, allow access to your Business Profile.";
    expect(gbp("reconnect")).toBe(`${lead} Click Reconnect on the Google Business Profile card and, ${allow}`);
    expect(gbp("connect")).toBe(`${lead} Click Connect on the Google Business Profile card and, ${allow}`);
    expect(gbp("connected")).toBe(`${lead} Sign in to Google again from the Google Business Profile card and, ${allow}`);
  });
});

describe("shownControl", () => {
  it("none: connect; flagged or ending soon: reconnect; working: connected", () => {
    expect(shownControl(undefined)).toBe("connect");
    expect(shownControl(null)).toBe("connect");
    expect(shownControl({ needsReconnect: true })).toBe("reconnect");
    expect(shownControl({ needsReconnect: false, reconnectSoon: true })).toBe("reconnect");
    expect(shownControl({ needsReconnect: false })).toBe("connected");
    expect(shownControl({ needsReconnect: false, reconnectSoon: false })).toBe("connected");
  });
});

// R29 OO1 (pages L5): a cancelled Reconnect on a flagged card said "Click
// Connect to try again", and that card shows Reconnect. Every sentence that
// names the sign-in button takes it from the row the page shows.
describe("describeOAuthResult — every sentence names only the button the row shows", () => {
  const CODES = [
    "linkedin_no_admin_pages",
    "facebook_page_no_pages",
    "instagram_no_instagram_account",
    "youtube_no_channel",
    "pinterest_no_boards",
    "x_workspace_changed",
    "youtube_workspace_changed",
    "x_auth_denied",
    "youtube_oauth_denied",
    "linkedin_auth_failed",
    "pinterest_access_denied",
    "google_business_profile_access_denied",
    "tiktok_access_denied",
    "x_invalid_state",
    "instagram_missing_code_or_state",
    "tiktok_not_workspace_owner",
    "youtube_not_configured",
    "youtube_connect_failed",
    "youtube_upload_not_allowed",
    "youtube_readonly_not_allowed",
    "google_business_profile_permission_missing",
    "oauth_session_mismatch",
  ];
  const STATES: ShownControl[] = ["connect", "reconnect", "connected"];
  const describe_ = (code: string, shown: ShownControl) =>
    describeOAuthResult({ error: code, success: null }, { shown: () => shown })!.message;

  it.each(CODES.flatMap((code) => STATES.map((shown) => [code, shown] as const)))("%s with a row showing %s", (code, shown) => {
    const message = describe_(code, shown);
    if (shown !== "connect") expect(message).not.toMatch(/\bConnect\b/);
    if (shown !== "reconnect") expect(message).not.toMatch(/\bReconnect\b/);
    // A sign-in that fails or is cancelled saves nothing, so a row that had a
    // connection keeps it: never "nothing was connected" there.
    if (shown !== "connect") expect(message).not.toMatch(/nothing was connected|wasn't connected/);
  });

  it("R30: a cancelled Facebook Page or Business Profile Reconnect is a cancellation of that platform", () => {
    expect(describe_("facebook_page_access_denied", "reconnect")).toBe(
      "You cancelled the Facebook Page authorization — your Facebook Page connection is unchanged. Click Reconnect to try again.",
    );
    expect(describe_("google_business_profile_access_denied", "connected")).toBe(
      "You cancelled the Google Business Profile authorization — your Google Business Profile connection is unchanged.",
    );
    expect(describe_("google_business_profile_invalid_state", "reconnect")).toBe(
      "We couldn't reconnect Google Business Profile, so your Google Business Profile connection is unchanged. Click Reconnect to try again.",
    );
    // A provider code that isn't short and plain reads as a failure, never a cancellation.
    expect(describe_("instagram_provider_error", "reconnect")).toBe(
      "We couldn't reconnect Instagram, so your Instagram connection is unchanged. Click Reconnect to try again.",
    );
  });

  // Lead review: the Pinterest callback sends pinterest_auth_failed for a
  // provider code it won't pass on; LinkedIn's "no" is its user_cancelled_* code.
  it("R30: pinterest_auth_failed is a failed sign-in, not a cancel; pinterest_access_denied is a cancel", () => {
    expect(describe_("pinterest_auth_failed", "reconnect")).toBe(
      "We couldn't reconnect Pinterest, so your Pinterest connection is unchanged. Click Reconnect to try again.",
    );
    expect(describe_("pinterest_auth_failed", "connect")).toBe("Pinterest couldn't be connected. Please try again.");
    expect(describe_("pinterest_access_denied", "connect")).toBe(
      "You cancelled the Pinterest authorization — nothing was connected. Click Connect to try again.",
    );
    expect(describe_("linkedin_user_cancelled_login", "connect")).toBe(
      "You cancelled the LinkedIn authorization — nothing was connected. Click Connect to try again.",
    );
  });

  it("a cancelled Reconnect: the existing connection is unchanged, and Reconnect tries again", () => {
    expect(describe_("youtube_oauth_denied", "reconnect")).toBe(
      "You cancelled the YouTube authorization — your YouTube connection is unchanged. Click Reconnect to try again.",
    );
    expect(describe_("youtube_oauth_denied", "connected")).toBe(
      "You cancelled the YouTube authorization — your YouTube connection is unchanged.",
    );
    expect(describe_("youtube_oauth_denied", "connect")).toBe(
      "You cancelled the YouTube authorization — nothing was connected. Click Connect to try again.",
    );
  });

  it("a failed Reconnect: the fix, then Reconnect, and the existing connection is unchanged", () => {
    expect(describe_("pinterest_no_boards", "reconnect")).toBe(
      "This Pinterest account has no board we can post to, and every Pin goes on a board. Create a board on Pinterest (not a secret one), then click Reconnect. Your existing connection is unchanged.",
    );
    expect(describe_("youtube_no_channel", "connected")).toBe(
      "This Google account has no YouTube channel. Create a channel on YouTube, or sign in with the Google account that owns your channel. Your existing connection is unchanged.",
    );
  });

  // R29 OO1 lead follow-up 3: every sign-in that failed or was cancelled
  // with a row present says the row's connection is unchanged and names the
  // button the row shows (none on a working row), on Settings as on /c.
  // Left out, with why: the Google permission codes (their own "wasn't
  // reconnected" sentence, R28), another workspace's tab (refused before any
  // sign-in), owner-only, not configured and session mismatch (no sign-in of
  // this row's ran).
  const FAILURE_CODES = [
    "linkedin_no_admin_pages",
    "facebook_page_no_pages",
    "instagram_no_instagram_account",
    "youtube_no_channel",
    "pinterest_no_boards",
    "x_auth_denied",
    "youtube_oauth_denied",
    "linkedin_auth_failed",
    "pinterest_access_denied",
    "google_business_profile_access_denied",
    "tiktok_access_denied",
    "x_invalid_state",
    "instagram_missing_code_or_state",
    "youtube_connect_failed",
    "tiktok_token_exchange_failed",
    // R30 (platform-clients L1): the callbacks' own codes, now with the platform in front.
    "facebook_page_access_denied",
    "instagram_access_denied",
    "google_business_profile_invalid_state",
    "google_business_profile_missing_code_or_state",
    "google_business_profile_token_exchange_failed",
    "tiktok_missing_code_or_state",
  ];
  it.each(FAILURE_CODES.flatMap((code) => (["reconnect", "connected"] as const).map((shown) => [code, shown] as const)))(
    "%s with a row showing %s: unchanged, and only the shown button",
    (code, shown) => {
      const message = describe_(code, shown);
      expect(message).toMatch(/connection is unchanged/);
      if (shown === "reconnect") expect(message).toMatch(/\b[Cc]lick Reconnect\b/);
      else expect(message).not.toMatch(/\b(Re)?[Cc]onnect\b(?! connection)/);
    },
  );

  it("a failed Reconnect (transient or not secure) on Settings", () => {
    expect(describe_("youtube_connect_failed", "reconnect")).toBe(
      "We couldn't reconnect YouTube, so your YouTube connection is unchanged. Click Reconnect to try again.",
    );
    expect(describe_("x_invalid_state", "connected")).toBe("We couldn't reconnect X, so your X connection is unchanged.");
    // With no row, as before.
    expect(describe_("youtube_connect_failed", "connect")).toBe("YouTube couldn't be connected. Please try again.");
    expect(describe_("linkedin_missing_params", "connect")).toBe(
      "The LinkedIn sign-in couldn't be completed securely. Please try connecting again.",
    );
  });

  it("another workspace's tab: the button this page shows for it", () => {
    expect(describe_("x_workspace_changed", "reconnect")).toBe(
      "That tab was for another workspace, so nothing changed. This page shows the workspace you are in now: click Reconnect to reconnect it here.",
    );
    expect(describe_("x_workspace_changed", "connected")).toBe(
      "That tab was for another workspace, so nothing changed. This page shows the workspace you are in now, where it is already connected.",
    );
  });

  it("the button's name is written in one place in the file", () => {
    const source = readFileSync(fileURLToPath(new URL("./oauthResult.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const helper = source.slice(source.indexOf("export function signInButton("), source.indexOf("export type GooglePermissionCode"));
    const elsewhere = source.replace(helper, "");
    expect(helper).toMatch(/"Connect"/);
    expect(elsewhere).not.toMatch(/\b(Re)?[Cc]onnect again\b|[Cc]lick (Re)?Connect|[Pp]ress (Re)?Connect|"(Re)?Connect"/);
  });
});

// R53 client-journey: one rule for Settings and /c.
// R54 client-journey L1: a refused sign-in over a working row.
describe("differentAccountKeptMessage", () => {
  it("says nothing changed and names the platform and the connected account", () => {
    expect(differentAccountKeptMessage("youtube", "Surf Co channel")).toBe("Nothing changed: YouTube stays connected as Surf Co channel.");
    expect(differentAccountKeptMessage("x", "@surfco")).toBe("Nothing changed: X stays connected as @surfco.");
  });
});

describe("differentAccountBanner", () => {
  it("told only while the platform's row shows Reconnect", () => {
    expect(differentAccountBanner("instagram_different_account", () => "reconnect")).toEqual({ platform: "instagram", told: true });
    expect(differentAccountBanner("instagram_different_account", () => "connected")).toEqual({ platform: "instagram", told: false });
    expect(differentAccountBanner("instagram_different_account", () => "connect")).toEqual({ platform: "instagram", told: false });
  });

  it("null for any other code", () => {
    expect(differentAccountBanner("instagram_access_denied", () => "reconnect")).toBeNull();
    expect(differentAccountBanner(null, () => "reconnect")).toBeNull();
    expect(differentAccountBanner(undefined, () => "reconnect")).toBeNull();
  });
});
