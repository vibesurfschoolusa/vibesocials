import { describe, expect, it } from "vitest";

import { captionFailedText } from "./bulk-post-row";

// Go-live check F2 item 5 and fix round 1 item 4: the row read "No caption was
// written (AI is not configured. Set XAI_API_KEY ...)" and later "(blobUrl is
// required)". It shows only sentences written for a person, never the server's
// own text in brackets.
describe("Add many: a caption that failed", () => {
  const PLAIN = "No caption was written. Write one yourself, or ask again.";

  it("504: the timeout sentence", () => {
    expect(captionFailedText(504, "AI_TIMEOUT")).toBe(
      "No caption was written: the AI service took too long. Write one yourself, or ask again.",
    );
  });

  it("429: the too-many-requests sentence", () => {
    expect(captionFailedText(429, undefined)).toBe(
      "No caption was written: too many requests. Wait a few minutes, then ask again, or write one yourself.",
    );
  });

  it("the daily limit: its own sentence", () => {
    expect(captionFailedText(429, "AI_WORKSPACE_DAILY_LIMIT")).toBe(
      "No caption was written: your workspace has reached today's AI limit. Write one yourself, or try again tomorrow.",
    );
  });

  it("file too large: its own sentence", () => {
    expect(captionFailedText(413, undefined)).toBe(
      "No caption was written: the file is too large for the AI to read. Write one yourself.",
    );
  });

  it("a 400 with a field name in its text: the plain sentence, no brackets", () => {
    expect(captionFailedText(400, "AI_INPUT_TOO_LONG")).toBe(PLAIN);
    expect(captionFailedText(400, undefined)).toBe(PLAIN);
  });

  // Fix round 2: replaces "a refusal that is the person's to fix keeps its sentence".
  it("a refusal that is the person's to fix (403, a blocked workspace) keeps a sentence of its own", () => {
    expect(captionFailedText(403, "WORKSPACE_PAUSED")).toBe(
      "No caption was written: this workspace can't use AI captions right now. See the notice at the top of the page.",
    );
    expect(captionFailedText(403, undefined)).toBe(captionFailedText(403, "TRIAL_ENDED"));
  });

  it("a 500: the plain sentence", () => {
    expect(captionFailedText(500, undefined)).toBe(PLAIN);
  });

  it("a network failure (no answer): the plain sentence", () => {
    expect(captionFailedText(null, undefined)).toBe(PLAIN);
  });

  it("never brackets", () => {
    for (const [status, code] of [[504, "AI_TIMEOUT"], [429, undefined], [429, "AI_WORKSPACE_DAILY_LIMIT"], [413, undefined], [400, undefined], [403, undefined], [403, "WORKSPACE_PAUSED"], [500, undefined], [null, undefined]] as const) {
      expect(captionFailedText(status, code)).not.toMatch(/[()]/);
    }
  });
});
