import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ToastProvider } from "@/components/ui/toast";

import { QueueCalendar, clientChangeLine, offCalendarSummary } from "./queue-calendar";

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
