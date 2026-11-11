import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_POSTING_SLOTS,
  nextFreeSlots,
  normalizePostingSlots,
  readPostingSlots,
} from "./postingSlots";

const local = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ` +
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

describe("normalizePostingSlots", () => {
  it("sorts by weekday then time and drops duplicates", () => {
    const result = normalizePostingSlots([
      { day: 4, time: "18:00" },
      { day: 1, time: "09:30" },
      { day: 4, time: "08:00" },
      { day: 1, time: "09:30" },
    ]);
    expect(result).toEqual({
      ok: true,
      slots: [
        { day: 1, time: "09:30" },
        { day: 4, time: "08:00" },
        { day: 4, time: "18:00" },
      ],
    });
  });

  it("keeps only day and time from each entry", () => {
    expect(normalizePostingSlots([{ day: 0, time: "07:05", extra: "x" }])).toEqual({
      ok: true,
      slots: [{ day: 0, time: "07:05" }],
    });
  });

  it("reads null as no times", () => {
    expect(normalizePostingSlots(null)).toEqual({ ok: true, slots: [] });
  });

  it("refuses a bad weekday or time", () => {
    for (const entry of [
      { day: 7, time: "09:00" },
      { day: -1, time: "09:00" },
      { day: 1.5, time: "09:00" },
      { day: "1", time: "09:00" },
      { day: 1, time: "24:00" },
      { day: 1, time: "9:00" },
      { day: 1, time: "09:60" },
      { day: 1 },
      null,
      "Monday 9:00",
    ]) {
      expect(normalizePostingSlots([entry])).toEqual({
        ok: false,
        error: "Each posting time needs a weekday and a time like 09:30.",
      });
    }
    expect(normalizePostingSlots("x")).toEqual({
      ok: false,
      error: "Posting times must be a list of weekdays and times.",
    });
  });

  it("allows 21 times and refuses 22, counting after duplicates are dropped", () => {
    const times = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ day: i % 7, time: `${String(8 + Math.floor(i / 7)).padStart(2, "0")}:00` }));
    expect(normalizePostingSlots(times(MAX_POSTING_SLOTS)).ok).toBe(true);
    expect(normalizePostingSlots([...times(MAX_POSTING_SLOTS), { day: 0, time: "08:00" }]).ok).toBe(true);
    expect(normalizePostingSlots(times(MAX_POSTING_SLOTS + 1))).toEqual({
      ok: false,
      error: "You can save up to 21 posting times. Remove some, then save again.",
    });
  });
});

describe("readPostingSlots", () => {
  it("gives the saved times, or none for a missing or broken value", () => {
    expect(readPostingSlots([{ day: 2, time: "10:00" }])).toEqual([{ day: 2, time: "10:00" }]);
    expect(readPostingSlots(null)).toEqual([]);
    expect(readPostingSlots({ day: 2 })).toEqual([]);
  });
});

describe("nextFreeSlots", () => {
  // Tuesday 10 November 2026, 08:00 local.
  const now = new Date(2026, 10, 10, 8, 0);
  const slots = [
    { day: 2, time: "09:00" }, // Tuesday
    { day: 4, time: "18:00" }, // Thursday
  ];

  it("gives nothing when no times are saved", () => {
    expect(nextFreeSlots([], [], now, 3)).toEqual([]);
  });

  it("gives the next slot times after now, in order", () => {
    expect(nextFreeSlots(slots, [], now, 3).map(local)).toEqual([
      "2026-11-10 09:00",
      "2026-11-12 18:00",
      "2026-11-17 09:00",
    ]);
  });

  it("skips a slot less than 10 minutes ahead", () => {
    const close = new Date(2026, 10, 10, 8, 51);
    expect(nextFreeSlots(slots, [], close, 1).map(local)).toEqual(["2026-11-12 18:00"]);
    const justEnough = new Date(2026, 10, 10, 8, 50);
    expect(nextFreeSlots(slots, [], justEnough, 1).map(local)).toEqual(["2026-11-10 09:00"]);
  });

  it("skips a slot with a post scheduled within 5 minutes of it", () => {
    const taken = [new Date(2026, 10, 10, 9, 4), new Date(2026, 10, 12, 17, 55)];
    expect(nextFreeSlots(slots, taken, now, 2).map(local)).toEqual(["2026-11-17 09:00", "2026-11-19 18:00"]);
  });

  it("keeps a slot whose nearest post is more than 5 minutes away", () => {
    const taken = [new Date(2026, 10, 10, 9, 6)];
    expect(nextFreeSlots(slots, taken, now, 1).map(local)).toEqual(["2026-11-10 09:00"]);
  });

  it("goes across the week boundary", () => {
    const sunday = [{ day: 0, time: "10:00" }, { day: 6, time: "20:00" }];
    const friday = new Date(2026, 10, 13, 12, 0);
    expect(nextFreeSlots(sunday, [], friday, 3).map(local)).toEqual([
      "2026-11-14 20:00",
      "2026-11-15 10:00",
      "2026-11-21 20:00",
    ]);
  });

  it("asks for several and gets that many, even many weeks ahead", () => {
    const twenty = nextFreeSlots(slots, [], now, 20);
    expect(twenty).toHaveLength(20);
    expect(local(twenty[19])).toBe("2027-01-14 18:00");
  });

  describe("across a daylight-saving change", () => {
    let savedTz: string | undefined;
    beforeEach(() => {
      savedTz = process.env.TZ;
      process.env.TZ = "America/New_York";
    });
    afterEach(() => {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    });

    it("keeps the wall-clock time when the clocks go back (2026-11-01 in New York)", () => {
      const saturday = new Date(2026, 9, 31, 12, 0);
      const found = nextFreeSlots([{ day: 0, time: "09:00" }, { day: 1, time: "09:00" }], [], saturday, 2);
      expect(found.map(local)).toEqual(["2026-11-01 09:00", "2026-11-02 09:00"]);
      expect(found.map((d) => d.toISOString())).toEqual([
        "2026-11-01T14:00:00.000Z",
        "2026-11-02T14:00:00.000Z",
      ]);
    });
  });
});
