import { describe, expect, it } from "vitest";

import { captionFailedText, captionFailureReason } from "./bulk-post-row";

// Go-live check F2 item 5: the row read "No caption was written (AI is not
// configured. Set XAI_API_KEY ...)". A person never reads the server's own error.
describe("Add many: a caption that failed", () => {
  it("not configured, a provider error or a timeout: the plain sentence alone", () => {
    for (const status of [500, 502, 504]) {
      const reason = captionFailureReason(status, "AI is not configured. Set XAI_API_KEY (preferred) or OPENAI_API_KEY.");
      expect(reason, String(status)).toBeNull();
      expect(captionFailedText(reason)).toBe("No caption was written. Write one yourself, or ask again.");
    }
  });

  it("no answer at all (the network failed): the plain sentence alone", () => {
    expect(captionFailureReason(null, undefined)).toBeNull();
  });

  it("too many requests or the day's limit: that sentence, as today", () => {
    const reason = captionFailureReason(429, "Too many requests, slow down.");
    expect(captionFailedText(reason)).toBe(
      "No caption was written (Too many requests, slow down.). Write one yourself, or ask again.",
    );
    expect(captionFailureReason(429, "Your workspace has reached today's AI limit. Try again tomorrow.")).toBe(
      "Your workspace has reached today's AI limit. Try again tomorrow.",
    );
  });

  it("a refusal that is the person's to fix keeps its sentence; one without words is plain", () => {
    expect(captionFailureReason(403, "This workspace is paused.")).toBe("This workspace is paused.");
    expect(captionFailureReason(400, "")).toBeNull();
    expect(captionFailureReason(400, { nested: true })).toBeNull();
  });
});
