import { describe, expect, it } from "vitest";

import { choiceFailedText } from "./pendingChoiceText";

// R37 pages L2 / client-journey L1: one rule for both account-choice routes:
// a failure before the save says the account wasn't connected; only one after
// the save could have happened says it may have been.
describe("choiceFailedText", () => {
  it("before the save, in Settings: not connected, reload and choose again", () => {
    expect(choiceFailedText("before_save", "settings")).toBe(
      "That account wasn't connected: something went wrong on our side. Reload the page and choose it again.",
    );
  });

  it("before the save, in Settings, with the card's button: the card-button tail", () => {
    expect(choiceFailedText("before_save", "settings", { button: "Reconnect", label: "Facebook Page" })).toBe(
      "That account wasn't connected: something went wrong on our side. Reload the page and choose it again, or close this and press Reconnect on Facebook Page.",
    );
  });

  it("before the save, on the client's page: reload this page", () => {
    expect(choiceFailedText("before_save", "link")).toBe(
      "That account wasn't connected: something went wrong on our side. Reload this page and choose it again.",
    );
  });

  it("after the save could have happened: may have been connected, as before", () => {
    expect(choiceFailedText("after_save", "settings")).toBe(
      "Something went wrong on our side, so the account may have been connected. Press Cancel, then look for it in your connections before you connect again.",
    );
    expect(choiceFailedText("after_save", "link")).toBe(
      "Something went wrong on our side, so the account may have been connected. Reload this page to see.",
    );
  });
});
