import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

/**
 * R66 publishing-flow-2 L1 (the cure): cutting user text by code point
 * (`Array.from(text).slice(...)`, `[...text].slice(...)`, or the first one,
 * `[0]`) leaves half a flag, a hand without its skin tone, or one person of a
 * family. The approval emails (R22), newReviewsEmail (R59) and postOutcomeEmail
 * (R66) each had this bug in turn. Every cut of user text goes through
 * lib/truncate.ts's grapheme functions instead. This reads the source, so a
 * new code-point cut fails here.
 */

/** The text from the opening character at `open` to its matching close. */
function balancedAt(text: string, open: number, opener: string, closer: string): string {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === opener) depth++;
    else if (text[index] === closer && --depth === 0) return text.slice(open, index + 1);
  }
  return text.slice(open);
}

/**
 * A spread or Array.from of a list, not of a string: a Set, a Map's keys, DOM
 * children or files, an array literal, or a string already split into
 * graphemes (Intl.Segmenter's segment()).
 */
const LIST_SOURCE =
  /^\s*(?:new\s+(?:Set|Map)\b|\(|\[)|\.(?:keys|values|entries)\(\)|\.segment\(|\bchildren\b|\bfiles\b|querySelectorAll|\?\?\s*\[\]/;

/** A cut: a slice, a splice, a substring or the first element. */
const CUT_AFTER = /^\s*(?:\.(?:slice|splice|substring)\(|\[\s*0\s*\])/;

/** Each `Array.from(x)` or `[...x]` in `text`: where it ends and what it spreads. */
function spreads(text: string): { start: number; end: number; source: string }[] {
  const found: { start: number; end: number; source: string }[] = [];
  for (const match of text.matchAll(/Array\.from\(|\[\.\.\./g)) {
    const start = match.index;
    const isFrom = match[0].startsWith("Array");
    const open = isFrom ? start + match[0].length - 1 : start;
    const whole = isFrom ? balancedAt(text, open, "(", ")") : balancedAt(text, open, "[", "]");
    const inner = isFrom ? whole.slice(1, -1) : whole.slice(4, -1);
    found.push({ start, end: open + whole.length, source: inner });
  }
  return found;
}

/** The code-point cuts in one file's source, as the text that makes each. */
function codePointCuts(text: string): string[] {
  const cuts: string[] = [];
  for (const { start, end, source } of spreads(text)) {
    if (LIST_SOURCE.test(source)) continue;
    const after = text.slice(end, end + 40);
    // Cut on the spot: Array.from(name).slice(0, 24), [...word][0].
    if (CUT_AFTER.test(after)) {
      cuts.push(text.slice(start, end) + (CUT_AFTER.exec(after)?.[0] ?? ""));
      continue;
    }
    // Kept, then cut: const chars = Array.from(text); ... chars.slice(0, max).
    if (/^\s*\.sort\(/.test(after)) continue;
    const named = /(?:const|let)\s+(\w+)\s*=\s*$/.exec(text.slice(Math.max(0, start - 60), start));
    if (named && new RegExp(String.raw`\b${named[1]}\s*(?:\.(?:slice|splice)\(|\[\s*0\s*\])`).test(text.slice(end))) {
      cuts.push(`${named[1]} = ${text.slice(start, end)}`);
    }
  }
  return cuts;
}

function sourceFiles(dir: string, root: string, out: { rel: string; text: string }[] = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, root, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.testkit\./.test(name)) {
      out.push({ rel: path.relative(root, full).split(path.sep).join("/"), text: readFileSync(full, "utf8") });
    }
  }
  return out;
}

const SRC = path.resolve(__dirname, "..");

describe("no user text is cut by code point", () => {
  // R66 (lead): no exceptions. Input that needs a size bound uses
  // truncateGraphemesWithinCodePoints, which keeps whole graphemes within it.
  it("every non-test file under src cuts by grapheme, with no exceptions", () => {
    const found = sourceFiles(SRC, SRC)
      .filter((file) => codePointCuts(file.text).length > 0)
      .map((file) => `${file.rel}: ${codePointCuts(file.text).join(", ")}`);
    expect(found).toEqual([]);
  });

  it("fails on a planted code-point cut", () => {
    expect(codePointCuts("export const f = (name: string) => Array.from(name).slice(0, 24).join('');")).toHaveLength(1);
    expect(codePointCuts("const chars = [...caption];\nreturn chars.slice(0, 80).join('');")).toHaveLength(1);
    expect(codePointCuts("const chars = Array.from(caption.trim().replace(/\\s+/g, ' '));\nreturn chars.slice(0, 80).join('');")).toHaveLength(1);
    expect(codePointCuts("return words.map((word) => Array.from(word)[0]).join('');")).toHaveLength(1);
    expect(codePointCuts("return [...word][0];")).toHaveLength(1);
  });

  it("leaves lists, grapheme arrays and counts alone", () => {
    for (const text of [
      "return Array.from(new Set(ids)).slice(0, 5);",
      "return [...new Set(ids)].slice(0, 5);",
      "const g = Array.from(segmenter.segment(text), (s) => s.segment);\nreturn g.slice(0, 2).join('');",
      "const n = Array.from(text).length;",
      "const keys = [...map.keys()].sort();\nreturn keys[0];",
      "const ranked = [...rows].sort((a, b) => a - b);\nreturn ranked[0];",
      "const files = Array.from(event.target.files ?? []);\nfiles.slice(1);",
    ]) {
      expect(codePointCuts(text), text).toEqual([]);
    }
  });
});
