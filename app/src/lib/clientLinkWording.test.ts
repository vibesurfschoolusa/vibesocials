import { describe, expect, it } from "vitest";

import { CLIENT_LINKS_NOT_MADE_MESSAGE, copiesWorkAgainWhen } from "./clientLinkWording";

// R24: one sentence for the Team card, the demotion toast and the former-owner
// email. A trial was never on Growth or Pro, so the plan kind drops "again".
describe("copiesWorkAgainWhen", () => {
  it("a pause: once the workspace is active again", () => {
    expect(copiesWorkAgainWhen("pause")).toBe("once the workspace is active again");
  });

  it("an ended trial or plan: once the workspace is on Growth or Pro", () => {
    expect(copiesWorkAgainWhen("plan")).toBe("once the workspace is on Growth or Pro");
  });

  it("unknown or not said: today's text", () => {
    expect(copiesWorkAgainWhen(null)).toBe("once the workspace is active again");
    expect(copiesWorkAgainWhen(undefined)).toBe("once the workspace is active again");
  });
});

// R50 pages-a L1: a failed "Make new client links" says only what is true in
// every case. A stopped connect link doesn't "still work", and a commit whose
// answer was lost may have made the new links, so it gives the step that
// shows the truth: each link is read again where it lives.
describe("CLIENT_LINKS_NOT_MADE_MESSAGE", () => {
  it("says what happened and where to copy each link again, with no claim about the old ones", () => {
    expect(CLIENT_LINKS_NOT_MADE_MESSAGE).toBe(
      "Couldn't make new client links. Reload this page and copy the links again before you send one: the upload link is on the Media page, the review link on the Queue page and the connect link on this page. Then press Make new client links again if you still need new ones.",
    );
    expect(CLIENT_LINKS_NOT_MADE_MESSAGE).not.toMatch(/still work|Nothing was changed/);
  });
});
