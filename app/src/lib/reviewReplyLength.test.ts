import { describe, expect, it } from "vitest";

import {
  GOOGLE_REPLY_MAX_BYTES,
  REPLY_TOO_LONG_MESSAGE,
  replyBytes,
  replyCounter,
  replyTooLong,
} from "./reviewReplyLength";

// R17-client-journey addendum L1: Google refuses a reply over 4096 bytes.
describe("review reply length", () => {
  it("counts UTF-8 bytes of the text that is sent (trimmed)", () => {
    expect(replyBytes("  abc  ")).toBe(3);
    expect(replyBytes("é")).toBe(2);
    expect(replyBytes("😀")).toBe(4);
  });

  it("allows exactly 4096 bytes and refuses 4097", () => {
    expect(GOOGLE_REPLY_MAX_BYTES).toBe(4096);
    expect(replyTooLong("a".repeat(4096))).toBe(false);
    expect(replyTooLong("a".repeat(4097))).toBe(true);
  });

  it("refuses a reply under 4096 characters but over 4096 bytes", () => {
    const text = "é".repeat(2100); // 2,100 characters, 4,200 bytes
    expect(text.length).toBeLessThan(4096);
    expect(replyTooLong(text)).toBe(true);
    expect(replyTooLong("😀".repeat(1025))).toBe(true);
  });

  it("says what happened and what to do", () => {
    expect(REPLY_TOO_LONG_MESSAGE).toBe(
      "Your reply is too long for Google. Google allows 4,096 bytes, about 4,000 characters (emoji and accented letters count more). Shorten it and try again.",
    );
  });

  it("shows a counter only near the limit", () => {
    expect(replyCounter("a".repeat(100))).toBeNull();
    expect(replyCounter("a".repeat(3599))).toBeNull();
    expect(replyCounter("a".repeat(3600))).toBe("3,600 of 4,096 bytes used. Emoji and accented letters count more.");
    expect(replyCounter("a".repeat(5000))).toBe("5,000 of 4,096 bytes used. Emoji and accented letters count more.");
  });
});
