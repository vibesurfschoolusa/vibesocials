import { describe, expect, it, vi } from "vitest";

import { CAPTION_EMPTY_MESSAGE, CAPTION_FAILED_MESSAGE, CAPTION_OFFLINE_MESSAGE, requestCaption } from "./captionRequest";

// R24 new-customer L3: "Improve caption" and "Caption from media" showed the
// browser's raw "Failed to fetch" / "Load failed" when the request never left.
describe("requestCaption", () => {
  const body = { caption: "Surf lesson today" };

  it("sends the body as JSON to the route", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ enhancedCaption: "Better" }));
    await requestCaption("/api/posts/enhance-caption", body, "enhancedCaption", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("/api/posts/enhance-caption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  });

  it("a failed fetch (Chrome): our sentence, not the browser's", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      requestCaption("/api/posts/enhance-caption", body, "enhancedCaption", fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual({ ok: false, error: CAPTION_OFFLINE_MESSAGE });
  });

  it("a failed fetch (Safari) says the same", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Load failed");
    });
    const result = await requestCaption("/api/posts/auto-caption", body, "caption", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, error: CAPTION_OFFLINE_MESSAGE });
    // Lead review 3 (R28 NN2): on a lost answer the AI ran (and used the allowance); only the answer is missing.
    expect(CAPTION_OFFLINE_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so the new caption isn't shown. If your connection dropped, reconnect first. Your caption is unchanged; try again.",
    );
  });

  it("an error answer that is not JSON: a plain sentence that the caption is unchanged", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    const result = await requestCaption("/api/posts/enhance-caption", body, "enhancedCaption", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, error: CAPTION_FAILED_MESSAGE });
    expect(CAPTION_FAILED_MESSAGE).toMatch(/your caption is unchanged/);
  });

  it("the route's own JSON error: its text, as today", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: "Too many requests, slow down." }, { status: 429 }));
    await expect(
      requestCaption("/api/posts/auto-caption", body, "caption", fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual({ ok: false, error: "Too many requests, slow down." });
  });

  it("a JSON error with no text: the plain sentence", async () => {
    const fetchImpl = vi.fn(async () => Response.json({}, { status: 500 }));
    await expect(
      requestCaption("/api/posts/auto-caption", body, "caption", fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual({ ok: false, error: CAPTION_FAILED_MESSAGE });
  });

  it("success: the named field, as today", async () => {
    const enhance = vi.fn(async () => Response.json({ enhancedCaption: "Better caption" }));
    await expect(
      requestCaption("/api/posts/enhance-caption", body, "enhancedCaption", enhance as unknown as typeof fetch),
    ).resolves.toEqual({ ok: true, caption: "Better caption" });

    const fromMedia = vi.fn(async () => Response.json({ caption: "From the photo" }));
    await expect(
      requestCaption("/api/posts/auto-caption", body, "caption", fromMedia as unknown as typeof fetch),
    ).resolves.toEqual({ ok: true, caption: "From the photo" });
  });

  it("a success answer that is not JSON: the plain sentence", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 }));
    await expect(
      requestCaption("/api/posts/auto-caption", body, "caption", fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual({ ok: false, error: CAPTION_FAILED_MESSAGE });
  });

  // R24 JJ2 review: a 200 without a caption used to empty the box (Improve).
  it.each([
    ["enhance-caption", "enhancedCaption", {}],
    ["enhance-caption", "enhancedCaption", { enhancedCaption: "   " }],
    ["enhance-caption", "enhancedCaption", { enhancedCaption: 42 }],
    ["auto-caption", "caption", {}],
    ["auto-caption", "caption", { caption: "" }],
  ])("a 200 from %s with no usable %s: caption unchanged, a plain sentence", async (route, field, answer) => {
    const fetchImpl = vi.fn(async () => Response.json(answer));
    await expect(
      requestCaption(`/api/posts/${route}`, body, field, fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual({ ok: false, error: CAPTION_EMPTY_MESSAGE });
    expect(CAPTION_EMPTY_MESSAGE).toBe("The AI sent back no caption, so your caption is unchanged. Try again, or write it yourself.");
  });
});
