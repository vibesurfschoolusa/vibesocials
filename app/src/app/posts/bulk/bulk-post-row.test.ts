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

  // R42 review: the limit's own wait (up to 15 minutes), when the answer names it.
  it("429 with a wait: the routes' words, then write one yourself", () => {
    expect(captionFailedText(429, undefined, 14 * 60)).toBe(
      "No caption was written. Too many tries. Wait 14 minutes, then ask again, or write one yourself.",
    );
    expect(captionFailedText(429, undefined, 20)).toBe(
      "No caption was written. Too many tries. Wait a minute, then ask again, or write one yourself.",
    );
  });

  // R45 pages-a L4, L5: the route's own sentence says whose budget ran out and
  // the real wait; Add many puts its lead-in before it, as Create does.
  it("the daily limit: the route's own sentence after the lead-in, for either budget", async () => {
    const { aiWorkspaceLimitResponse } = await import("@/lib/aiGuards");
    for (const budget of ["workspace", "owner"] as const) {
      const body = (await aiWorkspaceLimitResponse(3600, budget).json()) as { code: string; error: string };
      const text = captionFailedText(429, body.code, 3600, body.error);
      expect(text).toBe(`No caption was written. ${body.error}`);
    }
  });

  it("the daily limit with no readable sentence: a neutral one, naming no budget and no day", () => {
    for (const error of [undefined, "", 42]) {
      const text = captionFailedText(429, "AI_WORKSPACE_DAILY_LIMIT", undefined, error);
      expect(text).toBe("No caption was written: the AI limit has been reached for now. Write one yourself.");
      expect(text).not.toMatch(/workspace|owner|tomorrow|today/i);
    }
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

// R21 publishing-flow L1: a 401 is the shared signed-out sentence, not "ask again".
describe("Add many: a caption refused because the session ended", () => {
  it("401: the signed-out sentence", () => {
    expect(captionFailedText(401, undefined)).toBe("You were signed out. Sign in again.");
  });
});

// R31 (lead follow-up): a caption refused for another workspace says the shared sentence.
describe("captionFailedText: a page for another workspace", () => {
  it("says the shared sentence for the workspace codes", async () => {
    const { captionFailedText } = await import("./bulk-post-row");
    expect(captionFailedText(409, "WORKSPACE_CHANGED")).toBe("You switched workspace in another tab. Reload this page, then try again.");
    expect(captionFailedText(400, "MISSING_WORKSPACE_ID")).toBe("This page is out of date. Reload it, then try again.");
  });
});
