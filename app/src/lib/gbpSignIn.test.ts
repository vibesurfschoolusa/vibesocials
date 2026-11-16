import { describe, expect, it } from "vitest";

import { GBP_CARD_HREF, gbpSignInUrl, safeGbpSignInUrl } from "./gbpSignIn";

// JJ3 lead review: Google refusing an unflagged connection is fixed by signing
// in again in place (the Reconnect button's own start URL, which keeps the row,
// its location and the listing's numbers), never by Switch account.
describe("the in-place Google sign-in", () => {
  it("is the Reconnect button's start URL for the workspace", () => {
    expect(gbpSignInUrl("ws-1")).toBe("/api/auth/google_business_profile/start?workspaceId=ws-1");
    expect(gbpSignInUrl("a b")).toBe("/api/auth/google_business_profile/start?workspaceId=a%20b");
  });

  it("is only taken from an answer when it is that start URL", () => {
    expect(safeGbpSignInUrl("/api/auth/google_business_profile/start?workspaceId=ws-1")).toBe("/api/auth/google_business_profile/start?workspaceId=ws-1");
    for (const bad of ["https://evil.example/api/auth/google_business_profile/start?x", "/api/auth/x/start?workspaceId=1", "javascript:alert(1)", 42, null, undefined]) {
      expect(safeGbpSignInUrl(bad)).toBeNull();
    }
  });

  it("the Settings card for Google Business Profile has its own anchor", () => {
    expect(GBP_CARD_HREF).toBe("/settings#google-business-profile");
  });
});
