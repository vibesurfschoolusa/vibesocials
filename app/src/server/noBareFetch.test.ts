import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * R36 platform-clients L1: a plain fetch has no limit, so a provider that
 * stalls holds the request until Vercel's timeout page. Server code calls
 * fetchWithTimeout or fetchWithinLimit (lib/fetchWithTimeout.ts).
 *
 * R36 review low 4: an exception is one line, not a whole file. The call
 * carries `// bare-fetch-ok: <reason>` on its own line or the line above, so
 * a second bare fetch in the same file still fails.
 */
const MARKER = /\/\/\s*bare-fetch-ok:\s*(\S.*)$/;

/**
 * Frozen files can't take a marker (TikTok's routes may change only their
 * error-code redirect), so each is named with its exact count of bare calls.
 */
const FROZEN: Record<string, { calls: number; reason: string }> = {
  "src/app/api/auth/tiktok/callback/route.ts": {
    calls: 1,
    reason: "TikTok's routes are frozen; its token exchange stays as it is.",
  },
};

/** The lines of `source` that call the global fetch with no marker; comment lines don't count. */
function unmarkedBareFetchLines(source: string): number[] {
  const lines = source.split("\n");
  const found: number[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    if (!/(?<![\w$.])fetch\s*\(/.test(line) && !/\b(?:globalThis|window|self)\.fetch\s*\(/.test(line)) return;
    const above = index > 0 ? lines[index - 1].trim() : "";
    const marked = MARKER.test(line) || (above.startsWith("//") && MARKER.test(above));
    if (!marked) found.push(index + 1);
  });
  return found;
}

const APP = fileURLToPath(new URL("../..", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !/\.testkit\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Each server file with an unmarked bare fetch, and how many it has. */
function unmarkedBareFetches(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const path of [join(APP, "src", "server"), join(APP, "src", "app", "api")].flatMap(sourceFiles)) {
    const count = unmarkedBareFetchLines(readFileSync(path, "utf8")).length;
    if (count > 0) out[relative(APP, path).split(sep).join("/")] = count;
  }
  return out;
}

function markedLines(): number {
  return [join(APP, "src", "server"), join(APP, "src", "app", "api")]
    .flatMap(sourceFiles)
    .reduce((sum, path) => sum + readFileSync(path, "utf8").split("\n").filter((line) => MARKER.test(line)).length, 0);
}

describe("no bare fetch in server code", () => {
  it("finds a new bare fetch, and leaves the bounded ones and comments alone", () => {
    expect(unmarkedBareFetchLines('const r = await fetch("https://example.test/token", { method: "POST" });')).toEqual([1]);
    expect(unmarkedBareFetchLines("const r = await globalThis.fetch(url);")).toEqual([1]);
    expect(unmarkedBareFetchLines("return fetch (url)")).toEqual([1]);
    expect(unmarkedBareFetchLines("const r = await fetchWithTimeout(url, init, 15_000);")).toEqual([]);
    expect(unmarkedBareFetchLines("const r = await fetchWithinLimit(url, init, 15_000);")).toEqual([]);
    expect(unmarkedBareFetchLines("const r = await client.fetch(url);")).toEqual([]);
    expect(unmarkedBareFetchLines("// migrating `fetch(url, init)` calls here")).toEqual([]);
    expect(unmarkedBareFetchLines(" * a plain fetch(url) has no limit")).toEqual([]);
  });

  it("a marker with a reason allows that one call, on its line or the line above", () => {
    expect(unmarkedBareFetchLines("const r = await fetch(url); // bare-fetch-ok: its own signal bounds it")).toEqual([]);
    expect(unmarkedBareFetchLines("// bare-fetch-ok: its own signal bounds it\nconst r = await fetch(url);")).toEqual([]);
    expect(unmarkedBareFetchLines("// bare-fetch-ok:\nconst r = await fetch(url);")).toEqual([2]);
  });

  it("a second, unmarked bare fetch in a file that has a marked one fails", () => {
    const source = [
      "// bare-fetch-ok: its own signal bounds it",
      "const first = await fetch(url, { signal });",
      "const second = await fetch(other);",
    ].join("\n");
    expect(unmarkedBareFetchLines(source)).toEqual([3]);
  });

  it("server code has no unmarked bare fetch, except the frozen files' exact counts", () => {
    for (const { reason } of Object.values(FROZEN)) expect(reason.trim().length).toBeGreaterThan(0);
    const expected = Object.fromEntries(Object.entries(FROZEN).map(([path, { calls }]) => [path, calls]));
    expect(unmarkedBareFetches()).toEqual(expected);
    // The exceptions stay few: the frozen calls and the marked lines together.
    expect(Object.values(FROZEN).reduce((sum, f) => sum + f.calls, 0) + markedLines()).toBeLessThanOrEqual(30);
  });
});
