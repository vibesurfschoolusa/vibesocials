import { describe, expect, it } from "vitest";

import { truncateXWeighted, xWeightedLength } from "./xWeightedLength";

// Fix round 1 (M5): X counts a post by weight, not by characters.
describe("xWeightedLength", () => {
  it("counts plain Latin text one per character", () => {
    expect(xWeightedLength("")).toBe(0);
    expect(xWeightedLength("Surf lessons today!")).toBe(19);
  });

  it("counts the light ranges as 1 and everything else as 2", () => {
    expect(xWeightedLength("—")).toBe(1); // em dash, 8208-8223
    expect(xWeightedLength("′")).toBe(1); // prime, 8242-8247
    expect(xWeightedLength("…")).toBe(2); // ellipsis, 8230
    expect(xWeightedLength("日本")).toBe(4); // two CJK characters
    expect(xWeightedLength("é")).toBe(2); // e + combining accent, both light
  });

  it("counts every emoji as 2, sequences included", () => {
    expect(xWeightedLength("\u{1F30A}")).toBe(2);
    expect(xWeightedLength("\u{1F468}‍\u{1F469}‍\u{1F467}")).toBe(2);
    expect(xWeightedLength("\u{1F1FA}\u{1F1F8}")).toBe(2);
    expect(xWeightedLength("\u{1F44D}\u{1F3FD}")).toBe(2);
    expect(xWeightedLength("\u{1F3C4}‍♂️")).toBe(2);
  });

  // Review fix: a keycap has no Extended_Pictographic code point but is one emoji.
  it("counts a keycap sequence as one emoji (2)", () => {
    expect(xWeightedLength("1️⃣")).toBe(2);
    expect(xWeightedLength("#️⃣")).toBe(2);
    expect(xWeightedLength("*️⃣")).toBe(2);
    expect(xWeightedLength("1️⃣2️⃣3️⃣ ".repeat(40))).toBe(7 * 40);
  });

  it("cuts keycaps whole", () => {
    const cut = truncateXWeighted("1️⃣".repeat(150), 280, "...");
    expect(cut).toBe("1️⃣".repeat(138) + "...");
  });

  it("counts a link longer than 23 characters as 23", () => {
    const url = "https://vibesurfschool.com/lessons/fort-lauderdale?utm_source=x&utm_medium=social";
    expect(url.length).toBeGreaterThan(23);
    expect(xWeightedLength(url)).toBe(23);
    expect(xWeightedLength(`Book ${url} now`)).toBe(5 + 23 + 4);
  });

  it("counts a short link as 23 too, bare domains included", () => {
    expect(xWeightedLength("https://a.co")).toBe(23);
    expect(xWeightedLength("www.example.com")).toBe(23);
    expect(xWeightedLength("example.com/path")).toBe(23);
    expect(xWeightedLength("visit vibesurfschool.com")).toBe(6 + 23);
  });

  it("leaves punctuation after a link outside it", () => {
    expect(xWeightedLength("See https://example.com/a.")).toBe(4 + 23 + 1);
    expect(xWeightedLength("(example.com)")).toBe(1 + 23 + 1);
  });

  it("counts a bare domain as a link only with a listed ending or www.", () => {
    expect(xWeightedLength("vibesocials.wtf")).toBe(23);
    expect(xWeightedLength("surf.io/book")).toBe(23);
    expect(xWeightedLength("www.example.surf")).toBe(23);
    expect(xWeightedLength("Mr.Smith")).toBe(8);
    expect(xWeightedLength("notes.txt")).toBe(9);
    expect(xWeightedLength("https://example.surf")).toBe(23);
  });

  it("does not read an email address or an abbreviation as a link", () => {
    expect(xWeightedLength("info@example.com")).toBe(16);
    expect(xWeightedLength("e.g. 3.50")).toBe(9);
  });
});

describe("truncateXWeighted", () => {
  it("returns text within the limit unchanged", () => {
    expect(truncateXWeighted("a".repeat(280), 280, "...")).toBe("a".repeat(280));
  });

  it("cuts plain text to the limit with the ellipsis", () => {
    expect(truncateXWeighted("a".repeat(300), 280, "...")).toBe("a".repeat(277) + "...");
  });

  it("cuts an emoji caption that is under 280 characters but over 280 by weight", () => {
    const caption = "\u{1F30A}".repeat(200);
    expect([...caption].length).toBeLessThan(280);
    const cut = truncateXWeighted(caption, 280, "...");
    expect(cut).toBe("\u{1F30A}".repeat(138) + "...");
    expect(xWeightedLength(cut)).toBeLessThanOrEqual(280);
  });

  it("never splits an emoji sequence", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const cut = truncateXWeighted(family.repeat(150), 280, "...");
    expect(cut).toBe(family.repeat(138) + "...");
  });

  it("never cuts inside a link: a link that does not fit goes whole", () => {
    const caption = "a".repeat(260) + " https://vibesurfschool.com/lessons and more";
    expect(truncateXWeighted(caption, 280, "...")).toBe("a".repeat(260) + " ...");
  });

  it("keeps a long link that fits, counted as 23", () => {
    const url = "https://vibesurfschool.com/lessons/fort-lauderdale/private-surf-lessons";
    const caption = "a".repeat(250) + " " + url + " " + "b".repeat(20);
    const cut = truncateXWeighted(caption, 280, "...");
    expect(cut).toBe("a".repeat(250) + " " + url + " bb...");
    expect(xWeightedLength(cut)).toBe(280);
  });

  it("stays within the limit for mixed text", () => {
    const samples = [
      "Café 日本 \u{1F30A} https://example.com/x ".repeat(30),
      "\u{1F1FA}\u{1F1F8}a".repeat(120),
      "www.example.com ".repeat(40),
    ];
    for (const text of samples) {
      expect(xWeightedLength(truncateXWeighted(text, 280, "..."))).toBeLessThanOrEqual(280);
    }
  });
});
