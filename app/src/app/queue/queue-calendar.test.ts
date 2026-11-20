import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ToastProvider } from "@/components/ui/toast";

import { QueueCalendar, clientChangeLine, offCalendarSummary } from "./queue-calendar";
import { labelName } from "./queue-view";

function job(status: string, approvalState: string, scheduledFor: string | null) {
  return { status, approvalState, scheduledFor };
}

describe("offCalendarSummary", () => {
  it("counts as 'without a date' only the drafts that really have no time", () => {
    const summary = offCalendarSummary([
      job("draft", "none", null),
      // A draft the client asked to change keeps its time: it has a date.
      job("draft", "none", "2026-11-20T10:00:00.000Z"),
      job("scheduled", "none", "2026-11-21T10:00:00.000Z"),
    ]);
    expect(summary).toEqual({ awaitingApproval: 0, drafts: 1 });
  });

  it("still counts every post awaiting approval, with or without a time", () => {
    const summary = offCalendarSummary([
      job("draft", "pending", "2026-11-20T10:00:00.000Z"),
      job("draft", "pending", null),
    ]);
    expect(summary).toEqual({ awaitingApproval: 2, drafts: 0 });
  });
});

describe("clientChangeLine", () => {
  const changed = { status: "draft", approvalState: "none", scheduledFor: "2026-11-20T10:00:00.000Z", clientChangeRequestedAt: "2026-11-09T10:00:00.000Z" };

  it("names how many posts the client asked to change, and where they are", () => {
    expect(clientChangeLine([changed, changed, { ...changed, clientChangeRequestedAt: null }])).toBe(
      "2 posts: your client asked for a change. They are in the list view.",
    );
    expect(clientChangeLine([changed])).toBe("1 post: your client asked for a change. It is in the list view.");
  });

  it("says nothing when there are none, or only scheduled posts with old marks", () => {
    expect(clientChangeLine([])).toBeNull();
    expect(clientChangeLine([{ ...changed, status: "scheduled" }])).toBeNull();
  });
});

// N3: an empty Queue still shows the month, so the weeks ahead are visible.
describe("QueueCalendar with no posts", () => {
  function render(jobs: Parameters<typeof QueueCalendar>[0]["jobs"]) {
    return renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(QueueCalendar, {
          jobs,
          onShowList: () => {},
          onEdit: () => {},
          onRescheduled: () => {},
        }),
      ),
    );
  }

  it("renders the month grid, its navigation and the empty line", () => {
    const html = render([]);
    expect(html).toContain("Nothing scheduled this month.");
    expect(html).toContain("Previous month");
    expect(html).toContain("Next month");
    for (const day of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) expect(html).toContain(`>${day}<`);
    // Every month spans at least 28 day cells (4 weeks of 7).
    expect((html.match(/min-h-24/g) ?? []).length).toBeGreaterThanOrEqual(28);
  });

  it("does not show the empty line when there are posts", () => {
    const html = render([
      {
        id: "j1",
        status: "scheduled",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        scheduledFor: "2030-01-01T10:00:00.000Z",
        caption: "hi",
        platformCaptions: null,
        results: [],
        media: null,
        mediaCount: 1,
        publish: null,
        createdBy: null,
        approvalState: "none",
      },
    ]);
    expect(html).not.toContain("Nothing scheduled this month.");
  });
});

// R43 pages-a L5: a chip's name was only its time and caption, so two posts
// on different days read alike; each chip now starts with its date.
describe("QueueCalendar chips name their day", () => {
  it("a chip's name includes its date, in the viewer's format", () => {
    const now = new Date();
    const when = new Date(now.getFullYear(), now.getMonth(), 15, 10, 0);
    const html = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(QueueCalendar, {
          jobs: [
            {
              id: "j1",
              status: "scheduled",
              createdAt: "2026-11-01T00:00:00.000Z",
              updatedAt: "2026-11-01T00:00:00.000Z",
              scheduledFor: when.toISOString(),
              caption: "Summer sale",
              platformCaptions: null,
              results: [],
              media: null,
              mediaCount: 1,
              publish: null,
              createdBy: null,
              approvalState: "none",
            },
          ],
          onShowList: () => {},
          onEdit: () => {},
          onRescheduled: () => {},
        }),
      ),
    );
    const date = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(when);
    const chip = html.match(/<button[^>]*draggable[^>]*>([\s\S]*?)<\/button>/)![1];
    expect(chip).toContain(`<span class="sr-only">${date}, </span>`);
    expect(chip.replace(/<[^>]+>/g, "")).toMatch(new RegExp(`^${date}, .+ Summer sale$`));
  });
});

// R46 pages-a L3: a chip's name carries the caption's start by the Queue's
// 40-character rule (labelName, R5-pages L12); its title keeps the whole text.
describe("QueueCalendar chip names are short", () => {
  it("a 2,000-character caption gives a chip name of the rule's length plus the date", () => {
    const now = new Date();
    const when = new Date(now.getFullYear(), now.getMonth(), 15, 10, 0);
    const caption = "a".repeat(2000);
    const html = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(QueueCalendar, {
          jobs: [
            {
              id: "j1",
              status: "scheduled",
              createdAt: "2026-11-01T00:00:00.000Z",
              updatedAt: "2026-11-01T00:00:00.000Z",
              scheduledFor: when.toISOString(),
              caption,
              platformCaptions: null,
              results: [],
              media: null,
              mediaCount: 1,
              publish: null,
              createdBy: null,
              approvalState: "none",
            },
          ],
          onShowList: () => {},
          onEdit: () => {},
          onRescheduled: () => {},
        }),
      ),
    );
    const date = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(when);
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(when);
    const button = html.match(/<button[^>]*draggable[^>]*>[\s\S]*?<\/button>/)![0];
    const name = button.replace(/<[^>]+>/g, "");
    expect(name).toBe(`${date}, ${time} ${labelName(caption)}`);
    expect(labelName(caption).length).toBeLessThanOrEqual(40);
    expect(button).toContain(`title="${caption}"`);
  });
});
