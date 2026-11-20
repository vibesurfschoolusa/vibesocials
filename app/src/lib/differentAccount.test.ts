import { describe, expect, it } from "vitest";

import {
  accountCheckFailedMessage,
  accountCheckFailedPlatform,
  connectedAccountName,
  differentAccountCode,
  differentAccountPlatform,
  linkDifferentAccountMessage,
  refusedSaveSettingsUrl,
  choiceDifferentAccountMessage,
  connectedAmongCandidates,
  linkChoiceDifferentAccountMessage,
  linkedInReconnectSignInStep,
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
    expect(settingsDifferentAccountMessage("pinterest", "Other Co", "Surf Co page")).toBe(
      "You signed in to Other Co, not Surf Co page. Sign in to Surf Co page to reconnect it, or use Switch account to change to Other Co.",
    );
  });

  // R8-pages L1: a Facebook Page is not signed in to; an account that manages it is.
  it("Settings, a Facebook Page not offered in the list: sign in with an account that manages it", () => {
    expect(settingsDifferentAccountMessage("facebook_page", "Client Cafe", "My Surf School")).toBe(
      "You chose Client Cafe, not My Surf School, and My Surf School wasn't in the list. Sign in with a Facebook account that manages My Surf School to reconnect it, or use Switch account to change to Client Cafe.",
    );
  });

  // R7-new-customer L2: the address carries no name; the sentence names only the stored connection.
  it("Settings, after a refused reconnect: names only the connected account", () => {
    expect(reconnectDifferentAccountMessage("youtube", "Surf Co channel")).toBe(
      "You signed in to a different YouTube account than Surf Co channel. Sign in to Surf Co channel to reconnect it, or use Switch account to change accounts.",
    );
  });

  // R7-pages M2: LinkedIn reuses the browser's signed-in account, so signing in to the right one needs a sign-out first.
  // R8-client-journey L2: the stored name is the company page, which nobody signs in to.
  it("Settings, LinkedIn: names the sign-out step, then an account that manages the page", () => {
    expect(reconnectDifferentAccountMessage("linkedin", "Surf Co page")).toBe(
      "LinkedIn connected a different page than Surf Co page, so nothing changed. Sign out of LinkedIn first (Reconnect shows the steps), then sign in with a LinkedIn account that manages Surf Co page. To use the other page instead, use Switch account.",
    );
  });

  it("Settings, Facebook Page: an account that manages the Page", () => {
    expect(reconnectDifferentAccountMessage("facebook_page", "Surf Co Page")).toBe(
      "Facebook connected a different page than Surf Co Page, so nothing changed. Sign in with a Facebook account that manages Surf Co Page to reconnect it, or use Switch account to change pages.",
    );
  });

  // R51 pages-a L2: Instagram's sign-in is Meta's Facebook login, and the
  // account comes from a Facebook Page linked to it; nobody signs in to it there.
  it("Settings, Instagram, after a refused reconnect: the Facebook sign-in that works", () => {
    expect(reconnectDifferentAccountMessage("instagram", "@surfschool")).toBe(
      "Facebook didn't return the Page linked to @surfschool, so nothing changed. Sign in with a Facebook account that manages the Page linked to @surfschool to reconnect it, or use Switch account to change accounts.",
    );
  });

  it("Settings, Instagram, not offered in the list: the Facebook sign-in that works", () => {
    const sentence = choiceDifferentAccountMessage("instagram", "@otherbiz", "@surfschool", false);
    expect(sentence).toBe(
      "You chose @otherbiz, not @surfschool, and @surfschool wasn't in the list. Sign in with a Facebook account that manages the Page linked to @surfschool to reconnect it, or use Switch account to change to @otherbiz.",
    );
    expect(sentence).not.toMatch(/signed in to @otherbiz|sign in to @surfschool/i);
  });

  it("the client's page, Instagram: says whose it is, as on every other platform", () => {
    expect(linkDifferentAccountMessage("instagram", "@surfschool")).toBe(
      "This connection belongs to @surfschool. Ask the workspace owner to disconnect it in Settings, Connections; then connect your account here.",
    );
  });

  // R7-client-journey L4: the client can't switch it; the owner can disconnect it.
  it("the client's page: says whose it is and what works", () => {
    expect(linkDifferentAccountMessage("youtube", "Surf Co channel")).toBe(
      "This connection belongs to Surf Co channel. Ask the workspace owner to disconnect it in Settings, Connections; then connect your account here.",
    );
  });

  it("the client's page, LinkedIn: also names the sign-out step for the one who manages the page", () => {
    expect(linkDifferentAccountMessage("linkedin", "Surf Co page")).toBe(
      "This connection posts to Surf Co page. If you manage that page, sign out of LinkedIn first (Reconnect shows the steps), then sign in with a LinkedIn account that manages Surf Co page. If not, ask the workspace owner to disconnect it in Settings, Connections; then connect your account here.",
    );
  });

  it("no sentence tells anyone to sign in to a LinkedIn page", () => {
    for (const sentence of [
      reconnectDifferentAccountMessage("linkedin", "Surf Co page"),
      linkDifferentAccountMessage("linkedin", "Surf Co page"),
      choiceDifferentAccountMessage("linkedin", "Client Cafe", "Surf Co page", false),
      linkedInReconnectSignInStep("Surf Co page"),
    ]) {
      expect(sentence).not.toMatch(/sign in to Surf Co page/i);
    }
  });

  it("the Reconnect steps' sign-in line names an account that manages the page", () => {
    expect(linkedInReconnectSignInStep("Surf Co page")).toBe(
      "Come back here and click Continue. LinkedIn asks you to sign in: sign in with a LinkedIn account that manages Surf Co page.",
    );
  });

  it("names a connection by what Settings shows, with a plain fallback", () => {
    expect(connectedAccountName({ platform: "linkedin", username: "Surf Co page", accountIdentifier: "sub" })).toBe("Surf Co page");
    // R8-client-journey L2: a LinkedIn identifier is the member's opaque profile id, never shown.
    expect(connectedAccountName({ platform: "linkedin", username: null, accountIdentifier: "aB3xYz9q" })).toBe(
      "the connected LinkedIn page",
    );
    // R8 review: a Facebook Page's identifier is its numeric id, never shown either.
    expect(connectedAccountName({ platform: "facebook_page", username: null, accountIdentifier: "102938475610" })).toBe(
      "the connected Facebook Page",
    );
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
    // R27 lead review: a missing permission has its own code (worded in oauthResult.ts and connectLink.ts).
    const permission = refusedSaveSettingsUrl("https://app.example.com", "google_business_profile", { reason: "permission_missing" });
    expect(permission.toString()).toBe("https://app.example.com/settings?error=google_business_profile_permission_missing");
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

// R7 review 3: a choice from a list (Pages, Instagram accounts, LinkedIn
// pages, boards) that included the connected one: the way forward is to choose it.
describe("a refused choice from a list", () => {
  it("knows whether the connected account was on the list", () => {
    expect(connectedAmongCandidates([{ id: "page-1" }, { id: "page-2" }], "page-1")).toBe(true);
    expect(connectedAmongCandidates([{ id: "page-2" }], "page-1")).toBe(false);
    expect(connectedAmongCandidates([{ id: "page-2" }], null)).toBe(false);
  });

  it("Settings, the connected one was offered: choose it", () => {
    expect(choiceDifferentAccountMessage("facebook_page", "Client Cafe", "My Surf School", true)).toBe(
      "You chose Client Cafe, not My Surf School. Choose My Surf School to reconnect it, or use Switch account to change to Client Cafe.",
    );
    expect(choiceDifferentAccountMessage("linkedin", "Client Cafe", "My Surf School", true)).toBe(
      "You chose Client Cafe, not My Surf School. Choose My Surf School to reconnect it, or use Switch account to change to Client Cafe.",
    );
  });

  it("Settings, LinkedIn, not offered (another member signed in): the sign-out step", () => {
    expect(choiceDifferentAccountMessage("linkedin", "Client Cafe", "My Surf School", false)).toBe(
      reconnectDifferentAccountMessage("linkedin", "My Surf School"),
    );
  });

  it("Settings, another platform, not offered: as before", () => {
    expect(choiceDifferentAccountMessage("pinterest", "Team photos", "My Surf School", false)).toBe(
      settingsDifferentAccountMessage("pinterest", "Team photos", "My Surf School"),
    );
  });

  it("the client's page, offered: choose it from the list", () => {
    expect(linkChoiceDifferentAccountMessage("facebook_page", "My Surf School", true)).toBe(
      "Choose My Surf School from the list, or ask the workspace owner to disconnect it first.",
    );
  });

  it("the client's page, not offered: the different-account sentence", () => {
    expect(linkChoiceDifferentAccountMessage("linkedin", "My Surf School", false)).toBe(
      linkDifferentAccountMessage("linkedin", "My Surf School"),
    );
  });
});


// R8-pages L5: the row reads the kept end date from a prop, never from the address.
describe("no address reading for the same-end row", () => {
  it("has no sameEndAddress", () => {
    expect("sameEndAddress" in differentAccount).toBe(false);
  });
});
