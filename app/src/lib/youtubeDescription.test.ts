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

  it("names why the number jumps only when something counts as more than one", () => {
    expect(youtubeCountHint("plain words")).toBeNull();
    expect(youtubeCountHint("café \u{1F30A}")).toBe("YouTube counts most emoji as 4 and an accented letter as 2");
    expect(youtubeCountHint("I <3 waves")).toBe("YouTube counts a < or > as 3");
    expect(youtubeCountHint("I <3 café")).toBe(
      "YouTube counts most emoji as 4 and an accented letter as 2, and a < or > as 3",
    );
  });
});
