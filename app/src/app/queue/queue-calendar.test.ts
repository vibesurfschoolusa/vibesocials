import { describe, expect, it } from "vitest";

import { offCalendarSummary } from "./queue-calendar";

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
