import { describe, expect, it } from "vitest";

import { oauthErrorRedirect } from "./oauthErrorRedirect";

// R30 lead review: the one way an OAuth start or callback route sends the
// browser to Settings with an ?error= code (app/api/auth/oauthErrorCodes.test.ts).
describe("oauthErrorRedirect", () => {
  const location = (response: Response) => new URL(response.headers.get("location") ?? "");

  it("sends the browser to Settings with the code after the platform's name", () => {
    const response = oauthErrorRedirect("google_business_profile", "invalid_state", "https://app.example.com/api/x?y=1");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://app.example.com/settings?error=google_business_profile_invalid_state");
  });

  it("passes a short, plain provider code on and cleans anything else", () => {
    expect(location(oauthErrorRedirect("tiktok", "access_denied", "https://app.example.com")).searchParams.get("error")).toBe(
      "tiktok_access_denied",
    );
    for (const odd of ["<b>Access Denied</b>", "", "a".repeat(41), "denied=1&x"]) {
      expect(location(oauthErrorRedirect("instagram", odd, "https://app.example.com")).searchParams.get("error")).toBe(
        "instagram_provider_error",
      );
    }
  });

  it("keeps only Settings and the code: no query of the address it started from", () => {
    const loc = location(oauthErrorRedirect("youtube", "not_configured", new URL("https://app.example.com/api/auth/youtube/start?ws=1")));
    expect([...loc.searchParams.keys()]).toEqual(["error"]);
    expect(loc.pathname).toBe("/settings");
  });
});
