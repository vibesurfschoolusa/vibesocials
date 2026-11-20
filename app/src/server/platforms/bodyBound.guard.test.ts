import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * R48 platform latent pattern: fetchWithTimeout stops timing at the headers,
 * so a body (or a clone of it, as classifyRateLimit reads) that stalls holds
 * the publish step until the platform cap kills it, and the post is recorded
 * as unconfirmed though nothing was sent. In the platform clients every
 * request is fetchWithinLimit, whose limit covers the body and its clones.
 * fetchWithTimeout stays only for a whole-file transfer that passes its own
 * `signal: AbortSignal.timeout(...)`, which bounds the body the same way.
 *
 * Also caught (R48 review low 2): a bare `fetch(` call, which has no limit at
 * all, and fetchWithTimeout passed on as a value (`(fetchWithTimeout)`,
 * `fetchWithTimeout,`), whose calls this scan could not see.
 */
const DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * Deliberate exceptions, by path under server/platforms: how many findings the
 * file may have, and why. Keep it short; every entry must still match.
 */
const ALLOWED: Record<string, { count: number; reason: string }> = {};

/** The source without comments and import statements, line breaks kept. */
function codeOf(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^\s*import\s[\s\S]*?from\s*["'][^"']+["'];?/gm, blank)
    .split("\n")
    // A JSDoc-style line ("* ...") is a comment even outside a paired block.
    .map((line) => (/^\s*\*/.test(line) ? "" : line))
    .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

/** The text of the call whose `(` is at `open`, up to its matching `)`. */
function callText(code: string, start: number, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return code.slice(start, i + 1);
  }
  return code.slice(start);
}

/** Each request in `source` whose body is not bounded, as a short label. */
function unboundedRequests(source: string): string[] {
  const code = codeOf(source);
  const found: string[] = [];
  for (const match of code.matchAll(/(?<![\w$.])fetchWithTimeout\s*\(/g)) {
    const call = callText(code, match.index, match.index + match[0].length - 1);
    if (!/\bsignal:\s*AbortSignal\.timeout\(/.test(call)) found.push("fetchWithTimeout without a whole-transfer signal");
  }
  const bare = code.match(/(?<![\w$.])fetch\s*\(|\b(?:globalThis|window|self)\.fetch\s*\(/g) ?? [];
  found.push(...bare.map(() => "bare fetch"));
  const passed = code.match(/(?<![\w$.])fetchWithTimeout\b(?!\s*\()/g) ?? [];
  found.push(...passed.map(() => "fetchWithTimeout passed as a value"));
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|testkit)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function findings(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const path of sourceFiles(DIR)) {
    const count = unboundedRequests(readFileSync(path, "utf8")).length;
    if (count > 0) out[relative(DIR, path).split(sep).join("/")] = count;
  }
  return out;
}

describe("every platform request bounds its body", () => {
  it("flags planted header-only calls, bare fetches and passed references, and passes the bounded forms", () => {
    expect(unboundedRequests('const r = await fetchWithTimeout(url, { method: "POST" }, 30_000);')).toEqual([
      "fetchWithTimeout without a whole-transfer signal",
    ]);
    expect(unboundedRequests("const r = await fetch(url, init);")).toEqual(["bare fetch"]);
    expect(unboundedRequests("return globalThis.fetch(url);")).toEqual(["bare fetch"]);
    expect(unboundedRequests("const send = withRetry(fetchWithTimeout);")).toEqual(["fetchWithTimeout passed as a value"]);
    expect(unboundedRequests("run(fetchWithTimeout, url);")).toEqual(["fetchWithTimeout passed as a value"]);

    expect(unboundedRequests("fetchWithinLimit(url, init, 5_000)")).toEqual([]);
    expect(unboundedRequests("fetchWithTimeout(\n  url,\n  { signal: AbortSignal.timeout(ms) },\n  ms,\n)")).toEqual([]);
    expect(unboundedRequests("client.fetch(url)")).toEqual([]);
    expect(unboundedRequests("// fetchWithTimeout(url)\n * fetch(url)\n/* fetchWithTimeout, */")).toEqual([]);
    expect(unboundedRequests('import {\n  fetchWithinLimit,\n  fetchWithTimeout,\n} from "@/lib/fetchWithTimeout";')).toEqual([]);
  });

  it("finds files in subfolders too", () => {
    expect(sourceFiles(DIR).every((path) => path.startsWith(DIR))).toBe(true);
    expect(sourceFiles(join(DIR, "..")).some((path) => relative(DIR, path).startsWith(".."))).toBe(true);
  });

  it("no platform file has an unbounded request outside the allow-list", () => {
    const allowed = Object.fromEntries(Object.entries(ALLOWED).map(([path, entry]) => [path, entry.count]));
    expect(findings()).toEqual(allowed);
    for (const entry of Object.values(ALLOWED)) expect(entry.reason.trim()).not.toBe("");
  });
});
