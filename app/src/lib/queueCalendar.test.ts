import { describe, expect, it } from "vitest";

import {
  buildCalendarMonth,
  groupJobsByDay,
  localDayKey,
  retargetSchedule,
  summarizeOffCalendar,
} from "./queueCalendar";

// All dates below are constructed from LOCAL components so the tests are
// timezone-independent (the module's contract is browser-local days).

describe("localDayKey", () => {
  it("formats local date parts with zero padding", () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localDayKey(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31");
  });
});

describe("buildCalendarMonth", () => {
  it("covers July 2026 in Sunday-start weeks with padded edges", () => {
    const weeks = buildCalendarMonth(2026, 6); // July 2026: 1st is a Wednesday
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    // First cell is Sunday June 28; last week ends Saturday August 1.
    expect(weeks[0][0]).toMatchObject({ key: "2026-06-28", inMonth: false });
    expect(weeks[0][3]).toMatchObject({ key: "2026-07-01", dayOfMonth: 1, inMonth: true });
    const lastWeek = weeks[weeks.length - 1];
    expect(lastWeek[6]).toMatchObject({ key: "2026-08-01", inMonth: false });
    // Every July day is present exactly once and marked inMonth.
    const julyDays = weeks.flat().filter((d) => d.inMonth);
    expect(julyDays).toHaveLength(31);
  });

  it("handles February in a leap year", () => {
    const days = buildCalendarMonth(2028, 1).flat().filter((d) => d.inMonth);
    expect(days).toHaveLength(29);
  });
});

describe("groupJobsByDay", () => {
  it("groups scheduled jobs by local day, sorted by time, skipping null dates", () => {
    const at = (d: Date) => d.toISOString();
    const jobs = [
      { id: "b", scheduledFor: at(new Date(2026, 6, 15, 14, 0)) },
      { id: "a", scheduledFor: at(new Date(2026, 6, 15, 9, 30)) },
      { id: "other-day", scheduledFor: at(new Date(2026, 6, 16, 8, 0)) },
      { id: "draft", scheduledFor: null },
    ];
    const grouped = groupJobsByDay(jobs);
    expect(grouped.get("2026-07-15")?.map((j) => (j as { id: string }).id)).toEqual(["a", "b"]);
    expect(grouped.get("2026-07-16")).toHaveLength(1);
    expect([...grouped.values()].flat()).toHaveLength(3);
  });
});

describe("summarizeOffCalendar", () => {
  it("counts posts awaiting approval separately from dateless drafts", () => {
    const jobs = [
      { status: "scheduled", approvalState: "none", scheduledFor: "2026-08-01T10:00:00Z" },
      // Held for approval — it HAS a proposed time, so calling it "without a
      // date" would be wrong.
      { status: "draft", approvalState: "pending", scheduledFor: "2026-08-12T09:30:00Z" },
      { status: "draft", approvalState: "pending", scheduledFor: null },
      { status: "draft", approvalState: "none", scheduledFor: null },
    ] as const;

    expect(summarizeOffCalendar([...jobs])).toEqual({ awaitingApproval: 2, drafts: 1 });
  });

  it("counts nothing when every post is on the calendar", () => {
    expect(
      summarizeOffCalendar([
        { status: "scheduled", approvalState: "none", scheduledFor: "2026-08-01T10:00:00Z" },
      ]),
    ).toEqual({ awaitingApproval: 0, drafts: 0 });
  });
});

describe("retargetSchedule", () => {
  const NOW = new Date(2026, 6, 15, 12, 0); // local noon, Jul 15 2026
  const BUFFER = 60_000;

  it("moves the date but preserves the local time-of-day", () => {
    const original = new Date(2026, 6, 20, 9, 30).toISOString();
    const result = retargetSchedule(original, "2026-07-22", NOW, BUFFER);
    expect(result).not.toBeNull();
    const moved = new Date(result!);
    expect(localDayKey(moved)).toBe("2026-07-22");
    expect(moved.getHours()).toBe(9);
    expect(moved.getMinutes()).toBe(30);
  });

  it("rejects a target in the past", () => {
    const original = new Date(2026, 6, 20, 9, 30).toISOString();
    expect(retargetSchedule(original, "2026-07-10", NOW, BUFFER)).toBeNull();
  });

  it("rejects a same-day move whose preserved time already passed", () => {
    const original = new Date(2026, 6, 20, 9, 30).toISOString(); // 09:30 < NOW 12:00
    expect(retargetSchedule(original, "2026-07-15", NOW, BUFFER)).toBeNull();
  });

  it("allows a same-day move whose preserved time is still ahead of the buffer", () => {
    const original = new Date(2026, 6, 20, 18, 0).toISOString();
    const result = retargetSchedule(original, "2026-07-15", NOW, BUFFER);
    expect(result).not.toBeNull();
  });

  it("returns null for an invalid day key", () => {
    const original = new Date(2026, 6, 20, 9, 30).toISOString();
    expect(retargetSchedule(original, "not-a-day", NOW, BUFFER)).toBeNull();
  });
});
