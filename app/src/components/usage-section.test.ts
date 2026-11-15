import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const render = (value: WorkspaceUsage | null, timeZone: string | null = null) =>
  renderToStaticMarkup(createElement(UsageSection, { usage: value, timeZone })).replace(/<!-- -->/g, "");

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  // R9-pages L7: the first-day note gives the viewer's own time, like the refusal; every date one way.
  it("the first day ends at 00:00 UTC, in the viewer's own time too; the X date as Settings writes dates", () => {
    const person = { userId: "u-1", name: "Jane", isViewer: true, used: 1, limit: 5, reduced: "first_day_unconfirmed" as const };
    const html = render(usage([person]), "America/New_York");
    expect(html).toContain(
      "5 on the account&#x27;s first day (UTC), 15 from 00:00 UTC tomorrow (Saturday, 7:00 PM EST) once you confirm your email address.",
    );
    expect(render(usage([person]))).toContain("15 from 00:00 UTC tomorrow once you confirm your email address.");
    expect(html).toContain("Starts again on December 1, 2026.");
    expect(html).toContain("Starts again at 00:00 UTC on November 15, 2026.");
  });

  // R9-pages L5: no one raises the per-person number, so its row says it is the same for everyone.
  it("the per-person row says its number is the same for everyone", () => {
    const html = render(usage([{ userId: "u-1", name: "Jane", isViewer: true, used: 1, limit: 15, reduced: null }]));
    expect(html).toContain("Retries count too. The per-person number is the same for everyone.");
  });

  // R9-pages L4: with billing on paid workspaces are not counted.
  it("with billing on: your free workspaces, in the label and the member line", () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const html = render(usage([{ userId: "u-1", name: "Jane", isViewer: true, used: 1, limit: 15, reduced: null }]));
    expect(html).toContain("Your posts today (UTC), your free workspaces");
    expect(html).toContain("The per-person number is the same for everyone while free.");
    expect(html).not.toContain("all your workspaces");
    const member = render({ ...usage(undefined), stillToday: { remaining: 3, decidedBy: "owner", coOwned: false } });
    expect(member).toContain("The daily limit of its owner, counted across the free workspaces they own (retries too), leaves 3 posts.");
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

  // Review of T1, item 4: a member reads only what the workspace can still send, and why.
  it("a member: how many posts the workspace can still send today and why, with no owner named", () => {
    const html = render({ ...usage(undefined), stillToday: { remaining: 3, decidedBy: "owner", coOwned: true } });
    expect(html).toContain("Posts today (UTC), this workspace");
    expect(html).toContain("Posts this workspace can still send today (UTC)");
    expect(html).toContain("3 left");
    expect(html).toContain(
      "The daily limit of one of its owners, counted across all the workspaces they own (retries too), leaves 3 posts.",
    );
    expect(html).not.toContain("all your workspaces");
    expect(html).not.toContain("@");

    const none = render({ ...usage(undefined), stillToday: { remaining: 0, decidedBy: "workspace", coOwned: false } });
    expect(none).toContain("This workspace&#x27;s own daily limit leaves 0 posts.");
    expect(none).toMatch(/text-destructive[^>]*>0 left</);
  });

  it("no per-person line where the limit does not apply (paying, the operator's), and the plain label", () => {

    const html = render(usage([]));
    expect(html).toContain("Posts today (UTC)");
    expect(html).not.toContain("this workspace");
    expect(html).not.toContain("all your workspaces");
    expect(render(usage(undefined))).not.toContain("all your workspaces");
  });
});
