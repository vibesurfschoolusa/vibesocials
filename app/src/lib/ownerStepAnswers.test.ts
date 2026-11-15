import { describe, expect, it } from "vitest";

import { connectionsSectionIntro } from "./ownerStepAnswers";

// R12 L3: the Connections section's intro, for whoever reads it.
describe("connectionsSectionIntro", () => {
  it("the owner: as before", () => {
    expect(connectionsSectionIntro(false)).toBe("Connect your social accounts so Vibe Socials can publish on your behalf.");
  });

  it("a member: who connects them", () => {
    expect(connectionsSectionIntro(true)).toBe(
      "The accounts Vibe Socials publishes to for this workspace. The workspace owner connects and reconnects them.",
    );
  });
});
