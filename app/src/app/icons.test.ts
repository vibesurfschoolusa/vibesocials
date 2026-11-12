import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dir = __dirname;

describe("site icon files", () => {
  it("icon.svg is an SVG with a square viewBox", () => {
    const svg = readFileSync(path.join(dir, "icon.svg"), "utf8");
    expect(svg).toMatch(/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(m![2]);
  });

  it("favicon.ico is an ICO that holds 16, 32 and 48 pixel images", () => {
    const ico = readFileSync(path.join(dir, "favicon.ico"));
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // type: icon
    const count = ico.readUInt16LE(4);
    expect(count).toBe(3);
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      sizes.push(ico[entry] || 256);
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      expect(offset + length).toBeLessThanOrEqual(ico.length);
      // PNG entries start with the PNG signature.
      expect(ico.subarray(offset, offset + 4).toString("hex")).toBe("89504e47");
    }
    expect(sizes).toEqual([16, 32, 48]);
  });
});
