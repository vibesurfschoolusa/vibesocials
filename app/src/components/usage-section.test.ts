import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WorkspaceUsage } from "@/server/usage/workspaceUsage";

import { UsageSection } from "./usage-section";

const MB = 1024 * 1024;
const RESET = new Date("2026-11-15T00:00:00Z");

function usage(people: WorkspaceUsage["people"]): WorkspaceUsage {
  return {
    postsToday: { used: 3, limit: 20, resetsAt: RESET },
    xPostsThisMonth: { used: 0, limit: 30, resetsAt: new Date("2026-12-01T00:00:00Z") },
    youtubeUploadsToday: { used: 0, limit: 10, resetsAt: new Date("2026-11-15T08:00:00Z") },
    storage: { used: 0, limit: 5120 * MB, resetsAt: null },
    ...(people ? { people } : {}),
  };
}

const render = (value: WorkspaceUsage | null) =>
  renderToStaticMarkup(createElement(UsageSection, { usage: value })).replace(/<!-- -->/g, "");

// R8-pages M1: the binding number for the person, beside the workspace's own line.
describe("UsageSection", () => {
  it("shows the viewer's own count across all their workspaces beside the workspace's line", () => {
    const html = render(usage([{ userId: "u-1", name: "Jane", isViewer: true, used: 14, limit: 15, reduced: null }]));
    expect(html).toContain("Posts today (UTC), this workspace");
    expect(html).toContain("3 of 20");
    expect(html).toContain("Your posts today (UTC), all your workspaces");
    expect(html).toContain("14 of 15");
    expect(html).toContain("Retries count too.");
  });

  it("5 with its reason, marked when reached", () => {
    const html = render(usage([{ userId: "u-1", name: "Jane", isViewer: true, used: 5, limit: 5, reduced: "first_day" }]));
    expect(html).toContain("5 on the account&#x27;s first day (UTC), 15 from 00:00 UTC tomorrow.");
    expect(html).toMatch(/text-destructive[^>]*>5 of 5</);
  });

  it("names each owner of a co-owned workspace", () => {
    const html = render(
      usage([
        { userId: "u-1", name: "Jane", isViewer: false, used: 2, limit: 15, reduced: null },
        { userId: "u-2", name: "Maria", isViewer: false, used: 1, limit: 5, reduced: "unconfirmed" },
      ]),
    );
    expect(html).toContain("Jane&#x27;s posts today (UTC), all their workspaces");
    expect(html).toContain("Maria&#x27;s posts today (UTC), all their workspaces");
  });

  it("no per-person line where the limit does not apply (paying, the operator's), and the plain label", () => {
    const html = render(usage([]));
    expect(html).toContain("Posts today (UTC)");
    expect(html).not.toContain("this workspace");
    expect(html).not.toContain("all your workspaces");
    expect(render(usage(undefined))).not.toContain("all your workspaces");
  });
});
