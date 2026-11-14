import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob/client", () => ({ upload: vi.fn() }));
vi.mock("@/hooks/useConnections", () => ({
  useConnections: () => ({ connections: null, loading: true, error: null, reload: () => {} }),
}));

import { refreshedFirstDay } from "@/lib/bulkPosts";
import { localTimeZoneLabel } from "@/lib/scheduling";

import { BulkPostsForm } from "./bulk-posts-form";

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

