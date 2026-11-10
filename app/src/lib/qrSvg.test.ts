import { describe, expect, it } from "vitest";

import { QR_QUIET_ZONE, qrSvg } from "./qrSvg";

const LINK = "https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4";

/** The viewBox size and every dark cell's position, read back from the SVG. */
function parse(svg: string) {
  const size = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)?.[1]);
  const cells = [...svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((m) => [Number(m[1]), Number(m[2])]);
  return { size, cells };
}

describe("qrSvg", () => {
  it("gives the same SVG for the same link", () => {
    expect(qrSvg(LINK)).toBe(qrSvg(LINK));
    expect(qrSvg(LINK)).not.toBe(qrSvg(`${LINK}x`));
  });

  it("is an SVG drawing with a white background and dark cells", () => {
    const svg = qrSvg(LINK);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('fill="#ffffff"');
    expect(parse(svg).cells.length).toBeGreaterThan(100);
  });

  it(`keeps a quiet zone of ${QR_QUIET_ZONE} empty cells on every side`, () => {
    expect(QR_QUIET_ZONE).toBe(4);
    const { size, cells } = parse(qrSvg(LINK));
    const xs = cells.map(([x]) => x);
    const ys = cells.map(([, y]) => y);
    expect(Math.min(...xs)).toBe(QR_QUIET_ZONE);
    expect(Math.min(...ys)).toBe(QR_QUIET_ZONE);
    expect(Math.max(...xs)).toBe(size - QR_QUIET_ZONE - 1);
    expect(Math.max(...ys)).toBe(size - QR_QUIET_ZONE - 1);
  });

  it("still encodes a long link, in a larger code", () => {
    const long = `${LINK}&${"a".repeat(600)}`;
    expect(parse(qrSvg(long)).size).toBeGreaterThan(parse(qrSvg(LINK)).size);
  });

  it("draws the finder pattern in the top-left corner", () => {
    const { cells } = parse(qrSvg(LINK));
    const dark = new Set(cells.map(([x, y]) => `${x},${y}`));
    const q = QR_QUIET_ZONE;
    // The 7x7 finder's outer ring and centre are dark; the ring inside it is light.
    expect(dark.has(`${q},${q}`)).toBe(true);
    expect(dark.has(`${q + 6},${q + 6}`)).toBe(true);
    expect(dark.has(`${q + 1},${q + 1}`)).toBe(false);
    expect(dark.has(`${q + 3},${q + 3}`)).toBe(true);
  });
});
