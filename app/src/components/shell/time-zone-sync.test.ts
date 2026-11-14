import { describe, expect, it } from "vitest";

import { browserTimeZone, readSentTimeZone, sentTimeZoneKey, timeZoneToSend, writeSentTimeZone } from "./time-zone-sync";

/** A Storage stand-in; `broken` throws like a blocked or private-window storage. */
function storage(broken = false) {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      if (broken) throw new Error("blocked");
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (broken) throw new Error("blocked");
      values.set(key, value);
    },
  };
}

describe("timeZoneToSend", () => {
  it("sends the browser's zone when this browser has not sent it for this person", () => {
    expect(timeZoneToSend("America/New_York", null)).toBe("America/New_York");
  });

  it("sends again when the zone changed (travel, a new computer setting)", () => {
    expect(timeZoneToSend("Europe/Berlin", "America/New_York")).toBe("Europe/Berlin");
  });

  it("sends nothing when the same zone was already sent", () => {
    expect(timeZoneToSend("Europe/Berlin", "Europe/Berlin")).toBeNull();
  });

  it("sends nothing when the browser gives no zone", () => {
    expect(timeZoneToSend(null, null)).toBeNull();
    expect(timeZoneToSend("", null)).toBeNull();
  });
});

describe("the last zone sent, per person", () => {
  it("is kept per person, so two people on one browser each send theirs", () => {
    const store = storage();
    writeSentTimeZone(store, "user-1", "Europe/Berlin");
    expect(readSentTimeZone(store, "user-1")).toBe("Europe/Berlin");
    expect(readSentTimeZone(store, "user-2")).toBeNull();
    expect(sentTimeZoneKey("user-1")).toBe("vs_time_zone_sent:user-1");
  });

  it("reads as never sent, and writes nothing, when storage is blocked", () => {
    const store = storage(true);
    expect(readSentTimeZone(store, "user-1")).toBeNull();
    expect(() => writeSentTimeZone(store, "user-1", "Europe/Berlin")).not.toThrow();
  });
});

describe("browserTimeZone", () => {
  it("is the zone Intl resolves", () => {
    expect(browserTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
