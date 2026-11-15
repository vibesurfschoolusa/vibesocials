import { describe, expect, it, vi } from "vitest";

import {
  DISCONNECT_FAILED_MESSAGE,
  DISCONNECT_OFFLINE_MESSAGE,
  countScheduledPostsChoosing,
  disconnectDescription,
  requestDisconnect,
  switchDescription,
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

type Page = { jobs: Array<{ id: string; storyOf?: { id: string }; publish: { targetPlatforms: string[] | null } | null }>; nextCursor: string | null };

function pagesFetch(pages: Page[]) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    calls.push(url);
    const page = pages[calls.length - 1];
    return new Response(JSON.stringify(page), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("countScheduledPostsChoosing", () => {
  it("counts the scheduled posts whose chosen platforms name it, across pages", async () => {
    const { impl, calls } = pagesFetch([
      {
        jobs: [
          { id: "a", publish: { targetPlatforms: ["instagram", "x"] } },
          { id: "b", publish: { targetPlatforms: ["x"] } },
          { id: "c", publish: null },
          { id: "d", publish: { targetPlatforms: null } },
        ],
        nextCursor: "next-1",
      },
      { jobs: [{ id: "e", publish: { targetPlatforms: ["instagram"] } }], nextCursor: null },
    ]);
    await expect(countScheduledPostsChoosing("instagram", impl)).resolves.toBe(2);
    expect(calls[0]).toBe("/api/posts?status=scheduled");
    expect(calls[1]).toBe("/api/posts?status=scheduled&cursor=next-1");
  });

  it("counts a Feed and Story post once", async () => {
    const { impl } = pagesFetch([
      {
        jobs: [
          { id: "feed", publish: { targetPlatforms: ["instagram"] } },
          { id: "story", storyOf: { id: "feed" }, publish: { targetPlatforms: ["instagram"] } },
        ],
        nextCursor: null,
      },
    ]);
    await expect(countScheduledPostsChoosing("instagram", impl)).resolves.toBe(1);
  });

  it("answers null when the list can't be read", async () => {
    const failing = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    await expect(countScheduledPostsChoosing("instagram", failing)).resolves.toBeNull();
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(countScheduledPostsChoosing("instagram", offline)).resolves.toBeNull();
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
});
