import { describe, expect, it } from "vitest";

import {
  accountCheckFailedMessage,
  accountCheckFailedPlatform,
  connectedAccountName,
  differentAccountCode,
  differentAccountPlatform,
  linkDifferentAccountMessage,
  refusedSaveSettingsUrl,
  locationClearedSettingsMessage,
  reconnectDifferentAccountMessage,
  settingsDifferentAccountMessage,
} from "./differentAccount";
import * as differentAccount from "./differentAccount";

/**
 * R6 review low 1: a reconnect only ever replaces a connection with the same
 * platform account. When a different one comes back nothing changes, and
 * these say what happened and what to do.
 */
describe("different account on reconnect", () => {
  it("has one error code per platform, read back to its platform", () => {
    expect(differentAccountCode("linkedin")).toBe("linkedin_different_account");
    expect(differentAccountPlatform("linkedin_different_account")).toBe("linkedin");
    expect(differentAccountPlatform("google_business_profile_different_account")).toBe("google_business_profile");
    expect(differentAccountPlatform("linkedin_cancelled")).toBeNull();
    expect(differentAccountPlatform("myspace_different_account")).toBeNull();
    expect(differentAccountPlatform(null)).toBeNull();
  });

  it("Settings: names both accounts and both ways forward", () => {
    expect(settingsDifferentAccountMessage("Other Co", "Surf Co page")).toBe(
      "You signed in to Other Co, not Surf Co page. Sign in to Surf Co page to reconnect it, or use Switch account to change to Other Co.",
    );
  });

  // R7-new-customer L2: the address carries no name; the sentence names only the stored connection.
  it("Settings, after a refused reconnect: names only the connected account", () => {
    expect(reconnectDifferentAccountMessage("youtube", "Surf Co channel")).toBe(
      "You signed in to a different YouTube account than Surf Co channel. Sign in to Surf Co channel to reconnect it, or use Switch account to change accounts.",
    );
  });

  // R7-pages M2: LinkedIn reuses the browser's signed-in account, so signing in to the right one needs a sign-out first.
  it("Settings, LinkedIn: names the sign-out step before the sign-in", () => {
    expect(reconnectDifferentAccountMessage("linkedin", "Surf Co page")).toBe(
      "You signed in to a different LinkedIn account than Surf Co page. Sign out of LinkedIn first (Reconnect shows the steps), then sign in to Surf Co page. To use the other account instead, use Switch account.",
    );
  });

  // R7-client-journey L4: the client can't switch it; the owner can disconnect it.
  it("the client's page: says whose it is and what works", () => {
    expect(linkDifferentAccountMessage("youtube", "Surf Co channel")).toBe(
      "This connection belongs to Surf Co channel. Ask the workspace owner to disconnect it in Settings, Connections; then connect your account here.",
    );
  });

  it("the client's page, LinkedIn: also names the sign-out step for the one who owns it", () => {
    expect(linkDifferentAccountMessage("linkedin", "Surf Co page")).toBe(
      "This connection belongs to Surf Co page. If that is your account, sign out of LinkedIn first (Reconnect shows the steps), then sign in to Surf Co page. If not, ask the workspace owner to disconnect it in Settings, Connections; then connect your account here.",
    );
  });

  it("names a connection by what Settings shows, with a plain fallback", () => {
    expect(connectedAccountName({ platform: "linkedin", username: "Surf Co page", accountIdentifier: "sub" })).toBe("Surf Co page");
    expect(connectedAccountName({ platform: "x", username: null, accountIdentifier: "12345" })).toBe("12345");
    expect(connectedAccountName({ platform: "google_business_profile", username: null, accountIdentifier: "" })).toBe(
      "the connected Google Business Profile account",
    );
  });

  it("reads no name from the address any more", () => {
    expect("signedInNameFromQuery" in differentAccount).toBe(false);
    expect("SIGNED_IN_AS_PARAM" in differentAccount).toBe(false);
  });
});

// R6 second review 1: a Business Profile reconnect whose location couldn't be checked.
describe("a reconnect that couldn't be checked", () => {
  it("has its own code per platform, read back to its platform", () => {
    expect(accountCheckFailedPlatform("google_business_profile_account_check_failed")).toBe("google_business_profile");
    expect(accountCheckFailedPlatform("google_business_profile_different_account")).toBeNull();
    expect(accountCheckFailedPlatform(undefined)).toBeNull();
  });

  it("names the location and says to try again", () => {
    expect(accountCheckFailedMessage("Surf Co Dania")).toBe(
      "We couldn't check that this Google account manages Surf Co Dania. Try again in a minute.",
    );
  });

  it("the callback's address for each refusal", () => {
    const different = refusedSaveSettingsUrl("https://app.example.com", "linkedin", { reason: "different_account" });
    expect(different.toString()).toBe("https://app.example.com/settings?error=linkedin_different_account");
    const unchecked = refusedSaveSettingsUrl("https://app.example.com", "google_business_profile", { reason: "check_failed" });
    expect(unchecked.toString()).toBe("https://app.example.com/settings?error=google_business_profile_account_check_failed");
  });
});

// R7-new-customer L2: the cleared-location sentence takes nothing from the address.
describe("a Business Profile reconnect that cleared the location", () => {
  it("one fixed sentence", () => {
    expect(locationClearedSettingsMessage()).toBe(
      "Reconnected. Choose the location to post to; the one chosen before isn't available to this Google account.",
    );
  });
});
