import { describe, expect, it } from "vitest";

import { truncateGraphemes } from "@/lib/truncate";

import {
  computeChunkPlan,
  computeTikTokCaption,
  decidePollOutcome,
  TIKTOK_MAX_CHUNK_SIZE,
  TIKTOK_MAX_FINAL_CHUNK_SIZE,
} from "./tiktokClient";

const MB = 1024 * 1024;

describe("computeChunkPlan", () => {
  // Every plan must fully and contiguously cover [0, size) using exactly
  // `totalChunks` chunks, and no chunk may exceed TikTok's 128MB final-chunk
  // cap. Returns the plan so callers can assert further specifics.
  function assertFullCoverage(size: number, plan = computeChunkPlan(size)) {
    expect(plan.ranges).toHaveLength(plan.totalChunks);
    expect(plan.ranges.length).toBeGreaterThan(0);
    expect(plan.ranges[0].start).toBe(0);
    expect(plan.ranges[plan.ranges.length - 1].end).toBe(size);

    let cursor = 0;
    for (const { start, end } of plan.ranges) {
      expect(start).toBe(cursor); // contiguous: no gaps, no overlaps
      expect(end).toBeGreaterThan(start); // non-empty chunk
      expect(end - start).toBeLessThanOrEqual(TIKTOK_MAX_FINAL_CHUNK_SIZE);
      cursor = end;
    }
    // The sum of all chunk lengths equals the declared video_size, so the whole
    // file is uploaded (this is exactly what the old floor-math dropped).
    expect(cursor).toBe(size);
    return plan;
  }

  it("uses a single whole-file chunk for a tiny 1KB file", () => {
    const plan = assertFullCoverage(1024);
    expect(plan.totalChunks).toBe(1);
    expect(plan.chunkSize).toBe(1024);
    expect(plan.ranges).toEqual([{ start: 0, end: 1024 }]);
  });

  it("uses a single chunk for a file exactly at the 10MB chunk size", () => {
    const size = 10 * MB;
    const plan = assertFullCoverage(size);
    expect(plan.totalChunks).toBe(1);
    expect(plan.chunkSize).toBe(size);
    expect(plan.ranges).toEqual([{ start: 0, end: size }]);
  });

  it("keeps the trailing byte for 10MB + 1 (floor rule yields one fat chunk)", () => {
    const size = 10 * MB + 1;
    const plan = assertFullCoverage(size);
    // floor((10MB + 1) / 10MB) === 1, so the single chunk must still reach size.
    expect(plan.totalChunks).toBe(1);
    expect(plan.chunkSize).toBe(TIKTOK_MAX_CHUNK_SIZE);
    expect(plan.ranges).toEqual([{ start: 0, end: size }]);
  });

  it("covers a 15MB file with a single fat chunk (10MB < size < 20MB)", () => {
    const size = 15 * MB;
    const plan = assertFullCoverage(size);
    expect(plan.totalChunks).toBe(1); // floor(15 / 10) === 1
    expect(plan.ranges).toEqual([{ start: 0, end: size }]);
  });

  it("splits an exact 20MB multiple into two equal chunks", () => {
    const size = 20 * MB;
    const plan = assertFullCoverage(size);
    expect(plan.totalChunks).toBe(2);
    expect(plan.ranges).toEqual([
      { start: 0, end: 10 * MB },
      { start: 10 * MB, end: 20 * MB },
    ]);
  });

  it("fattens the final chunk for 25MB (the reported data-loss case)", () => {
    const size = 25 * MB;
    const plan = assertFullCoverage(size);
    expect(plan.totalChunks).toBe(2); // floor(25 / 10) === 2
    expect(plan.ranges).toEqual([
      { start: 0, end: 10 * MB },
      { start: 10 * MB, end: 25 * MB }, // final chunk absorbs the trailing 5MB
    ]);
    // Regression guard: the old code stopped at 20MB and dropped the last 5MB.
    expect(plan.ranges[plan.ranges.length - 1].end).toBe(size);
  });

  it("covers 64MB + 3 bytes with the trailing 3 bytes in the final chunk", () => {
    const size = 64 * MB + 3;
    const plan = assertFullCoverage(size);
    expect(plan.totalChunks).toBe(6); // floor((64MB + 3) / 10MB) === 6
    const last = plan.ranges[plan.ranges.length - 1];
    expect(last.end).toBe(size);
    // First 5 chunks are 10MB each; the final chunk holds the remaining bytes.
    expect(last.start).toBe(5 * 10 * MB);
    expect(last.end - last.start).toBe(size - 5 * 10 * MB); // 14MB + 3 bytes
  });

  it("honors a custom maxChunkSize and still covers the whole file", () => {
    const size = 25 * MB;
    const plan = assertFullCoverage(size, computeChunkPlan(size, 5 * MB));
    expect(plan.chunkSize).toBe(5 * MB);
    expect(plan.totalChunks).toBe(5); // floor(25 / 5) === 5
  });
});

// Roadmap Phase 7 (spec §7.1) — this locks computeTikTokCaption (extracted
// from publishVideo when it was refactored to read its limit from
// lib/platformLimits.ts instead of the inline `2200` literal) to the EXACT
// same output as the pre-refactor inline expression:
//
//   const tiktokCaption = caption
//     ? truncateGraphemes(caption, 2200)
//     : "Video posted via Vibe Socials";
//
// If this ever fails, either the refactor broke posting behavior or someone
// edited PLATFORM_CAPTION_LIMITS.tiktok without meaning to change what
// TikTok posts.
describe("computeTikTokCaption", () => {
  it("falls back to the default title when caption is empty", () => {
    expect(computeTikTokCaption("")).toBe("Video posted via Vibe Socials");
  });

  it("returns a caption under 2200 graphemes unchanged", () => {
    const caption = "Just a short caption";
    expect(computeTikTokCaption(caption)).toBe(caption);
  });

  it("returns a caption at exactly 2200 graphemes unchanged (boundary)", () => {
    const caption = "a".repeat(2200);
    expect(computeTikTokCaption(caption)).toBe(caption);
  });

  it("truncates a caption of length 2500 to exactly 2200 graphemes with no ellipsis", () => {
    const caption = "a".repeat(2500);
    const result = computeTikTokCaption(caption);
    expect(result).toHaveLength(2200);
    expect(result).toBe("a".repeat(2200));
  });

  it("matches the pre-refactor inline call byte-for-byte for a realistic long caption", () => {
    const caption = "The quick brown fox jumps over the lazy dog. ".repeat(60);
    expect(caption.length).toBeGreaterThan(2200);
    expect(computeTikTokCaption(caption)).toBe(truncateGraphemes(caption, 2200));
  });

  it("matches the pre-refactor inline call byte-for-byte for emoji/ZWJ-heavy content over the limit", () => {
    const caption = "😀👨‍👩‍👧🇺🇸".repeat(500);
    expect(caption.length).toBeGreaterThan(2200);
    expect(computeTikTokCaption(caption)).toBe(truncateGraphemes(caption, 2200));
  });
});

describe("decidePollOutcome", () => {
  it("classifies publish_complete as complete (the only success)", () => {
    expect(decidePollOutcome("publish_complete")).toBe("complete");
  });

  it("classifies failed as terminal so it cannot be swallowed", () => {
    expect(decidePollOutcome("failed")).toBe("failed");
  });

  it("treats processing / unknown / missing statuses as pending", () => {
    expect(decidePollOutcome("processing_upload")).toBe("pending");
    expect(decidePollOutcome("processing_download")).toBe("pending");
    expect(decidePollOutcome("send_to_user_inbox")).toBe("pending");
    expect(decidePollOutcome("")).toBe("pending");
    expect(decidePollOutcome(undefined)).toBe("pending");
    expect(decidePollOutcome(null)).toBe("pending");
  });
});
