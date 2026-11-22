import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * R66 publishing-flow-2 L1 (the cure): cutting user text by code point
 * (`Array.from(text).slice(...)`, `[...text].slice(...)`, or the first one,
 * `[0]`) leaves half a flag, a hand without its skin tone, or one person of a
 * family. The approval emails (R22), newReviewsEmail (R59) and postOutcomeEmail
 * (R66) each had this bug in turn. Every cut of user text goes through
 * lib/truncate.ts's grapheme functions instead. This reads the source, so a
 * new code-point cut fails here.
 *
 * R67 (the cure, platform-clients L1, publishing-flow L2, pages-a L3): the
 * class came back a fifth time in spellings the first guard did not know, a
 * for-of loop over a string (altText) and a UTF-16 `.slice(0, 300)`
 * (bulkExtras). The second part below asks the TypeScript checker for the
 * receiver's type, so every prefix cut of a STRING is found however it is
 * named, and each one is a lib/truncate.ts function or listed with its reason.
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

// R67: every prefix cut of a string, found by the receiver's type.

/** A string, or a value the checker cannot type (`any`), which may be one. */
function mayBeString(checker: ts.TypeChecker, node: ts.Node): boolean {
  const type = checker.getNonNullableType(checker.getTypeAtLocation(node));
  const parts = type.isUnion() ? type.types : [type];
  return parts.every((part) => (part.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any)) !== 0);
}

/** `x`, without the parentheses, `as` and `!` around it. */
function bare(node: ts.Expression): ts.Expression {
  let inner = node;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isNonNullExpression(inner)) {
    inner = inner.expression;
  }
  return inner;
}

/** ASCII by construction: an ISO date (`toISOString()`) or a hash (`digest("hex")`). */
function isAsciiByConstruction(node: ts.Expression): boolean {
  const inner = bare(node);
  return (
    ts.isCallExpression(inner) &&
    ts.isPropertyAccessExpression(inner.expression) &&
    (inner.expression.name.text === "toISOString" || inner.expression.name.text === "digest")
  );
}

/** `-SUFFIX.length`: the end drops a known suffix the code just matched; it does not count. */
function dropsKnownSuffix(node: ts.Expression): boolean {
  const inner = bare(node);
  if (!ts.isPrefixUnaryExpression(inner) || inner.operator !== ts.SyntaxKind.MinusToken) return false;
  const operand = bare(inner.operand);
  return ts.isPropertyAccessExpression(operand) && operand.name.text === "length";
}

/** A loop body that can stop early: a break or a return outside any function inside it. */
function canStop(body: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found || ts.isFunctionLike(node)) return;
    if (ts.isBreakStatement(node) || ts.isReturnStatement(node)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

const PREFIX_CUTS = new Set(["slice", "substring", "substr"]);

/**
 * The prefix cuts of a string in one file, as their source text:
 * `.slice(0, n)`, `.substring(0, n)` and `.substr(0, n)` on a string-typed
 * receiver, and a for-of loop over a string that can stop early (a code-point
 * cut). An ISO date, a hash and a known suffix are left alone (see above).
 */
function stringPrefixCuts(checker: ts.TypeChecker, file: ts.SourceFile): string[] {
  const cuts: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      PREFIX_CUTS.has(node.expression.name.text) &&
      node.arguments.length === 2 &&
      ts.isNumericLiteral(node.arguments[0]) &&
      node.arguments[0].text === "0" &&
      !dropsKnownSuffix(node.arguments[1]) &&
      !isAsciiByConstruction(node.expression.expression) &&
      mayBeString(checker, node.expression.expression)
    ) {
      cuts.push(node.getText(file).replace(/\s+/g, " "));
    }
    if (ts.isForOfStatement(node) && mayBeString(checker, node.expression) && canStop(node.statement)) {
      cuts.push(`for of ${node.expression.getText(file)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return cuts;
}

/**
 * Prefix cuts that keep their UTF-16 cut, each with why no grapheme can be
 * split: the value is ASCII, or the cut falls at a character the code found.
 * A new entry is a decision, not an accident.
 */
const LISTED: Record<string, string> = {
  "app/api/upload-link/[token]/media/route.ts: stored.contentType.slice(0, 100)":
    "an HTTP Content-Type value from the store: Latin-1 at most, so no surrogate pair",
  "components/google-post-settings.tsx: text.trim().slice(0, max)":
    "only measured for the alert line, never sent or shown (BC3 owns this file in R67)",
  "lib/bulkPosts.ts: toDateTimeLocalValue(tomorrow).slice(0, 10)": "a datetime-local value, ASCII digits",
  "lib/bulkPosts.ts: toDateTimeLocalValue(now).slice(0, 10)": "a datetime-local value, ASCII digits",
  "lib/listingMetrics.ts: day.slice(0, 10)": "an ISO date string from the database",
  "lib/monthlyReport.ts: row.day.slice(0, 10)": "an ISO date string from the database",
  "lib/postsDto.ts: decoded.slice(0, separatorIndex)": "a cursor cut at its own '|' separator",
  "lib/sentryRedaction.ts: target.slice(0, end)": "a URL path cut at its '?' or '#'",
  "lib/sentryRedaction.ts: text.slice(0, end)":
    "an error report's text, kept off half a surrogate pair just above, never shown to a person",
  "lib/trackingTags.ts: raw.slice(0, hashAt)": "a link cut at its '#'",
  "lib/uploadLink.ts: safe.slice(0, STORED_NAME_MAX - ext.length)": "a storage name already reduced to [A-Za-z0-9._-]",
  'lib/xMentions.ts: name.slice(0, name.indexOf("."))': "an X handle cut at its own '.'",
  "lib/xMentions.ts: line.slice(0, line.length - end.length)": "drops the line's own trailing carriage return",
  'server/billing/stripeApi.ts: `vs-${all.join("-")}`.slice(0, 255)': "an idempotency key built from our own ids",
  "server/billing/stripeSignature.ts: entry.slice(0, at)": "a Stripe-Signature entry cut at its '='",
  "server/connectLink/cookie.ts: part.slice(0, index)": "a cookie pair cut at its '='",
  "server/connections/gbpLocationTitle.ts: nonEmptyString(body?.title)?.slice(0, MAX_LOCATION_TITLE_LENGTH)":
    "BC3 owns this file in R67: the lead moves it to truncateGraphemesWithinCodePoints after the merge",
  "server/jobs/inngest-functions.ts: startedAt.slice(0, 10)": "an ISO date string (toISOString in the step above)",
  "server/platforms/instagramClient.ts: text.slice(0, start)": "removes a matched hashtag at the space before it",
};

/** A program of the planted sources, each its own file, with only the ES library. */
function plantedProgram(sources: string[]): { checker: ts.TypeChecker; files: ts.SourceFile[] } {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    strict: true,
    noEmit: true,
    types: [],
  };
  const names = sources.map((_, index) => `/__planted__/p${index}.ts`);
  const byName = new Map(names.map((name, index) => [name, sources[index]]));
  const planted = (fileName: string) => byName.get(fileName.replace(/\\/g, "/").replace(/^[A-Za-z]:/, ""));
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (fileName, version, ...rest) => {
    const text = planted(fileName);
    return text === undefined ? getSourceFile(fileName, version, ...rest) : ts.createSourceFile(fileName, text, version, true);
  };
  host.fileExists = (fileName) => planted(fileName) !== undefined || fileExists(fileName);
  host.readFile = (fileName) => planted(fileName) ?? readFile(fileName);
  const program = ts.createProgram(names, options, host);
  const files = names.map((name) => program.getSourceFile(name));
  if (files.some((file) => !file)) throw new Error("a planted source is not in the program");
  return { checker: program.getTypeChecker(), files: files as ts.SourceFile[] };
}

const CAUGHT: [string, string][] = [
  [
    "altText's for-of",
    `export function fitAltText(text: string, max: number): string {
  let cut = "";
  for (const codePoint of text) {
    if (cut.length + codePoint.length > max) break;
    cut += codePoint;
  }
  return cut;
}`,
  ],
  [
    "bulkExtras' .slice(0, 300)",
    `const AVOID_LENGTH = 300;
export const f = (rows: { caption: string }[]) =>
  rows.map((row) => row.caption.trim()).filter(Boolean).map((caption) => caption.slice(0, AVOID_LENGTH));`,
  ],
  [
    "auto-caption's .slice(0, maxLength) on an untyped answer",
    `declare const llmData: any;
declare const maxLength: number;
let caption = llmData.choices?.[0]?.message?.content?.trim() ?? "";
caption = caption.slice(0, maxLength).trim();
export { caption };`,
  ],
  ["a .substring(0, n)", "export const f = (title: string) => title.substring(0, 100);"],
  ["a .substr(0, n)", "export const f = (name: string) => name.substr(0, 3);"],
  ["an optional chain", "export const f = (title?: string) => title?.trim().slice(0, 200);"],
  ["a string under any name", "export const f = (q: string | null) => (q ?? '').slice(0, 24);"],
  [
    "a for-of that returns at a count",
    `export function f(text: string, max: number): string {
  let out = "";
  let n = 0;
  for (const ch of text) {
    if (n++ >= max) return out;
    out += ch;
  }
  return out;
}`,
  ],
];

const LEFT_ALONE: [string, string][] = [
  ["an ISO date", "export const day = new Date().toISOString().slice(0, 10);"],
  ["a hash", 'declare const hash: { digest(encoding: string): string };\nexport const id = hash.digest("hex").slice(0, 16);'],
  ["a known suffix dropped", 'const SUFFIX = "_failed";\nexport const f = (code: string) => code.slice(0, -SUFFIX.length);'],
  ["a list", "export const f = (ids: string[]) => ids.slice(0, 5);"],
  ["a cut that is not a prefix", "export const f = (text: string) => text.slice(1);"],
  [
    "a for-of over a string that never stops (a count)",
    "export function f(text: string): number {\n  let n = 0;\n  for (const ch of text) n += ch.length;\n  return n;\n}",
  ],
  [
    "a for-of over a list that stops",
    "export function f(ids: string[]): string {\n  for (const id of ids) {\n    if (id) return id;\n  }\n  return '';\n}",
  ],
];

describe("R67: no string is cut to a count by UTF-16 unit or code point (type-checked)", () => {
  let found: string[] = [];

  beforeAll(() => {
    const appRoot = path.resolve(SRC, "..");
    const config = ts.getParsedCommandLineOfConfigFile(
      path.join(appRoot, "tsconfig.json"),
      { incremental: false, noEmit: true, types: [] },
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
    );
    if (!config) throw new Error("tsconfig.json could not be read");
    const roots = sourceFiles(SRC, SRC).map((file) => path.join(SRC, file.rel));
    const program = ts.createProgram(roots, config.options);
    const checker = program.getTypeChecker();
    for (const root of roots) {
      const rel = path.relative(SRC, root).split(path.sep).join("/");
      // lib/truncate.ts is where the grapheme cuts are made.
      if (rel === "lib/truncate.ts") continue;
      const file = program.getSourceFile(root);
      if (!file) throw new Error(`${rel} is not in the program`);
      for (const cut of stringPrefixCuts(checker, file)) found.push(`${rel}: ${cut}`);
    }
    found = [...new Set(found)];
  }, 120_000);

  it("every prefix cut of a string in src is a lib/truncate.ts function or listed with its reason", () => {
    expect(found.filter((cut) => !(cut in LISTED))).toEqual([]);
  });

  it("lists no cut that is gone", () => {
    expect(Object.keys(LISTED).filter((cut) => !found.includes(cut))).toEqual([]);
  });
});

describe("R67: the type-checked guard on planted sources", () => {
  let caught: string[][] = [];
  let leftAlone: string[][] = [];

  beforeAll(() => {
    const { checker, files } = plantedProgram([...CAUGHT, ...LEFT_ALONE].map(([, source]) => source));
    const cuts = files.map((file) => stringPrefixCuts(checker, file));
    caught = cuts.slice(0, CAUGHT.length);
    leftAlone = cuts.slice(CAUGHT.length);
  }, 60_000);

  it.each(CAUGHT.map(([form], index) => [form, index] as const))("fails on %s", (_form, index) => {
    expect(caught[index]).toHaveLength(1);
  });

  it.each(LEFT_ALONE.map(([form], index) => [form, index] as const))("leaves alone %s", (_form, index) => {
    expect(leftAlone[index]).toEqual([]);
  });
});
