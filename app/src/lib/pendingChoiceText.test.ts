import { describe, expect, it } from "vitest";

import { cancelFailedText, cancelLostStep, choiceEndsPhrase, choiceLifeLeftMs } from "./pendingChoiceText";
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

// R42 pages-a L6: "ends by itself" says the time the choice really has left
// (it lasts 15 minutes from when it was made), rounded up to whole minutes.
describe("choiceEndsPhrase", () => {
  const made = Date.UTC(2026, 10, 17, 9, 0, 0);
  const expiresAt = new Date(made + 15 * 60 * 1000);
  const at = (minutes: number) => made + minutes * 60 * 1000;

  it("12 minutes in: 3 minutes", () => {
    expect(choiceEndsPhrase(choiceLifeLeftMs(expiresAt, at(12)), "Facebook Page")).toBe("ends by itself in 3 minutes");
  });

  it("12 minutes and 1 second in: still 3 minutes (rounded up)", () => {
    expect(choiceEndsPhrase(choiceLifeLeftMs(expiresAt, at(12) + 1000), null)).toBe("ends by itself in 3 minutes");
  });

  it("at 14:30: within a minute", () => {
    expect(choiceEndsPhrase(choiceLifeLeftMs(expiresAt, at(14.5)), null)).toBe("ends by itself within a minute");
  });

  it("an unknown expiry: within 15 minutes of coming back from the platform", () => {
    expect(choiceEndsPhrase(null, "Instagram")).toBe(
      "ends by itself within 15 minutes of when you came back from Instagram",
    );
    expect(choiceEndsPhrase(choiceLifeLeftMs(null, at(1)), null)).toBe(
      "ends by itself within 15 minutes of when you came back from signing in",
    );
  });
});

describe("cancelFailedText", () => {
  const left = 3 * 60 * 1000;

  it("Settings: leave it, it ends by itself in the time left", () => {
    expect(cancelFailedText("settings", left, "LinkedIn")).toBe(
      "Couldn't cancel the choice just now. You can leave it: it ends by itself in 3 minutes.",
    );
  });

  it("/c: press Cancel again or leave the page", () => {
    expect(cancelFailedText("link", left, "LinkedIn")).toBe(
      "Couldn't cancel the choice just now. Press Cancel again, or leave this page: the choice ends by itself in 3 minutes.",
    );
  });

  it("a choice whose time ran out meanwhile has ended, never 'ends'", () => {
    expect(cancelFailedText("settings", 0, null)).toBe(
      "Couldn't cancel the choice just now, but it has ended by itself. Close this to see your connections.",
    );
    expect(cancelFailedText("link", -5000, null)).toBe(
      "Couldn't cancel the choice just now, but it has ended by itself. Reload this page to see what is connected.",
    );
  });

  it("the lost-answer step for /c", () => {
    expect(cancelLostStep(left, null)).toBe("Press Cancel again, or leave this page: the choice ends by itself in 3 minutes.");
    expect(cancelLostStep(0, null)).toBe("The choice has ended by itself meanwhile. Reload this page to see.");
  });
});
