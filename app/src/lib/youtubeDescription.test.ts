import { describe, expect, it } from "vitest";

import { PLATFORM_CAPTION_LIMITS } from "./platformLimits";
import {
  fitYouTubeDescription,
  YOUTUBE_DESCRIPTION_MAX_BYTES,
  youtubeCountHint,
  youtubeDescriptionLength,
  youtubeSafeText,
} from "./youtubeDescription";
import * as client from "@/server/platforms/youtubeClient";

// R52 platform-clients L1: the description rule lives in lib so the composer's
// preview and counter cut and count exactly as youtubeClient.ts posts.
describe("YouTube's description rule", () => {
  it("reads its limit from the one limits map", () => {
    expect(YOUTUBE_DESCRIPTION_MAX_BYTES).toBe(5000);
    expect(PLATFORM_CAPTION_LIMITS.youtube.utf8ByteLimit).toBe(YOUTUBE_DESCRIPTION_MAX_BYTES);
  });

  it("is the very function the client posts with", () => {
    expect(client.fitYouTubeDescription).toBe(fitYouTubeDescription);
    expect(client.youtubeSafeText).toBe(youtubeSafeText);
    expect(client.YOUTUBE_DESCRIPTION_MAX_BYTES).toBe(YOUTUBE_DESCRIPTION_MAX_BYTES);
  });

  it("leaves ASCII under and at 5,000 whole, and cuts one over with …", () => {
    expect(fitYouTubeDescription("a".repeat(4999))).toBe("a".repeat(4999));
    expect(fitYouTubeDescription("a".repeat(5000))).toBe("a".repeat(5000));
    // "…" counts 3, so 4,997 letters stay.
    expect(fitYouTubeDescription("a".repeat(5001))).toBe(`${"a".repeat(4997)}…`);
  });

  it("counts as YouTube does: an emoji 4, an accented letter 2, a < or > 3 once made safe", () => {
    expect(youtubeDescriptionLength("abc")).toBe(3);
    expect(youtubeDescriptionLength("\u{1F30A}")).toBe(4);
    expect(youtubeDescriptionLength("é")).toBe(2);
    expect(youtubeDescriptionLength("<>")).toBe(6);
  });

  it("cuts a short description full of emoji once it passes 5,000", () => {
    const caption = "\u{1F30A}".repeat(1251); // 1,251 characters, 5,004 counted
    expect(youtubeDescriptionLength(caption)).toBe(5004);
    expect(fitYouTubeDescription(caption)).toBe(`${"\u{1F30A}".repeat(1249)}…`);
  });

  // R52 fix review L1: the hint is true for every text that shows it. Each
  // sample's characters really count as the hint says.
  const GENERAL = "YouTube counts accented letters, curly quotes and emoji as 2 or more.";
  const counted = (text: string) => youtubeDescriptionLength(text);

  it("ASCII only: no hint", () => {
    expect(youtubeCountHint("plain words, 'straight' quotes & plain ASCII")).toBeNull();
  });

  it.each([
    ["a curly apostrophe", "We\u2019re out", "\u2019", 3],
    ["an accented letter", "Caf\u00e9", "\u00e9", 2],
    ["one simple emoji", "Waves \u{1F30A}", "\u{1F30A}", 4],
    ["a joined surfer", "\u{1F3C4}\u200D\u2642\uFE0F", "\u{1F3C4}\u200D\u2642\uFE0F", 13],
    ["a joined family", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}", 25],
    ["a skin tone", "\u{1F44D}\u{1F3FD}", "\u{1F44D}\u{1F3FD}", 8],
    ["a flag", "\u{1F1FA}\u{1F1F8}", "\u{1F1FA}\u{1F1F8}", 8],
    ["a red heart", "\u2764\uFE0F", "\u2764\uFE0F", 6],
  ] as const)("%s: the general hint, and it counts as the hint says", (_kind, text, character, size) => {
    expect(youtubeCountHint(text)).toBe(GENERAL);
    expect(counted(character)).toBe(size);
    expect(size).toBeGreaterThan(1);
  });

  it("names < and > only when the text has one", () => {
    expect(youtubeCountHint("I <3 waves")).toBe("YouTube counts < and > as 3.");
    expect(counted("<")).toBe(3);
    expect(youtubeCountHint("I <3 caf\u00e9")).toBe("YouTube counts accented letters, curly quotes, emoji, < and > as 2 or more.");
  });
});
