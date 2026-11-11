import { describe, expect, it } from "vitest";

import { verifyEmailBannerShown } from "./verify-email-banner";
import { confirmEmailBannerShown, readWorkspaceStatus } from "./workspace-paused-banner";

/**
 * Fix round 1 (23): one banner per person. When the workspace banner asks an
 * unconfirmed address to confirm it (billing on), the older "Verify your
 * email" nudge stays hidden; otherwise the nudge behaves as before.
 */

const SENTENCE = "Confirm your email address to start posting. We sent a link to new@example.com.";

describe("verifyEmailBannerShown", () => {
  it("shows the nudge when the account check says so and the new banner is not up", () => {
    expect(verifyEmailBannerShown(true, false)).toBe(true);
    expect(verifyEmailBannerShown(false, false)).toBe(false);
  });

  it("hides the nudge while the new banner asks the same person to confirm", () => {
    expect(verifyEmailBannerShown(true, true)).toBe(false);
  });
});

describe("confirmEmailBannerShown", () => {
  it("is true only for the status route's unconfirmed-address answer", () => {
    expect(confirmEmailBannerShown(readWorkspaceStatus({ blockedMessage: SENTENCE, emailUnconfirmed: true }))).toBe(true);
  });

  it("is false for every answer the route gives with billing off", () => {
    for (const data of [
      { blockedMessage: null },
      { blockedMessage: "This workspace is paused. Contact us." },
      null,
    ]) {
      expect(confirmEmailBannerShown(readWorkspaceStatus(data))).toBe(false);
    }
  });
});
