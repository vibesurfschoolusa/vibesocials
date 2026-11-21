import { describe, expect, it, vi } from "vitest";

import {
  DISCONNECT_MAYBE_MESSAGE,
  fetchScheduledCount,
  disconnectDescription,
  requestDisconnect,
  switchDescription,
  switchScheduledSentence,
} from "./connection-actions";

/**
 * G4 (R2-security L2): Disconnect deletes the post numbers read from that
 * platform, and the listing's numbers for Google Business Profile
 * (api/connections/[platform] DELETE). The dialogs say so.
 */

const GONE = "The post numbers read from this platform are deleted and cannot be brought back.";
const GBP_GONE =
  "The Google listing numbers read from it are deleted and cannot be brought back.";

describe("Disconnect dialog", () => {
  it.each(["youtube", "instagram", "facebook_page", "linkedin", "pinterest"])(
    "%s: says its numbers are deleted for good",
    (platform) => {
      const text = disconnectDescription(platform, 0);
      expect(text).toContain(GONE);
      expect(text).toContain("Your past posts stay in Activity");
    },
  );

  it("Google Business Profile: names the listing numbers too", () => {
    expect(disconnectDescription("google_business_profile", 0)).toContain(GBP_GONE);
  });

  it.each(["x", "tiktok"])("%s: says nothing about numbers (none are read)", (platform) => {
    expect(disconnectDescription(platform, 0)).not.toContain("numbers");
  });

  // R5 pages M1: a scheduled post that chose this platform gets a failed
  // CONNECTION_GONE result on it (server/jobs/posting.ts); it does not skip it.
  it("never says scheduled posts skip the platform", () => {
    for (const count of [null, 0, 1, 4]) {
      expect(disconnectDescription("instagram", count)).not.toContain("skip");
    }
  });

  // R61 pages-a-2 L1: the count takes in posts waiting for approval, so the
  // sentence names them too.
  it("0: no scheduled post, or post waiting for approval, chose it, so none will fail", () => {
    expect(disconnectDescription("instagram", 0)).toContain(
      "No scheduled post, or post waiting for approval, chose Instagram, so none will fail on it.",
    );
    expect(disconnectDescription("x", 0)).toContain("No scheduled post, or post waiting for approval, chose X, so none will fail on it.");
  });

  it("1: the one post will fail on it until it is reconnected", () => {
    expect(disconnectDescription("instagram", 1)).toContain(
      "1 scheduled post, or post waiting for approval, chose Instagram. It will fail on Instagram until you reconnect it.",
    );
  });

  it("2: the posts will fail on it until it is reconnected", () => {
    expect(disconnectDescription("instagram", 2)).toContain(
      "2 scheduled posts, or posts waiting for approval, chose Instagram. They will fail on Instagram until you reconnect it.",
    );
  });

  it("still warns when the count could not be read", () => {
    expect(disconnectDescription("youtube", null)).toContain(
      "Scheduled posts, and posts waiting for approval, that chose YouTube will fail on it until you reconnect it.",
    );
  });
});

describe("fetchScheduledCount", () => {
  it("asks the server for the rendered workspace's count", async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify({ count: 3 }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchScheduledCount("instagram", "ws 1", impl)).resolves.toBe(3);
    expect(impl).toHaveBeenCalledWith("/api/connections/instagram/scheduled-count?workspaceId=ws%201");
  });

  it("answers null when the count can't be read, so the dialog shows no number", async () => {
    const failing = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchScheduledCount("instagram", "ws-1", failing)).resolves.toBeNull();
    const odd = vi.fn(async () => new Response(JSON.stringify({ count: "3" }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchScheduledCount("instagram", "ws-1", odd)).resolves.toBeNull();
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(fetchScheduledCount("instagram", "ws-1", offline)).resolves.toBeNull();
  });
});

// R5 pages L8: a disconnect failure says what happened and what to do, never
// a raw "Failed to fetch".
describe("requestDisconnect", () => {
  // R28 NN2 (pages L1): the route may have removed the connection before the
  // answer was lost or a gateway answered 5xx, so never "still connected".
  it("no answer: the account may already be disconnected, and where to check", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(requestDisconnect(offline, "x", "ws-1")).rejects.toThrow(DISCONNECT_MAYBE_MESSAGE);
    expect(DISCONNECT_MAYBE_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so the account may already be disconnected. If your connection dropped, reconnect first. Reload this page to see whether it is connected.",
    );
  });

  it("a server failure says the same: it may have gone through", async () => {
    for (const failing of [
      vi.fn(async () => new Response(JSON.stringify({ error: "Failed to disconnect platform" }), { status: 500 })),
      vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })),
    ]) {
      await expect(requestDisconnect(failing as unknown as typeof fetch, "x", "ws-1")).rejects.toThrow(DISCONNECT_MAYBE_MESSAGE);
    }
  });

  it("passes on the route's own refusal sentence", async () => {
    const refused = vi.fn(
      async () => new Response(JSON.stringify({ error: "That tab was for another workspace." }), { status: 409 }),
    ) as unknown as typeof fetch;
    await expect(requestDisconnect(refused, "x", "ws-1")).rejects.toThrow("That tab was for another workspace.");
  });

  it("resolves when the route says it worked", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    await expect(requestDisconnect(ok, "x", "ws-1")).resolves.toBeUndefined();
  });
});

describe("Switch account dialog", () => {
  it("says the current account's numbers are deleted for good", () => {
    const text = switchDescription("youtube");
    expect(text).toContain("This disconnects your current account and sends you to reconnect a different one.");
    expect(text).toContain(GONE);
  });

  it("Google Business Profile: names the listing numbers too", () => {
    expect(switchDescription("google_business_profile")).toContain(GBP_GONE);
  });

  // R6-pages L3: what happens to scheduled posts. R62 pages-b L1: and to posts
  // waiting for approval, as Disconnect's sentence says, since Switch disconnects first.
  it("standard confirm: scheduled and held posts go to the new account once the sign-in completes, and fail if it is abandoned", () => {
    const sentence =
      "Scheduled posts, and posts waiting for approval, that chose YouTube go to the new account once you finish signing in. If you stop before then, they fail on YouTube until you connect an account again.";
    expect(switchScheduledSentence("youtube")).toBe(sentence);
    expect(switchDescription("youtube")).toContain(sentence);
    expect(switchScheduledSentence("tiktok")).toContain(
      "Scheduled posts, and posts waiting for approval, that chose TikTok go to the new account",
    );
  });

  // R63 client-journey L2: a Google account posts nowhere until a location is chosen.
  it("Google Business Profile: the posts go to the new account once you sign in and choose its location", () => {
    const sentence =
      "Scheduled posts, and posts waiting for approval, that chose Google Business Profile go to the new account once you sign in and choose its location. If you stop before then, they fail on Google Business Profile until you connect an account again.";
    expect(switchScheduledSentence("google_business_profile")).toBe(sentence);
    expect(switchDescription("google_business_profile")).toContain(sentence);
  });

  it("another platform's dialog: unchanged, and says nothing about a location", () => {
    expect(switchScheduledSentence("linkedin")).toBe(
      "Scheduled posts, and posts waiting for approval, that chose LinkedIn go to the new account once you finish signing in. If you stop before then, they fail on LinkedIn until you connect an account again.",
    );
    expect(switchDescription("facebook")).not.toContain("location");
  });
});
