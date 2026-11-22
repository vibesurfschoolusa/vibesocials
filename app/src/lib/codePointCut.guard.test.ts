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
 * children or files, an array literal, a list or nothing (`list ?? []`,
 * `x ? [a] : []`), or a string already split into graphemes
 * (Intl.Segmenter's segment()). R66 fix review L1: a parenthesised source is a
 * list only in those forms; `(name ?? "")` is a string.
 */
const LIST_SOURCE =
  /^\s*(?:new\s+(?:Set|Map)\b|\[)|\.(?:keys|values|entries)\(\)|\.segment\(|\bchildren\b|\bfiles\b|querySelectorAll|\?\?\s*\[\]|\?\s*\[[^\]]*\]\s*:\s*\[\]/;

/** A cut: a slice, a splice, a substring, the first element or at(). */
const CUT_AFTER = /^\s*(?:\.(?:slice|splice|substring|at)\(|\[\s*0\s*\])/;

/** A variable the spread is kept in, with or without a type: `const chars: string[] =`. */
const KEPT_IN = /(?:const|let)\s+(\w+)\s*(?::[^=;]+)?=\s*$/;

/** Destructured on the spot, which takes its first code points: `const [first] =`. */
const DESTRUCTURED = /(?:const|let)\s*\[[^\]]*\]\s*(?::[^=;]+)?=\s*$/;

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
    const before = text.slice(Math.max(0, start - 120), start);
    if (DESTRUCTURED.test(before)) {
      cuts.push(`${DESTRUCTURED.exec(before)?.[0] ?? ""}${text.slice(start, end)}`);
      continue;
    }
    // Kept, then cut: const chars = Array.from(text); ... chars.slice(0, max).
    if (/^\s*\.sort\(/.test(after)) continue;
    const named = KEPT_IN.exec(before);
    if (named && new RegExp(String.raw`\b${named[1]}\s*(?:\.(?:slice|splice|at)\(|\[\s*0\s*\])`).test(text.slice(end))) {
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

  // R66 fix review L1: forms the first guard let through.
  it.each([
    ["a spread of a parenthesised string", 'return [...(name ?? "")].slice(0, 24).join("");'],
    ["Array.from of a parenthesised string", 'return Array.from((caption ?? "").trim()).slice(0, 80).join("");'],
    ["a typed variable", 'const chars: string[] = Array.from(text);\nreturn chars.slice(0, 80).join("");'],
    ["a typed let", "let chars: Array<string> = [...text];\nchars = chars.slice(0, 3);"],
    ["destructuring a spread", "const [first] = [...word];"],
    ["destructuring Array.from", "const [a, b] = Array.from(name);"],
    ["at(0) on the spot", "return Array.from(text).at(0);"],
    ["at() on a kept variable", "const chars = [...text];\nreturn chars.at(-1);"],
  ])("fails on %s", (_form, text) => {
    expect(codePointCuts(text)).toHaveLength(1);
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
