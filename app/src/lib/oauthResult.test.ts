import { describe, expect, it } from "vitest";
import { describeOAuthResult } from "./oauthResult";

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
    const result = describeOAuthResult({ error: "tiktok_oauth_denied", success: null });
    expect(result?.variant).toBe("danger");
    expect(result?.message).toContain("TikTok");
    expect(result?.message).toContain("cancelled");
  });

  it("handles platforms whose key contains underscores", () => {
    const result = describeOAuthResult({
      error: "google_business_profile_oauth_denied",
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
      error: "x_oauth_denied",
      success: "x_connected",
    });
    expect(result?.variant).toBe("danger");
  });

  // Team Workspaces (Task 6, design §5): OAuth start/callback routes gate on
  // workspace ownership and redirect `?error=<platform>_not_workspace_owner`
  // when the caller is authenticated but not the workspace owner.
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
      "youtube_no_channel",
      "linkedin_config_missing",
      "linkedin_token_exchange_failed",
      "google_business_profile_connect_failed",
    ]) {
      const result = describeOAuthResult({ error, success: null });
      expect(result?.variant).toBe("danger");
      expect(result?.message).toContain("couldn't be connected");
    }
  });

  // LinkedIn's own "user declined the authorization" redirect uses a fixed
  // linkedin_auth_failed code (src/app/api/auth/linkedin/callback/route.ts)
  // rather than a "*_denied" code. The denied-bucket condition also matches
  // `error.endsWith("auth_failed")` so this still reads as a cancellation
  // instead of a generic failure.
  it("resolves LinkedIn's own denial code (linkedin_auth_failed) to a cancelled LinkedIn message", () => {
    const result = describeOAuthResult({ error: "linkedin_auth_failed", success: null });
    expect(result).toMatchObject({
      variant: "danger",
      message:
        "You cancelled the LinkedIn authorization — nothing was connected. Click Connect to try again.",
    });
  });

  // facebook_page, instagram, google_business_profile, and tiktok forward the
  // OAuth provider's own `error` value verbatim and unprefixed (e.g. Google's
  // and Facebook's callbacks redirect with `error=access_denied` when the
  // user declines). google_business_profile and instagram additionally
  // redirect a few internal failure branches (missing_code_or_state,
  // invalid_state, token_exchange_failed) unprefixed. None
  // of these carry a platform prefix, so the platform can't be identified and
  // the "The account" fallback label is used instead of a platform name.
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
      describeOAuthResult({ error: "google_business_profile_oauth_denied", success: null })
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
