import { Platform } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  CAPTION_TOO_LONG_CODE,
  MAX_CAPTION_CHARS,
  captionCounter,
  captionTooLongMessage,
  findOverlongCaption,
  pickPlatformOverrides,
} from "./captionLimits";

describe("constants", () => {
  it("caps a caption at 10,000 characters under the CAPTION_TOO_LONG code", () => {
    expect(MAX_CAPTION_CHARS).toBe(10_000);
    expect(CAPTION_TOO_LONG_CODE).toBe("CAPTION_TOO_LONG");
  });
});

describe("captionTooLongMessage", () => {
  it("names the field and the cap", () => {
    expect(captionTooLongMessage("baseCaption")).toBe(
      "baseCaption is too long (max 10,000 characters).",
    );
    expect(captionTooLongMessage("perPlatformOverrides.x")).toBe(
      "perPlatformOverrides.x is too long (max 10,000 characters).",
    );
  });

  it("doubles as the composer's inline message", () => {
    expect(captionTooLongMessage("Caption")).toBe("Caption is too long (max 10,000 characters).");
  });
});

describe("captionCounter", () => {
  it("is not over at exactly 10,000 characters and over at 10,001", () => {
    expect(captionCounter("a".repeat(10_000))).toMatchObject({ length: 10_000, over: false });
    expect(captionCounter("a".repeat(10_001))).toMatchObject({ length: 10_001, over: true });
  });

  it("counts UTF-16 code units, so a surrogate pair counts 2 (the unit a textarea counts in)", () => {
    const counter = captionCounter("😀".repeat(5_000));
    expect(counter.length).toBe(10_000);
    expect(counter.over).toBe(false);
    expect(captionCounter("😀".repeat(5_001)).over).toBe(true);
  });

  it("formats the label as '1,234 / 10,000' with en-US grouping", () => {
    expect(captionCounter("a".repeat(1234)).label).toBe("1,234 / 10,000");
    expect(captionCounter("").label).toBe("0 / 10,000");
    expect(captionCounter("a".repeat(1234)).max).toBe(10_000);
  });
});

describe("pickPlatformOverrides", () => {
  it("keeps platform keys and drops everything else", () => {
    expect(pickPlatformOverrides({ x: "a", foo: "b", linkedin: "c" })).toEqual({
      x: "a",
      linkedin: "c",
    });
  });

  it("returns an empty object when no key is a platform", () => {
    expect(pickPlatformOverrides({ foo: "b" })).toEqual({});
    expect(pickPlatformOverrides({})).toEqual({});
  });

  it("keeps every value of the Prisma Platform enum", () => {
    const all = Object.fromEntries(Object.values(Platform).map((p) => [p, `text for ${p}`]));
    expect(pickPlatformOverrides(all)).toEqual(all);
  });

  it("does not let prototype-ish keys through", () => {
    const raw = JSON.parse('{"__proto__":"a","constructor":"b","toString":"c","x":"d"}');
    expect(pickPlatformOverrides(raw)).toEqual({ x: "d" });
  });
});

describe("findOverlongCaption", () => {
  it("returns null when nothing is over the cap", () => {
    expect(findOverlongCaption({})).toBeNull();
    expect(findOverlongCaption({ baseCaption: null, perPlatformOverrides: null })).toBeNull();
    expect(
      findOverlongCaption({
        baseCaption: "a".repeat(10_000),
        perPlatformOverrides: { x: "a".repeat(10_000) },
      }),
    ).toBeNull();
  });

  it("names baseCaption first when it is over", () => {
    expect(
      findOverlongCaption({
        baseCaption: "a".repeat(10_001),
        perPlatformOverrides: { x: "a".repeat(10_001) },
      }),
    ).toBe("baseCaption");
  });

  it("names the over-long override as perPlatformOverrides.<platform>", () => {
    expect(
      findOverlongCaption({
        baseCaption: "ok",
        perPlatformOverrides: { linkedin: "a".repeat(10_001) },
      }),
    ).toBe("perPlatformOverrides.linkedin");
  });

  it("returns the first over-long override in platform order", () => {
    expect(
      findOverlongCaption({
        perPlatformOverrides: { x: "a".repeat(10_001), tiktok: "a".repeat(10_001) },
      }),
    ).toBe("perPlatformOverrides.tiktok");
  });
});
