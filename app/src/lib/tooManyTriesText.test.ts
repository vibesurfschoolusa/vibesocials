import { describe, expect, it } from "vitest";

import { tooManyTriesSentence, waitText } from "./tooManyTriesText";

// R45 lead review: the one home of the minutes-and-hours wording of a wait.
describe("waitText", () => {
  it("names a wait in whole minutes, rounded up, up to an hour", () => {
    expect(waitText(20)).toBe("a minute");
    expect(waitText(60)).toBe("a minute");
    expect(waitText(61)).toBe("2 minutes");
    expect(waitText(12 * 60 - 5)).toBe("12 minutes");
    expect(waitText(59 * 60)).toBe("59 minutes");
    // R45 second review: an hour reads as dailyLimitSentence and the AI line say it.
    expect(waitText(3600)).toBe("1 hour");
    expect(waitText(3600 - 30)).toBe("1 hour");
  });

  it("names a longer wait in whole hours, rounded up", () => {
    expect(waitText(3601)).toBe("2 hours");
    expect(waitText(61 * 60)).toBe("2 hours");
    expect(waitText(7 * 3600 - 100)).toBe("7 hours");
  });

  it("tooManyTriesSentence says its wait the same way", () => {
    expect(tooManyTriesSentence(14 * 60)).toBe("Too many tries. Wait 14 minutes, then try again.");
    expect(tooManyTriesSentence(20)).toBe("Too many tries. Wait a minute, then try again.");
    expect(tooManyTriesSentence(undefined)).toBe("Too many tries. Wait a few minutes, then try again.");
  });
});
