import { describe, expect, it } from "vitest";

import { linkedInSwitchNumbersNote } from "./linkedin-account-dialog";

/**
 * G4 (R2-security L2): Switch account disconnects the current LinkedIn page
 * first, which deletes the post numbers read from it (api/connections DELETE).
 */
describe("LinkedIn account dialog: numbers note", () => {
  it("Switch account says the numbers read from LinkedIn are deleted for good", () => {
    expect(linkedInSwitchNumbersNote("switch")).toBe(
      "The post numbers read from this platform are deleted and cannot be brought back.",
    );
  });

  it("Connect says nothing about numbers", () => {
    expect(linkedInSwitchNumbersNote("connect")).toBeNull();
  });
});
