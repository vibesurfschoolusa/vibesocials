import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob/client", () => ({ upload: vi.fn() }));
vi.mock("@/hooks/useConnections", () => ({
  useConnections: () => ({ connections: null, loading: true, error: null, reload: () => {} }),
}));

import { refreshedFirstDay } from "@/lib/bulkPosts";
import { localTimeZoneLabel } from "@/lib/scheduling";

import { BulkPostsForm, NoPlatformConnectedLine } from "./bulk-posts-form";

const ORIGINAL_TZ = process.env.TZ;

// The markup React builds on a first render, in one time zone at one moment.
function firstRender(timeZone: string, isoNow: string): string {
  process.env.TZ = timeZone;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(isoNow));
  try {
    return renderToString(createElement(BulkPostsForm, { workspaceId: "ws_1" }));
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// Go-live check 2026-11-11: React error #418 on every open of /posts/bulk. The
// server (UTC) and the browser (America/Chicago) printed different zone names
// and first days, so the browser's first render must not depend on either.
describe("BulkPostsForm — first render is the same on the server and in the browser", () => {
  // 03:30 UTC on the 12th is still the 11th in Chicago: the two "tomorrows" differ.
  const server = () => firstRender("UTC", "2026-11-12T03:30:00Z");
  const browser = () => firstRender("America/Chicago", "2026-11-12T03:35:00Z");

  it("renders the same markup whatever the zone and the clock", () => {
    expect(browser()).toBe(server());
  });

  it("prints no zone name and no date before mount", () => {
    const html = browser();
    expect(html).not.toContain("America/Chicago");
    expect(html).not.toContain("UTC");
    expect(html).not.toContain("2026-11-1");
  });

  it("after mount the browser's own zone and tomorrow are what fill the page", () => {
    process.env.TZ = "America/Chicago";
    expect(localTimeZoneLabel()).toBe("America/Chicago");
    // The mount fills the empty first day with the browser's tomorrow.
    expect(refreshedFirstDay({ firstDay: "", setByUser: false }, new Date("2026-11-12T03:35:00Z"))).toBe(
      "2026-11-12",
    );
  });
});

// 2026-11-14: a drop area like Media's instead of the browser's bare file control.
describe("Add many file picker", () => {
  it("keeps a real, visually hidden multi-file input inside a labelled drop area", () => {
    const html = firstRender("America/Chicago", "2026-11-14T10:00:00Z");
    expect(html).toMatch(/<input[^>]*id="bulk-files"[^>]*>/);
    const input = html.match(/<input[^>]*id="bulk-files"[^>]*>/)![0];
    expect(input).toContain('type="file"');
    expect(input).toContain('multiple=""');
    expect(input).toContain('accept="video/*,image/*"');
    expect(input).toMatch(/class="[^"]*\bsr-only\b/);
    expect(html).toMatch(/<label[^>]*for="bulk-files"[^>]*>Choose photos and videos<\/label>/);
    expect(html).toContain("or drag them here");
  });
});


// P1 fix 1: every batch control sits inside the one fieldset that sending disables.
describe("Add many batch card", () => {
  it("platforms and when are inside the batch fieldset; the file picker is not", () => {
    const html = firstRender("America/Chicago", "2026-11-14T10:00:00Z");
    const start = html.indexOf("data-bulk-batch-settings");
    expect(start).toBeGreaterThan(-1);
    expect(html.indexOf('id="bulk-files"')).toBeLessThan(start);
    for (const id of ["bulk-first-day", "bulk-time", "bulk-every"]) {
      expect(html.indexOf(`id="${id}"`)).toBeGreaterThan(start);
    }
    expect(html.indexOf("Post every row to")).toBeGreaterThan(start);
  });
});

// R20 publishing L1: no platform uses a post's location (YouTube deprecated
// recordingDetails' location fields; Instagram never sends a location_id).
describe("Add many: no Location field", () => {
  it("renders no Location field or place search", async () => {
    const html = firstRender("America/Chicago", "2026-11-14T10:00:00Z");
    expect(html).not.toContain('id="bulk-location"');
    expect(html).not.toContain("Location (optional)");
    expect(html).not.toContain("Start typing a location");
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./bulk-posts-form.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("LocationAutocomplete");
    expect(source).not.toMatch(/\bsetLocation\b/);
  });
});

// P1 second review: typing a description replaces a failed "Write it for me"
// message instead of leaving it under the new text.
describe("photo description typing", () => {
  it("clears the description error when the person types", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./bulk-posts-form.tsx", import.meta.url), "utf8");
    expect(source).toContain("onAltTextChange={(altText) => updateRow(row.id, { altText, altTextError: null })}");
  });
});

// F7 (R1 M2): the switch sits on the page, on unless this browser turned it off.
describe("Add many: Write captions with AI", () => {
  it("renders a labelled switch, on by default", () => {
    const html = firstRender("America/Chicago", "2026-11-14T10:00:00Z");
    const input = html.match(/<input[^>]*id="bulk-ai-captions"[^>]*>/)?.[0];
    expect(input).toBeDefined();
    expect(input).toContain('type="checkbox"');
    expect(input).toContain('checked=""');
    expect(html).toMatch(/<label[^>]*for="bulk-ai-captions"[^>]*>Write captions with AI<\/label>/);
  });

  it("the caption step sends nothing to the AI while it is off", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./bulk-posts-form.tsx", import.meta.url), "utf8");
    expect(source).toContain("{ ai: aiCaptionsRef.current }");
  });
});

// R11-client-journey L2: only the owner can connect, so a member is not sent to Settings.
describe("NoPlatformConnectedLine", () => {
  it("owner: connect one in Settings", () => {
    const html = renderToString(createElement(NoPlatformConnectedLine, { isMember: false }));
    expect(html).toContain("Connect one in Settings");
    expect(html).toContain('href="/settings#connections"');
  });

  it("member: the owner can connect, no link", () => {
    const html = renderToString(createElement(NoPlatformConnectedLine, { isMember: true }));
    expect(html).toContain("No platform here is connected yet. The workspace owner can connect accounts for this workspace.");
    expect(html).not.toContain("<a");
  });

  // R12-new-customer L3: TikTok is never offered here, so with only TikTok
  // connected "no platform is connected" was untrue.
  it("owner, only TikTok connected: says TikTok is left out, then connect one in Settings", () => {
    const html = renderToString(createElement(NoPlatformConnectedLine, { isMember: false, onlyTikTok: true })).replace(
      /<!-- -->/g,
      "",
    );
    expect(html).toContain("Add many posts to every platform except TikTok, and none of those is connected yet.");
    expect(html).not.toContain("No platform here is connected yet.");
    expect(html).toContain('href="/settings#connections"');
  });

  it("member, only TikTok connected: says TikTok is left out and who can connect", () => {
    const html = renderToString(createElement(NoPlatformConnectedLine, { isMember: true, onlyTikTok: true }));
    expect(html).toContain(
      "Add many posts to every platform except TikTok, and none of those is connected yet. The workspace owner can connect accounts for this workspace.",
    );
    expect(html).not.toContain("<a");
  });
});

describe("Add many, which line it shows with nothing to offer", () => {
  it("passes whether a connected TikTok is the only reason the list is empty", () => {
    const source = readFileSync(path.join(__dirname, "bulk-posts-form.tsx"), "utf8");
    expect(source).toContain("<NoPlatformConnectedLine isMember={isMember} onlyTikTok={tiktokConnected} />");
    expect(source).toMatch(/const tiktokConnected = [^;]*c\.platform === "tiktok" && c\.connected/);
  });

  it("uses the shared posting-times prompt, which knows a member", () => {
    const source = readFileSync(path.join(__dirname, "bulk-posts-form.tsx"), "utf8");
    expect(source).toContain("<SetPostingTimesPrompt isMember={isMember} />");
    expect(source).not.toContain("Set your posting times");
  });
});

// R26 LL3 item 5: the send button that is working keeps keyboard focus
// (Button's loading ignores the press); the other one waits, disabled.
describe("Schedule all and Save all as drafts while sending", () => {
  const source = readFileSync(path.join(__dirname, "bulk-posts-form.tsx"), "utf8");
  it.each(["schedule", "draft"])("the %s button is loading, not disabled", (mode) => {
    const other = mode === "schedule" ? "draft" : "schedule";
    expect(source).toContain(
      `disabled={busy || sendingMode === "${other}" || selectedPlatforms.length === 0}\n            loading={sendingMode === "${mode}"}`,
    );
  });
});
