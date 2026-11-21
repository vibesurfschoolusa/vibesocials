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
import { differentAccountKeptMessage } from "./oauthResult";
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
  // R52 client-journey L1 / pages-a L2: someone who manages the Page but left
  // it unticked in Facebook's list signed in rightly; ticking it is the step.
  it("Settings, a Facebook Page not offered in the list: sign in with an account that manages it, and tick it", () => {
    expect(settingsDifferentAccountMessage("facebook_page", "Client Cafe", "My Surf School")).toBe(
      "You chose Client Cafe; My Surf School wasn't listed. To reconnect it, sign in with a Facebook account that manages My Surf School and tick it when Facebook lists the Pages, or use Switch account to change to Client Cafe.",
    );
    expect(choiceDifferentAccountMessage("facebook_page", "Client Cafe", "My Surf School", false, "reconnect")).toBe(
      settingsDifferentAccountMessage("facebook_page", "Client Cafe", "My Surf School"),
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
  it("Settings, LinkedIn: names the sign-out step, then an account that is a Super admin of the page", () => {
    expect(reconnectDifferentAccountMessage("linkedin", "Surf Co page")).toBe(
      "LinkedIn connected a different page than Surf Co page, so nothing changed. Sign out of LinkedIn first (Reconnect shows the steps), then sign in with a LinkedIn account that is a Super admin of Surf Co page. To use the other page instead, use Switch account.",
    );
  });

  it("Settings, Facebook Page: an account that manages the Page, and tick it", () => {
    expect(reconnectDifferentAccountMessage("facebook_page", "Surf Co Page")).toBe(
      "Facebook connected a different page than Surf Co Page, so nothing changed. To reconnect it, sign in with a Facebook account that manages Surf Co Page and tick it when Facebook lists the Pages, or use Switch account to change pages.",
    );
  });

  // R51 pages-a L2: Instagram's sign-in is Meta's Facebook login, and the
  // account comes from a Facebook Page linked to it; nobody signs in to it there.
  it("Settings, Instagram, after a refused reconnect: the Facebook sign-in that works", () => {
    expect(reconnectDifferentAccountMessage("instagram", "@surfschool")).toBe(
      "Facebook didn't return the Page linked to @surfschool, so nothing changed. To reconnect it, sign in with a Facebook account that manages that Page and tick it when Facebook lists the Pages (and its Instagram account, if listed), or use Switch account to change accounts.",
    );
  });

  it("Settings, Instagram, not offered in the list: the Facebook sign-in that works", () => {
    const sentence = choiceDifferentAccountMessage("instagram", "@otherbiz", "@surfschool", false, "reconnect");
    expect(sentence).toBe(
      "You chose @otherbiz; @surfschool wasn't listed. To reconnect it, sign in with a Facebook account that manages the Page linked to @surfschool and tick that Page when Facebook lists the Pages (and its Instagram account, if listed), or use Switch account to change to @otherbiz.",
    );
    expect(sentence).not.toMatch(/signed in to @otherbiz|sign in to @surfschool/i);
    // R52 fix review L1: the list shows Instagram accounts, and "offered" is
    // decided by the account's id, so the Page itself may have come back.
    expect(sentence).not.toMatch(/Page linked to @surfschool wasn't/);
  });

  // R52 client-journey L1: the owner's email tells the client to tick the
  // Page; /c told them to have it disconnected, which lets another Page's
  // Instagram be saved silently. The client who manages it gets the same step.
  it("the client's page, Instagram: the tick step first for the one who manages the Page, then the owner", () => {
    expect(linkDifferentAccountMessage("instagram", "@surfschool")).toBe(
      "If you manage the Page linked to @surfschool, press Reconnect, sign in with a Facebook account that manages it and tick it when Facebook lists the Pages (and its Instagram account, if listed). If not, ask the workspace owner to disconnect it, then connect yours.",
    );
  });

  it("the client's page, Facebook Page: the tick step first for the one who manages the page, then the owner", () => {
    expect(linkDifferentAccountMessage("facebook_page", "Surf Co Page")).toBe(
      "If you manage Surf Co Page, press Reconnect, sign in with a Facebook account that manages it and tick it when Facebook lists the Pages. If not, ask the workspace owner to disconnect it, then connect yours.",
    );
  });

  // R7-client-journey L4: the client can't switch it; the owner can disconnect it.
  it("the client's page: says whose it is and what works", () => {
    expect(linkDifferentAccountMessage("youtube", "Surf Co channel")).toBe(
      "This connection belongs to Surf Co channel. Ask the workspace owner to disconnect it in Settings, Connections; then connect your account here.",
    );
  });

  // R58 client-journey L2: a Content admin manages the page but can't connect
  // it, so the step is offered to a Super admin only.
  it("the client's page, LinkedIn: names the sign-out step for a Super admin of the page", () => {
    expect(linkDifferentAccountMessage("linkedin", "Surf Co page")).toBe(
      "This connection posts to Surf Co page. If you are a Super admin of that page, sign out of LinkedIn first (Reconnect shows the steps), then sign in with a LinkedIn account that is a Super admin of Surf Co page. If not, ask the workspace owner to disconnect it in Settings, Connections; then connect your account here.",
    );
  });

  // R52 lead review: a banner is read at a glance, so these stay at 45 words or fewer.
  it("the Facebook Page and Instagram sentences are 45 words or fewer", () => {
    for (const sentence of [
      reconnectDifferentAccountMessage("instagram", "surfschool"),
      reconnectDifferentAccountMessage("facebook_page", "Surf Co Page"),
      choiceDifferentAccountMessage("instagram", "otherbiz", "surfschool", false, "reconnect"),
      choiceDifferentAccountMessage("facebook_page", "Client Cafe", "Surf Co Page", false, "reconnect"),
      linkDifferentAccountMessage("instagram", "surfschool"),
      linkDifferentAccountMessage("facebook_page", "Surf Co Page"),
    ]) {
      expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(45);
    }
  });

  it("no sentence tells anyone to sign in to a LinkedIn page", () => {
    for (const sentence of [
      reconnectDifferentAccountMessage("linkedin", "Surf Co page"),
      linkDifferentAccountMessage("linkedin", "Surf Co page"),
      choiceDifferentAccountMessage("linkedin", "Client Cafe", "Surf Co page", false, "reconnect"),
      linkedInReconnectSignInStep("Surf Co page"),
    ]) {
      expect(sentence).not.toMatch(/sign in to Surf Co page/i);
    }
  });

  it("the Reconnect steps' sign-in line names an account that is a Super admin of the page", () => {
    expect(linkedInReconnectSignInStep("Surf Co page")).toBe(
      "Come back here and click Continue. LinkedIn asks you to sign in: sign in with a LinkedIn account that is a Super admin of Surf Co page.",
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
    expect(choiceDifferentAccountMessage("facebook_page", "Client Cafe", "My Surf School", true, "reconnect")).toBe(
      "You chose Client Cafe, not My Surf School. Choose My Surf School to reconnect it, or use Switch account to change to Client Cafe.",
    );
    expect(choiceDifferentAccountMessage("linkedin", "Client Cafe", "My Surf School", true, "reconnect")).toBe(
      "You chose Client Cafe, not My Surf School. Choose My Surf School to reconnect it, or use Switch account to change to Client Cafe.",
    );
  });

  it("Settings, LinkedIn, not offered (another member signed in): the sign-out step", () => {
    expect(choiceDifferentAccountMessage("linkedin", "Client Cafe", "My Surf School", false, "reconnect")).toBe(
      reconnectDifferentAccountMessage("linkedin", "My Surf School"),
    );
  });

  it("Settings, another platform, not offered: as before", () => {
    expect(choiceDifferentAccountMessage("pinterest", "Team photos", "My Surf School", false, "reconnect")).toBe(
      settingsDifferentAccountMessage("pinterest", "Team photos", "My Surf School"),
    );
  });

  // R55 client-journey L1: a stale tab's Connect is refused over a working
  // row, which shows Switch account and no Reconnect: the kept wording, as in
  // Settings' banner (differentAccountKeptMessage), for an owner.
  it("Settings, a working row, not offered: nothing changed, and Switch account", () => {
    expect(choiceDifferentAccountMessage("linkedin", "Client Cafe", "Surf Co page", false, "connected")).toBe(
      "Nothing changed: LinkedIn stays connected as Surf Co page. To connect a different account instead, use Switch account.",
    );
    expect(choiceDifferentAccountMessage("facebook_page", "Client Cafe", "My Surf School", false, "connected")).toBe(
      "Nothing changed: Facebook Page stays connected as My Surf School. To connect a different account instead, use Switch account.",
    );
    expect(choiceDifferentAccountMessage("x", "@other", "@surfco", false, "connected")).toBe(
      "Nothing changed: X stays connected as @surfco. To connect a different account instead, use Switch account.",
    );
    for (const platform of ["linkedin", "facebook_page", "instagram", "pinterest", "x"] as const) {
      expect(choiceDifferentAccountMessage(platform, "Other", "Mine", false, "connected"), platform).toBe(
        differentAccountKeptMessage(platform, "Mine", true),
      );
    }
  });

  it("a Reconnect row, not offered: the reconnect wording, as before", () => {
    expect(choiceDifferentAccountMessage("linkedin", "Client Cafe", "Surf Co page", false, "reconnect")).toBe(
      reconnectDifferentAccountMessage("linkedin", "Surf Co page"),
    );
    expect(choiceDifferentAccountMessage("facebook_page", "Client Cafe", "My Surf School", false, "reconnect")).toBe(
      settingsDifferentAccountMessage("facebook_page", "Client Cafe", "My Surf School"),
    );
  });

  it("offered: choose it, whatever the row shows", () => {
    for (const shown of ["reconnect", "connected"] as const) {
      expect(choiceDifferentAccountMessage("linkedin", "Client Cafe", "My Surf School", true, shown), shown).toBe(
        "You chose Client Cafe, not My Surf School. Choose My Surf School to reconnect it, or use Switch account to change to Client Cafe.",
      );
    }
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

  // R52 client-journey L1: the link choice's 409 carries the tick step when the Page wasn't offered.
  // R52 fix review L1: the client's 409 when the Instagram account wasn't
  // offered claims nothing about the Page; it gives the step.
  it("the client's page, Instagram not offered: no claim the Page was missing, the full step", () => {
    const sentence = linkChoiceDifferentAccountMessage("instagram", "@surfschool", false);
    expect(sentence).not.toMatch(/wasn't listed|didn't return/);
    expect(sentence).toContain(
      "If you manage the Page linked to @surfschool, press Reconnect, sign in with a Facebook account that manages it and tick it when Facebook lists the Pages (and its Instagram account, if listed).",
    );
  });

  it("the client's page, Instagram and Facebook Page: offered, choose it; not offered, the tick step", () => {
    for (const platform of ["instagram", "facebook_page"] as const) {
      expect(linkChoiceDifferentAccountMessage(platform, "surfschool", true)).toBe(
        "Choose surfschool from the list, or ask the workspace owner to disconnect it first.",
      );
      const notOffered = linkChoiceDifferentAccountMessage(platform, "surfschool", false);
      expect(notOffered).toBe(linkDifferentAccountMessage(platform, "surfschool"));
      expect(notOffered).toContain("press Reconnect, sign in with a Facebook account that manages it and tick it when Facebook lists the Pages");
    }
  });
});


// R8-pages L5: the row reads the kept end date from a prop, never from the address.
describe("no address reading for the same-end row", () => {
  it("has no sameEndAddress", () => {
    expect("sameEndAddress" in differentAccount).toBe(false);
  });
});

// R57 pages-a-3 L1: LinkedIn's callback accepts only pages the account is a
// Super admin of, so its sign-in step says so; other platforms keep theirs.
describe("signInTo: who has to sign in", () => {
  it("LinkedIn: an account that is a Super admin of the page", async () => {
    const { signInTo } = await import("./differentAccount");
    expect(signInTo("linkedin", "Surf Co page")).toBe("sign in with a LinkedIn account that is a Super admin of Surf Co page");
  });

  it("Facebook, Instagram and a platform with no page keep their words", async () => {
    const { signInTo } = await import("./differentAccount");
    expect(signInTo("facebook_page", "Surf Co")).toBe(
      "sign in with a Facebook account that manages Surf Co and tick it when Facebook lists the Pages",
    );
    expect(signInTo("instagram", "@surfco")).toBe(
      "sign in with a Facebook account that manages the Page linked to @surfco and tick that Page when Facebook lists the Pages (and its Instagram account, if listed)",
    );
    expect(signInTo("x", "@surfco")).toBe("sign in to @surfco");
  });
});
