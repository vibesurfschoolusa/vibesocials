import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  repeatRefusalText,
  REPEAT_MAX_COUNT,
  REPEAT_MIN_COUNT,
  repeatSchedule,
  validateRepeatAt,
} from "./repeatSchedule";

// Local wall-clock fields of a date, so the expectations read the way the
// person sees them whatever zone the test runs in.
const local = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ` +
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

describe("repeatSchedule", () => {
  it("every week: the same weekday and time, seven days apart, the first included", () => {
    const dates = repeatSchedule(new Date(2026, 10, 12, 9, 0), "weekly", 4);
    expect(dates.map(local)).toEqual([
      "2026-11-12 09:00",
      "2026-11-19 09:00",
      "2026-11-26 09:00",
      "2026-12-03 09:00",
    ]);
  });

  it("every 2 weeks: fourteen days apart", () => {
    const dates = repeatSchedule(new Date(2026, 11, 24, 17, 30), "biweekly", 3);
    expect(dates.map(local)).toEqual(["2026-12-24 17:30", "2027-01-07 17:30", "2027-01-21 17:30"]);
  });

  it("every month: the same day of the month at the same time", () => {
    const dates = repeatSchedule(new Date(2026, 10, 15, 8, 15), "monthly", 3);
    expect(dates.map(local)).toEqual(["2026-11-15 08:15", "2026-12-15 08:15", "2027-01-15 08:15"]);
  });

  it("every month from the 31st: a month without one gets its last day, and the 31st comes back", () => {
    const dates = repeatSchedule(new Date(2027, 0, 31, 10, 0), "monthly", 5);
    expect(dates.map(local)).toEqual([
      "2027-01-31 10:00",
      "2027-02-28 10:00",
      "2027-03-31 10:00",
      "2027-04-30 10:00",
      "2027-05-31 10:00",
    ]);
  });

  it("every month from the 29th of January in a leap year: February 29th", () => {
    const dates = repeatSchedule(new Date(2028, 0, 29, 10, 0), "monthly", 2);
    expect(dates.map(local)).toEqual(["2028-01-29 10:00", "2028-02-29 10:00"]);
  });

  it("makes 2 and 12 occurrences, and nothing outside 2 to 12", () => {
    const first = new Date(2026, 10, 12, 9, 0);
    expect(repeatSchedule(first, "weekly", REPEAT_MIN_COUNT)).toHaveLength(2);
    const twelve = repeatSchedule(first, "monthly", REPEAT_MAX_COUNT);
    expect(twelve).toHaveLength(12);
    expect(local(twelve[11])).toBe("2027-10-12 09:00");
    expect(repeatSchedule(first, "weekly", 1)).toEqual([]);
    expect(repeatSchedule(first, "weekly", 13)).toEqual([]);
    expect(repeatSchedule(first, "weekly", 2.5)).toEqual([]);
    expect(repeatSchedule(new Date(Number.NaN), "weekly", 3)).toEqual([]);
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

    it("keeps 9:00 at 9:00 when the clocks go back (2026-11-01 in New York)", () => {
      const dates = repeatSchedule(new Date(2026, 9, 29, 9, 0), "weekly", 2);
      expect(dates.map(local)).toEqual(["2026-10-29 09:00", "2026-11-05 09:00"]);
      // The same 9:00 is 13:00 UTC before the change and 14:00 UTC after it.
      expect(dates.map((d) => d.toISOString())).toEqual([
        "2026-10-29T13:00:00.000Z",
        "2026-11-05T14:00:00.000Z",
      ]);
    });

    it("keeps the time monthly across the spring change", () => {
      const dates = repeatSchedule(new Date(2027, 1, 20, 18, 0), "monthly", 2);
      expect(dates.map((d) => d.toISOString())).toEqual([
        "2027-02-20T23:00:00.000Z",
        "2027-03-20T22:00:00.000Z",
      ]);
    });
  });
});

describe("validateRepeatAt", () => {
  const now = new Date("2026-11-10T12:00:00.000Z");
  const first = new Date("2026-11-12T09:00:00.000Z");
  const day = 24 * 60 * 60 * 1000;
  const at = (offsetMs: number) => new Date(first.getTime() + offsetMs).toISOString();

  it("accepts 1 to 11 later times at least 23 hours apart, as dates", () => {
    const result = validateRepeatAt([at(7 * day), at(14 * day)], first, now);
    expect(result).toEqual({ ok: true, dates: [new Date(at(7 * day)), new Date(at(14 * day))] });
    const eleven = Array.from({ length: 11 }, (_, i) => at((i + 1) * day));
    expect(validateRepeatAt(eleven, first, now).ok).toBe(true);
    expect(validateRepeatAt([at(23 * 60 * 60 * 1000)], first, now).ok).toBe(true);
  });

  it("refuses something that is not a list, an empty list and more than 11", () => {
    expect(validateRepeatAt("x", first, now)).toEqual({
      ok: false,
      error: "repeatAt must be a list of 1 to 11 dates and times.",
    });
    expect(validateRepeatAt([], first, now).ok).toBe(false);
    const twelve = Array.from({ length: 12 }, (_, i) => at((i + 1) * day));
    expect(validateRepeatAt(twelve, first, now)).toEqual({
      ok: false,
      error: "A post can repeat at most 12 times in total. Choose fewer repeats.",
    });
  });

  it("refuses an invalid or past time, naming which one", () => {
    expect(validateRepeatAt([at(day), "soon"], first, now)).toEqual({
      ok: false,
      error: "Repeat 2 is not a valid date and time.",
    });
    expect(validateRepeatAt(["2026-11-01T09:00:00.000Z"], first, now)).toEqual({
      ok: false,
      error: "Repeat 1 must be at least a minute in the future.",
    });
  });

  it("refuses times out of order or not after the first post", () => {
    expect(validateRepeatAt([at(14 * day), at(7 * day)], first, now)).toEqual({
      ok: false,
      error: "Repeat 2 must be later than the one before it.",
    });
    expect(validateRepeatAt([at(-day + 0)], new Date(first.getTime()), now)).toEqual({
      ok: false,
      error: "Repeat 1 must be later than the one before it.",
    });
  });

  it("refuses times less than 23 hours apart", () => {
    expect(validateRepeatAt([at(22 * 60 * 60 * 1000)], first, now)).toEqual({
      ok: false,
      error: "Repeat 1 is less than 23 hours after the one before it. Space the repeats at least a day apart.",
    });
  });
});

describe("repeatRefusalText", () => {
  const formatDate = (d: Date) => `local ${d.toISOString().slice(0, 10)}`;

  it("names the refused post's date as the viewer reads it", () => {
    expect(
      repeatRefusalText(
        { error: "The post on Friday (UTC) can't be scheduled. Full.", date: "2026-12-11T03:00:00.000Z", reason: "Full." },
        formatDate,
      ),
    ).toBe("The post on local 2026-12-11 can't be scheduled. Full.");
  });

  it("is null without a date and a reason, so the server's sentence is shown", () => {
    expect(repeatRefusalText({ error: "Nope." }, formatDate)).toBeNull();
    expect(repeatRefusalText({ date: "bad", reason: "Full." }, formatDate)).toBeNull();
    expect(repeatRefusalText(null, formatDate)).toBeNull();
  });
});
