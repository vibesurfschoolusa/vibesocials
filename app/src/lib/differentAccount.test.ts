import { describe, expect, it } from "vitest";

import {
  connectedAccountName,
  differentAccountCode,
  differentAccountPlatform,
  linkDifferentAccountMessage,
  settingsDifferentAccountMessage,
  signedInNameFromQuery,
} from "./differentAccount";

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

  it("the client's page: names the connected account and who can switch it", () => {
    expect(linkDifferentAccountMessage("linkedin", "Surf Co page")).toBe(
      "You signed in to a different LinkedIn account than the one connected (Surf Co page). Sign in to that account, or ask the workspace owner to switch it.",
    );
  });

  it("names a connection by what Settings shows, with a plain fallback", () => {
    expect(connectedAccountName({ platform: "linkedin", username: "Surf Co page", accountIdentifier: "sub" })).toBe("Surf Co page");
    expect(connectedAccountName({ platform: "x", username: null, accountIdentifier: "12345" })).toBe("12345");
    expect(connectedAccountName({ platform: "google_business_profile", username: null, accountIdentifier: "" })).toBe(
      "the connected Google Business Profile account",
    );
  });

  it("reads the signed-in name from the address, trimmed and capped, with a plain fallback", () => {
    expect(signedInNameFromQuery("  Other Co  ", "youtube")).toBe("Other Co");
    expect(signedInNameFromQuery("x".repeat(300), "youtube")).toHaveLength(100);
    expect(signedInNameFromQuery(null, "youtube")).toBe("a different YouTube account");
    expect(signedInNameFromQuery(["Other Co", "Second"], "youtube")).toBe("Other Co");
  });
});
