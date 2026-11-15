import { describe, expect, it, vi } from "vitest";

import {
  DISCONNECT_FAILED_MESSAGE,
  DISCONNECT_OFFLINE_MESSAGE,
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

  it("says how many scheduled posts will fail on it until it is reconnected", () => {
    expect(disconnectDescription("instagram", 1)).toContain(
      "1 scheduled post chose Instagram. It will fail on Instagram until you reconnect it.",
    );
    expect(disconnectDescription("instagram", 3)).toContain(
      "3 scheduled posts chose Instagram. They will fail on Instagram until you reconnect it.",
    );
  });

  it("says none will fail when no scheduled post chose it", () => {
    expect(disconnectDescription("x", 0)).toContain("No scheduled post chose X, so none will fail on it.");
  });

  it("still warns when the count could not be read", () => {
    expect(disconnectDescription("youtube", null)).toContain(
      "Scheduled posts that chose YouTube will fail on it until you reconnect it.",
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
  it("names a network failure instead of the browser's message", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(requestDisconnect(offline, "x", "ws-1")).rejects.toThrow(DISCONNECT_OFFLINE_MESSAGE);
    expect(DISCONNECT_OFFLINE_MESSAGE).toContain("still connected");
  });

  it("uses its own sentence for a server failure", async () => {
    const failing = vi.fn(
      async () => new Response(JSON.stringify({ error: "Failed to disconnect platform" }), { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(requestDisconnect(failing, "x", "ws-1")).rejects.toThrow(DISCONNECT_FAILED_MESSAGE);
    expect(DISCONNECT_FAILED_MESSAGE).toContain("try again");
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

  // R6-pages L3: what happens to scheduled posts.
  it("says scheduled posts go to the new account once the sign-in completes, and fail if it is abandoned", () => {
    const sentence =
      "Scheduled posts that chose YouTube go to the new account once you finish signing in. If you stop before then, they fail on YouTube until you connect an account again.";
    expect(switchScheduledSentence("youtube")).toBe(sentence);
    expect(switchDescription("youtube")).toContain(sentence);
    expect(switchScheduledSentence("tiktok")).toContain("Scheduled posts that chose TikTok go to the new account");
  });
});
