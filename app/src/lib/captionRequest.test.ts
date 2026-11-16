import { describe, expect, it, vi } from "vitest";

import { CAPTION_FAILED_MESSAGE, CAPTION_OFFLINE_MESSAGE, requestCaption } from "./captionRequest";

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
    expect(CAPTION_OFFLINE_MESSAGE).toBe(
      "We couldn't reach Vibe Socials, so your caption is unchanged. Check your connection and try again.",
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
});
