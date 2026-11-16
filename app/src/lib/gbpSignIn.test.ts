import { describe, expect, it } from "vitest";

import { withWorkspaceId } from "@/lib/workspaceChanged";

import { GBP_CARD_HREF, GBP_CARD_ID, gbpSignInUrl } from "./gbpSignIn";

// JJ3 lead review: Google refusing an unflagged connection is fixed by signing
// in again in place: the Reconnect button's start URL, built in the browser
// from the workspace the page was drawn for (never from the server's cookie).
describe("the in-place Google sign-in", () => {
  it("is the Reconnect button's start URL, for the workspace it is given", () => {
    expect(gbpSignInUrl("ws-A")).toBe(withWorkspaceId("/api/auth/google_business_profile/start", "ws-A"));
    expect(gbpSignInUrl("ws-A")).toBe("/api/auth/google_business_profile/start?workspaceId=ws-A");
    expect(gbpSignInUrl("a b")).toBe("/api/auth/google_business_profile/start?workspaceId=a%20b");
  });

  it("the Settings card for Google Business Profile has its own anchor", () => {
    expect(GBP_CARD_ID).toBe("google-business-profile");
    expect(GBP_CARD_HREF).toBe("/settings#google-business-profile");
  });
});
