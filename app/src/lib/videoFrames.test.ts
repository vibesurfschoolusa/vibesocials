import { describe, expect, it } from "vitest";

import {
  MAX_FRAME_DATA_URL_LENGTH,
  MAX_VIDEO_FRAMES,
  parseVideoFrames,
  videoFrameTimes,
} from "./videoFrames";

const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U";

describe("videoFrameTimes", () => {
  it("samples the start, middle and end of the clip (20%, 50%, 80%)", () => {
    expect(videoFrameTimes(12)).toEqual([2.4, 6, 9.6]);
  });

  it("gives one frame at the start when the duration is unknown", () => {
    expect(videoFrameTimes(Number.NaN)).toEqual([0]);
    expect(videoFrameTimes(0)).toEqual([0]);
    expect(videoFrameTimes(Number.POSITIVE_INFINITY)).toEqual([0]);
  });
});

describe("parseVideoFrames", () => {
  it("treats a missing value as no frames", () => {
    expect(parseVideoFrames(undefined)).toEqual([]);
    expect(parseVideoFrames(null)).toEqual([]);
  });

  it("accepts up to MAX_VIDEO_FRAMES JPEG data URLs, in order", () => {
    const frames = [JPEG, `${JPEG}AA`, `${JPEG}BB`];
    expect(MAX_VIDEO_FRAMES).toBe(3);
    expect(parseVideoFrames(frames)).toEqual(frames);
  });

  it("rejects anything that is not a short list of JPEG data URLs", () => {
    expect(parseVideoFrames("nope")).toBe("invalid");
    expect(parseVideoFrames([JPEG, JPEG, JPEG, JPEG])).toBe("invalid");
    expect(parseVideoFrames([42])).toBe("invalid");
    expect(parseVideoFrames(["https://example.com/frame.jpg"])).toBe("invalid"); // never a URL to fetch
    expect(parseVideoFrames(["data:image/png;base64,iVBORw0KGgo="])).toBe("invalid");
    expect(parseVideoFrames(["data:image/jpeg;base64,not base64!"])).toBe("invalid");
    expect(parseVideoFrames([JPEG + "A".repeat(MAX_FRAME_DATA_URL_LENGTH)])).toBe("invalid");
  });
});
