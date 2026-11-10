import { describe, expect, it } from "vitest";

import {
  REVIEW_NOTE_MAX,
  REVIEW_NOTE_MISSING_MESSAGE,
  REVIEW_NOTE_TOO_LONG_MESSAGE,
  REVIEW_DECISION_INVALID_MESSAGE,
  isReviewLinkTokenShape,
  parseReviewDecision,
  reviewLinkUrl,
} from "./reviewLink";

describe("reviewLinkUrl", () => {
  it("puts the token under /v/", () => {
    expect(reviewLinkUrl("https://app.example", "tok")).toBe("https://app.example/v/tok");
    expect(reviewLinkUrl(undefined, "tok")).toBe("/v/tok");
  });
});

describe("isReviewLinkTokenShape", () => {
  it("accepts only 43 base64url characters", () => {
    expect(isReviewLinkTokenShape("A".repeat(43))).toBe(true);
    expect(isReviewLinkTokenShape("A_-9".padEnd(43, "x"))).toBe(true);
    expect(isReviewLinkTokenShape("A".repeat(42))).toBe(false);
    expect(isReviewLinkTokenShape(`${"A".repeat(42)}%`)).toBe(false);
    expect(isReviewLinkTokenShape(`${"A".repeat(42)}/`)).toBe(false);
  });
});

describe("parseReviewDecision", () => {
  it("reads an approval and ignores anything else in the body", () => {
    expect(parseReviewDecision({ decision: "approve", note: "x", status: "published" })).toEqual({
      ok: true,
      decision: "approve",
    });
  });

  it("reads a change request with its note trimmed", () => {
    expect(parseReviewDecision({ decision: "change", note: "  Use the other photo  " })).toEqual({
      ok: true,
      decision: "change",
      note: "Use the other photo",
    });
  });

  it("refuses an unknown or missing decision", () => {
    for (const body of [{}, { decision: "publish" }, { decision: 1 }, null]) {
      expect(parseReviewDecision(body)).toEqual({ ok: false, error: REVIEW_DECISION_INVALID_MESSAGE });
    }
  });

  it("refuses a change with no note, a blank one, or one that is not text", () => {
    for (const note of [undefined, "", "   \n ", 42, null]) {
      expect(parseReviewDecision({ decision: "change", note })).toEqual({
        ok: false,
        error: REVIEW_NOTE_MISSING_MESSAGE,
      });
    }
  });

  it("takes 500 characters and refuses 501, counting whole characters", () => {
    const max = "a".repeat(REVIEW_NOTE_MAX);
    expect(parseReviewDecision({ decision: "change", note: max })).toEqual({
      ok: true,
      decision: "change",
      note: max,
    });
    expect(parseReviewDecision({ decision: "change", note: `${max}b` })).toEqual({
      ok: false,
      error: REVIEW_NOTE_TOO_LONG_MESSAGE,
    });
    // 500 emoji are 1000 UTF-16 units but 500 characters.
    const emoji = "😀".repeat(REVIEW_NOTE_MAX);
    expect(parseReviewDecision({ decision: "change", note: emoji })).toMatchObject({ ok: true });
  });

  it("keeps markup as the plain text it is", () => {
    const note = '<img src=x onerror="alert(1)"> & <b>bold</b>';
    expect(parseReviewDecision({ decision: "change", note })).toEqual({
      ok: true,
      decision: "change",
      note,
    });
  });

  it("drops control characters but keeps line breaks", () => {
    expect(parseReviewDecision({ decision: "change", note: "a\u0000b\r\nc\u0007" })).toEqual({
      ok: true,
      decision: "change",
      note: "ab\nc",
    });
  });
});
