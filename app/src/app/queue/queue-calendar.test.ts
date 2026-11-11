import { describe, expect, it } from "vitest";

import { clientChangeLine, offCalendarSummary } from "./queue-calendar";

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
