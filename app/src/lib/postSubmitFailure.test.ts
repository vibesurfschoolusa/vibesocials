import { describe, expect, it, vi } from "vitest";

import { POST_CONNECTION_LOST_MESSAGE, sendPostRequest, submitErrorText } from "./postSubmitFailure";
import { explainUploadFailure, UPLOAD_OFFLINE_MESSAGE } from "./uploadFailure";

// R24 JJ2 follow-up: what Create's Post button says when the press fails
// before an answer: an upload that never reached us, or the post request lost.
describe("Create's submit failure", () => {
  const offline = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
  const FULL = "This workspace's media storage is full (5.0 GB). Delete media you no longer need on the Media page, then upload again.";

  it("upload offline at submit: the upload sentence", async () => {
    const explained = await explainUploadFailure(new TypeError("Failed to fetch"), offline);
    expect(submitErrorText(explained)).toBe(UPLOAD_OFFLINE_MESSAGE);
  });

  it("storage full: as today", async () => {
    const answer = (async () => Response.json({ storageFull: true, error: FULL })) as unknown as typeof fetch;
    const explained = await explainUploadFailure(new Error("Vercel Blob: Failed to  retrieve the client token"), answer);
    expect(submitErrorText(explained)).toBe(FULL);
  });

  it("post request offline: it may have reached us (no idempotency key), so check Queue", async () => {
    const error = await sendPostRequest("{}", offline).catch((err: unknown) => err);
    expect(submitErrorText(error)).toBe(POST_CONNECTION_LOST_MESSAGE);
    expect(POST_CONNECTION_LOST_MESSAGE).toBe(
      "We lost the connection before Vibe Socials answered. Check Queue to see whether the post was saved before you try again.",
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
    expect(submitErrorText(new Error("boom"))).toBe("Unexpected error while creating post.");
    expect(submitErrorText(new TypeError("x is undefined"))).toBe("Unexpected error while creating post.");
    expect(submitErrorText("??")).toBe("Unexpected error while creating post.");
  });
});
