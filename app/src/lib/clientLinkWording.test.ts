import { readFileSync } from "node:fs";
import { join } from "node:path";

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
// answer was lost may have made the new links. R52 pages-a L1: copying "again"
// without a new press can hand out the old links a demoted owner still holds,
// and a second press is safe either way, so the step leads with pressing again.
describe("CLIENT_LINKS_NOT_MADE_MESSAGE", () => {
  it("says what happened, to press Make new client links again, and where each link lives", () => {
    expect(CLIENT_LINKS_NOT_MADE_MESSAGE).toBe(
      "We couldn't confirm new links were made. Press Make new links again, then copy each link: upload on Media, review on Queue, connect under Connections.",
    );
    // Review: "Couldn't make" is false when the commit went through and only its answer was lost.
    expect(CLIENT_LINKS_NOT_MADE_MESSAGE).not.toMatch(/still work|Nothing was changed|Couldn't make/);
  });

  // R51 pages-a L1: Team shows it only in an 8-second toast, so it must be
  // readable in that time.
  it("is 25 words or fewer", () => {
    expect(CLIENT_LINKS_NOT_MADE_MESSAGE.trim().split(/\s+/).length).toBeLessThanOrEqual(25);
  });

  // R52 pages-a L1: the route's 500 body is this sentence, so it carries the step too.
  it("is the route's 500 body, with the press-again step and the three places", () => {
    const route = readFileSync(join(__dirname, "../app/api/workspaces/client-links/route.ts"), "utf8");
    expect(route).toContain("return NextResponse.json({ error: CLIENT_LINKS_NOT_MADE_MESSAGE }, { status: 500 });");
    expect(CLIENT_LINKS_NOT_MADE_MESSAGE).toContain("Press Make new links again");
    for (const place of ["upload on Media", "review on Queue", "connect under Connections"]) {
      expect(CLIENT_LINKS_NOT_MADE_MESSAGE).toContain(place);
    }
  });
});
