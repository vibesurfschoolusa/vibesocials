import { describe, expect, it } from "vitest";

import { copiesWorkAgainWhen } from "./clientLinkWording";

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
