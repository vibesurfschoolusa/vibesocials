import { describe, expect, it } from "vitest";

import {
  REVIEW_NOTE_MAX,
  REVIEW_NOTE_MISSING_MESSAGE,
  REVIEW_NOTE_TOO_LONG_MESSAGE,
  REVIEW_DECISION_INVALID_MESSAGE,
  REVIEW_VERSION_MISSING_MESSAGE,
  REVIEW_POST_CHANGED_MESSAGE,
  REVIEW_POST_LOCKED_MESSAGE,
  REVIEW_ANSWER_UNREADABLE_MESSAGE,
  REVIEW_ALREADY_APPROVED_MESSAGE,
  isReviewLinkTokenShape,
  reviewDecisionOutcome,
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
  it("reads an approval with the version it was given, and ignores anything else in the body", () => {
    expect(
      parseReviewDecision({
        decision: "approve",
        version: "2026-11-10T10:00:00.123Z",
        note: "x",
        status: "published",
      }),
    ).toEqual({ ok: true, decision: "approve", version: new Date("2026-11-10T10:00:00.123Z") });
  });

  it("refuses an approval without a version that names an instant", () => {
    for (const version of [undefined, null, "", "not a date", 1731232800000, "2026-11-10"]) {
      expect(parseReviewDecision({ decision: "approve", version }), String(version)).toEqual({
        ok: false,
        error: REVIEW_VERSION_MISSING_MESSAGE,
      });
    }
  });

  it("does not need a version for a change request", () => {
    expect(parseReviewDecision({ decision: "change", note: "x" })).toMatchObject({ ok: true });
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

describe("reviewDecisionOutcome", () => {
  const VERSION = "2026-11-10T12:00:00.000Z";

  it("updates an approved card from the answer, with the version the next approve must send", () => {
    expect(reviewDecisionOutcome(200, { ok: true, state: "approved", version: VERSION })).toEqual({
      kind: "saved",
      patch: { state: "approved", version: VERSION, note: null },
    });
  });

  it("turns a change request's card into the Change requested card with the stored note", () => {
    expect(
      reviewDecisionOutcome(200, { ok: true, state: "change_requested", note: "Use the other photo" }),
    ).toEqual({ kind: "saved", patch: { state: "change_requested", note: "Use the other photo" } });
  });

  it("asks for the list to be reloaded only when the post changed", () => {
    expect(reviewDecisionOutcome(409, { error: REVIEW_POST_CHANGED_MESSAGE })).toEqual({
      kind: "changed",
      message: REVIEW_POST_CHANGED_MESSAGE,
    });
    expect(reviewDecisionOutcome(409, { error: REVIEW_POST_LOCKED_MESSAGE })).toEqual({
      kind: "refused",
      message: REVIEW_POST_LOCKED_MESSAGE,
    });
  });

  it("reloads the list when the approval already stood, instead of marking the text on screen as approved", () => {
    // The page may be showing older text than the one that was approved (a
    // second phone approved after the owner's edit), so the card is not patched.
    expect(
      reviewDecisionOutcome(200, { ok: true, state: "approved", version: VERSION, already: true }),
    ).toEqual({ kind: "stands", message: REVIEW_ALREADY_APPROVED_MESSAGE });
    expect(REVIEW_ALREADY_APPROVED_MESSAGE).toBe(
      "This post was already approved. The list below shows it as it is now.",
    );
  });

  it("always gives a refused decision a sentence", () => {
    expect(reviewDecisionOutcome(429, { error: "Too many." })).toEqual({ kind: "refused", message: "Too many." });
    expect(reviewDecisionOutcome(500, null)).toEqual({
      kind: "refused",
      message: "Couldn't save that. Try again.",
    });
  });

  it("does not claim success from an answer it cannot read", () => {
    for (const data of [null, { ok: true }, { ok: true, state: "approved" }, { ok: true, state: "change_requested" }]) {
      expect(reviewDecisionOutcome(200, data)).toEqual({
        kind: "refused",
        message: REVIEW_ANSWER_UNREADABLE_MESSAGE,
      });
    }
  });
});
