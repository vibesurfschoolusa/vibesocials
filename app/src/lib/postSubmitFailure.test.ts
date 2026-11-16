import { describe, expect, it, vi } from "vitest";

import { sendPostRequest, submitErrorText } from "./postSubmitFailure";
import { explainUploadFailure, UPLOAD_OFFLINE_MESSAGE } from "./uploadFailure";

// R24 JJ2 follow-up: what Create's Post button says when the press fails
// before an answer: an upload that never reached us, or the post request lost.
describe("Create's submit failure", () => {
  const offline = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
  const NOW = { mode: "now", holdsForApproval: false } as const;
  const FULL = "This workspace's media storage is full (5.0 GB). Delete media you no longer need on the Media page, then upload again.";

  it("upload offline at submit: the upload sentence", async () => {
    const explained = await explainUploadFailure(new TypeError("Failed to fetch"), offline);
    expect(submitErrorText(explained, NOW)).toBe(UPLOAD_OFFLINE_MESSAGE);
  });

  it("storage full: as today", async () => {
    const answer = (async () => Response.json({ storageFull: true, error: FULL })) as unknown as typeof fetch;
    const explained = await explainUploadFailure(new Error("Vercel Blob: Failed to  retrieve the client token"), answer);
    expect(submitErrorText(explained, NOW)).toBe(FULL);
  });

  // POST /api/posts has no idempotency key, so the post may have been saved:
  // the sentence names the page it would be on (composerSubmitOutcome's rule).
  it.each([
    ["Post now by an owner", "now", false, "Activity"],
    ["Schedule", "schedule", false, "Queue"],
    ["Draft", "draft", false, "Queue"],
    ["a member whose posts need approval", "now", true, "Queue"],
  ] as const)("post request offline: %s (%s, held %s) -> check %s", async (_name, mode, holdsForApproval, page) => {
    const error = await sendPostRequest("{}", offline).catch((err: unknown) => err);
    expect(submitErrorText(error, { mode, holdsForApproval })).toBe(
      `We lost the connection before Vibe Socials answered. Check ${page} to see whether the post was saved before you try again.`,
    );
  });

  it("a route refusal and a success: the answer comes back as it is", async () => {
    for (const answer of [Response.json({ error: "Refused" }, { status: 400 }), Response.json({ ok: true })]) {
      const fetchImpl = vi.fn(async () => answer);
      await expect(sendPostRequest('{"a":1}', fetchImpl as unknown as typeof fetch)).resolves.toBe(answer);
      expect(fetchImpl).toHaveBeenCalledWith("/api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"a":1}',
      });
    }
  });

  it("anything else keeps today's text", () => {
    expect(submitErrorText(new Error("boom"), NOW)).toBe("Unexpected error while creating post.");
    expect(submitErrorText(new TypeError("x is undefined"), NOW)).toBe("Unexpected error while creating post.");
    expect(submitErrorText("??", NOW)).toBe("Unexpected error while creating post.");
  });
});
