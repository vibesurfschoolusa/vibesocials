import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * R42 pages-a L7: muted text is small (the 11 px "Text" tile on Activity and
 * Queue, the 10 px "File removed" tile in the report), so it needs WCAG AA's
 * 4.5:1 on every surface it sits on: --muted, --background and --card, in
 * each theme block of globals.css.
 */

const css = readFileSync(fileURLToPath(new URL("./globals.css", import.meta.url)), "utf8");

/** The custom properties declared in the block that opens with `selector {`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  const body = css.slice(start, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[match[1]] = match[2];
  return out;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe("the contrast check itself", () => {
  it("matches known pairs", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    // The finding's numbers: the old light pair.
    expect(contrast("#64748b", "#f1f5f9")).toBeCloseTo(4.34, 2);
  });
});

describe.each([
  ["light", ":root"],
  ["dark (system)", ":root:not(.light)"],
  ["dark (chosen)", ":root.dark"],
])("muted text in the %s theme", (_name, selector) => {
  const theme = tokens(selector);

  it.each(["--muted", "--background", "--card"])("is at least 4.5:1 on %s", (surface) => {
    expect(theme["--muted-foreground"]).toBeDefined();
    expect(theme[surface]).toBeDefined();
    expect(contrast(theme["--muted-foreground"], theme[surface])).toBeGreaterThanOrEqual(4.5);
  });
});
