import { describe, expect, it } from "vitest";

import { cardName, labelName } from "./queueLabelName";

// R5-pages L12: a button's name carries the caption's start, not all of it.
describe("labelName, the caption in a Queue button's name", () => {
  it("keeps a short caption whole", () => {
    expect(labelName("Dawn patrol")).toBe("Dawn patrol");
  });

  it("cuts a long caption to about 40 characters with an ellipsis", () => {
    const caption = "Sunday session at the pier with the whole crew, bring your board and sunscreen";
    const name = labelName(caption);
    expect(name).toBe("Sunday session at the pier with the who…");
    expect(Array.from(name)).toHaveLength(40);
  });

  it("joins lines and spaces into one line, and never cuts an emoji", () => {
    expect(labelName("Waves\n\n  today")).toBe("Waves today");
    const name = labelName(`${"a".repeat(38)}🏄‍♀️ more words after`);
    expect(name).toBe(`${"a".repeat(38)}🏄‍♀️…`);
  });

  it("names a post without a caption", () => {
    expect(labelName(null)).toBe("Untitled post");
    expect(labelName("   ")).toBe("Untitled post");
  });
});

// R58 client-journey L1, pages-a L1: a Repeat series makes posts with one
// caption, so a card is named by its caption and its time together.
describe("cardName, a card's name in its buttons", () => {
  const at = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  it("joins the caption's start and the time, short", () => {
    expect(cardName("Saturday surf lesson", "2026-11-21T14:00:00.000Z")).toBe(`Saturday surf lesson, ${at("2026-11-21T14:00:00.000Z")}`);
    const long = cardName("Sunday session at the pier with the whole crew, bring your board", "2026-11-21T14:00:00.000Z");
    expect(long.startsWith("Sunday session at the pier with the who…, ")).toBe(true);
    expect(Array.from(long).length).toBeLessThanOrEqual(60);
  });

  it("two posts with the same caption at different times have different names", () => {
    expect(cardName("Saturday surf lesson", "2026-11-21T14:00:00.000Z")).not.toBe(
      cardName("Saturday surf lesson", "2026-11-28T14:00:00.000Z"),
    );
  });

  it("a post with no caption is Untitled post plus its time", () => {
    expect(cardName(null, "2026-11-21T14:00:00.000Z")).toBe(`Untitled post, ${at("2026-11-21T14:00:00.000Z")}`);
    expect(cardName("  ", "2026-11-21T14:00:00.000Z")).toBe(`Untitled post, ${at("2026-11-21T14:00:00.000Z")}`);
  });

  it("without a time, or with one that can't be read, it is the caption alone", () => {
    expect(cardName("Dawn patrol", null)).toBe("Dawn patrol");
    expect(cardName("Dawn patrol", "not a date")).toBe("Dawn patrol");
  });

  it("a Story-only card is Story plus its time", () => {
    expect(cardName("This goes out as a Story, with no caption.", "2026-11-21T14:00:00.000Z", { story: true })).toBe(
      `Story, ${at("2026-11-21T14:00:00.000Z")}`,
    );
  });

  it("a day-only name, in the zone given, as the report shows a post's day", () => {
    expect(cardName("Dawn patrol", "2026-11-21T23:30:00.000Z", { day: true, timeZone: "UTC" })).toBe(
      `Dawn patrol, ${new Date("2026-11-21T23:30:00.000Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}`,
    );
  });
});
