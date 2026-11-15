import { describe, expect, it } from "vitest";

import { SIGNED_OUT_ERROR, signedOutResponse } from "./signedOutResponse";

// R20 new-customer L2: the account menu, Workspaces' Open, the Team section and
// Create show a 401's `error` to the person as it is, so it says what happened
// and what to do, the same as Join (join-view.tsx).
describe("signedOutResponse", () => {
  it("is a 401 whose error is the plain signed-out sentence", async () => {
    const response = signedOutResponse();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "You were signed out. Sign in again." });
    expect(SIGNED_OUT_ERROR).toBe("You were signed out. Sign in again.");
  });

  it("is a fresh response each time (a body can be read once)", () => {
    expect(signedOutResponse()).not.toBe(signedOutResponse());
  });
});
