import { describe, expect, it } from "vitest";
import { describeOAuthResult } from "./oauthResult";

describe("describeOAuthResult", () => {
  it("returns null when neither param is present", () => {
    expect(describeOAuthResult({ error: null, success: null })).toBeNull();
  });

  it("maps a success code to a success message with the platform label", () => {
    expect(describeOAuthResult({ error: null, success: "youtube_connected" })).toEqual({
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
});

// Coverage for the literal codes actually emitted today by the 7 routes at
// src/app/api/auth/*/callback/route.ts. The grep suggested in the task brief
// (grep -rho "settings?[a-z_=&]*" ...) only catches routes that build the
// redirect as one literal string; several routes instead build the URL via
// `new URL(...).searchParams.set("error", "<code>")`, so this list was
// compiled by reading all 7 route files directly.
describe("describeOAuthResult — real callback-route codes", () => {
  it("maps every platform's real *_connected success code to its label", () => {
    expect(describeOAuthResult({ error: null, success: "facebook_page_connected" })).toEqual({
      variant: "success",
      message: "Facebook connected.",
    });
    expect(
      describeOAuthResult({ error: null, success: "google_business_profile_connected" }),
    ).toEqual({
      variant: "success",
      message: "Google Business Profile connected.",
    });
    expect(describeOAuthResult({ error: null, success: "instagram_connected" })).toEqual({
      variant: "success",
      message: "Instagram connected.",
    });
    expect(describeOAuthResult({ error: null, success: "linkedin_connected" })).toEqual({
      variant: "success",
      message: "LinkedIn connected.",
    });
    expect(describeOAuthResult({ error: null, success: "tiktok_connected" })).toEqual({
      variant: "success",
      message: "TikTok connected.",
    });
    expect(describeOAuthResult({ error: null, success: "x_connected" })).toEqual({
      variant: "success",
      message: "X connected.",
    });
    expect(describeOAuthResult({ error: null, success: "youtube_connected" })).toEqual({
      variant: "success",
      message: "YouTube connected.",
    });
  });

  it("resolves X's real denial code (x_auth_denied) to a cancelled X message", () => {
    const result = describeOAuthResult({ error: "x_auth_denied", success: null });
    expect(result).toEqual({
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
      "facebook_page_unexpected_error",
      "facebook_page_token_exchange_failed",
      "tiktok_unexpected_error",
      "tiktok_not_configured",
      "x_unexpected_error",
      "x_session_expired",
      "youtube_db_error",
      "youtube_no_channel",
      "linkedin_config_missing",
      "linkedin_token_exchange_failed",
      "google_business_profile_not_configured",
    ]) {
      const result = describeOAuthResult({ error, success: null });
      expect(result?.variant).toBe("danger");
      expect(result?.message).toContain("couldn't be connected");
    }
  });

  // LinkedIn's own "user declined the authorization" redirect uses a fixed
  // linkedin_auth_failed code (src/app/api/auth/linkedin/callback/route.ts),
  // not a "*_denied" code, so it lands in the generic bucket rather than the
  // "cancelled" bucket. Still a correctly-labeled, valid danger message.
  it("resolves LinkedIn's own denial code (linkedin_auth_failed) to a generic LinkedIn message", () => {
    const result = describeOAuthResult({ error: "linkedin_auth_failed", success: null });
    expect(result?.variant).toBe("danger");
    expect(result?.message).toContain("LinkedIn");
    expect(result?.message).toContain("couldn't be connected");
  });

  // facebook_page, instagram, google_business_profile, and tiktok forward the
  // OAuth provider's own `error` value verbatim and unprefixed (e.g. Google's
  // and Facebook's callbacks redirect with `error=access_denied` when the
  // user declines). google_business_profile and instagram additionally
  // redirect a few internal failure branches (missing_code_or_state,
  // invalid_state, unexpected_error/token_exchange_failed) unprefixed. None
  // of these carry a platform prefix, so the platform can't be identified and
  // the "The account" fallback label is used instead of a platform name.
  it("falls back to the generic account label for real unprefixed codes", () => {
    for (const error of ["missing_code_or_state", "unexpected_error"]) {
      const result = describeOAuthResult({ error, success: null });
      expect(result).toEqual({
        variant: "danger",
        message: "The account couldn't be connected. Please try again.",
      });
    }
  });

  // Known copy quirk (pre-existing in this task's brief, not introduced or
  // fixed here): the "missing_params"/"invalid_state" template already
  // supplies its own leading "The ", and so does the "denied" template's
  // "the ", so pairing either with the fallback label (itself "The account")
  // doubles the article. Recorded here so a future copy pass has a concrete
  // repro instead of rediscovering it from scratch.
  it("still recognizes the real unprefixed invalid_state code (documents the doubled-article fallback text)", () => {
    const result = describeOAuthResult({ error: "invalid_state", success: null });
    expect(result).toEqual({
      variant: "danger",
      message:
        "The The account sign-in couldn't be completed securely. Please try connecting again.",
    });
  });
});
