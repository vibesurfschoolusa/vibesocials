import { describe, expect, it } from "vitest";

import { LINKEDIN_CONNECT_URL, LINKEDIN_SIGN_OUT_URL, linkedInAccountDialogCopy } from "./linkedinAccount";

describe("linkedinAccount", () => {
  it("signs out on linkedin.com and connects through the app's OAuth start", () => {
    expect(new URL(LINKEDIN_SIGN_OUT_URL).hostname).toBe("www.linkedin.com");
    expect(LINKEDIN_CONNECT_URL).toBe("/api/auth/linkedin/start");
  });

  it("explains that the signed-in account is used and how to choose another, for Connect and Switch", () => {
    const connect = linkedInAccountDialogCopy("connect");
    const switching = linkedInAccountDialogCopy("switch");

    expect(connect.title).toBe("Connect LinkedIn");
    expect(switching.title).toBe("Switch LinkedIn account");
    expect(connect.continueLabel).toBe("Continue");
    expect(switching.continueLabel).toBe("Disconnect & continue");
    for (const copy of [connect, switching]) {
      expect(copy.description).toMatch(/signed in to this browser/);
      expect(copy.steps[0]).toMatch(/sign out/i);
      // The sign-out URL bounces a signed-out visitor to a sign-in page that signs out again.
      expect(copy.steps[0]).toMatch(/already signed out: close it/);
      expect(copy.steps[1]).toMatch(/use an account that is a Super admin of your company page./);
    }
  });

  // R58 pages-b L1: the steps name the button the dialog shows, from the same continueLabel.
  it("switch mode's steps name Disconnect & continue, the dialog's forward button", () => {
    const switching = linkedInAccountDialogCopy("switch");
    expect(switching.steps[1]).toBe(
      "Come back here and click Disconnect & continue. LinkedIn asks you to sign in: use an account that is a Super admin of your company page.",
    );
    expect(switching.shortcut).toBe("Already signed in to LinkedIn with the right account? Just click Disconnect & continue.");
    expect(switching.steps.join(" ") + switching.shortcut).not.toMatch(/click Continue/);
  });

  it("connect mode's steps name its own Continue button, as before", () => {
    const connect = linkedInAccountDialogCopy("connect");
    expect(connect.steps[1]).toBe(
      "Come back here and click Continue. LinkedIn asks you to sign in: use an account that is a Super admin of your company page.",
    );
    expect(connect.shortcut).toBe("Already signed in to LinkedIn with the right account? Just click Continue.");
  });
});
