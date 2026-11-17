import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * R36 platform-clients L1: a plain fetch has no limit, so a provider that
 * stalls holds the request until Vercel's timeout page. Server code calls
 * fetchWithTimeout or fetchWithinLimit (lib/fetchWithTimeout.ts); a file that
 * may not is named here with its reason.
 */
const ALLOWED: Record<string, string> = {
  "src/app/api/auth/tiktok/callback/route.ts": "TikTok's routes are frozen; its token exchange stays as it is.",
  "src/app/api/posts/auto-caption/route.ts": "AI provider call, bounded headers and body by its own AbortSignal.timeout(AI_PROVIDER_TIMEOUT_MS).",
  "src/app/api/posts/enhance-caption/route.ts": "AI provider call, bounded headers and body by its own AbortSignal.timeout(AI_PROVIDER_TIMEOUT_MS).",
  "src/app/api/reviews/draft-response/route.ts": "AI provider call, bounded headers and body by its own AbortSignal.timeout(AI_PROVIDER_TIMEOUT_MS).",
  "src/app/api/auth/x/start/route.ts": "X's request token at Connect: no limit yet; outside round 36's files (VV2 report).",
  "src/server/connectLink/authorize.ts": "X's request token for a connect link: no limit yet; outside round 36's files (VV2 report).",
  "src/server/jobs/socialMetricsSync.ts": "`fetch` there is a local parameter (one platform's fetcher), not the global.",
};

/** The lines of `source` that call the global fetch; comment lines don't count. */
function bareFetchLines(source: string): number[] {
  const lines: number[] = [];
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    if (/(?<![\w$.])fetch\s*\(/.test(line) || /\b(?:globalThis|window|self)\.fetch\s*\(/.test(line)) lines.push(index + 1);
  });
  return lines;
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

function filesWithBareFetch(): string[] {
  return [join(APP, "src", "server"), join(APP, "src", "app", "api")]
    .flatMap(sourceFiles)
    .filter((path) => bareFetchLines(readFileSync(path, "utf8")).length > 0)
    .map((path) => relative(APP, path).split(sep).join("/"))
    .sort();
}

describe("no bare fetch in server code", () => {
  it("finds a new bare fetch, and leaves the bounded ones and comments alone", () => {
    expect(bareFetchLines('const r = await fetch("https://example.test/token", { method: "POST" });')).toEqual([1]);
    expect(bareFetchLines("const r = await globalThis.fetch(url);")).toEqual([1]);
    expect(bareFetchLines("return fetch (url)")).toEqual([1]);
    expect(bareFetchLines("const r = await fetchWithTimeout(url, init, 15_000);")).toEqual([]);
    expect(bareFetchLines("const r = await fetchWithinLimit(url, init, 15_000);")).toEqual([]);
    expect(bareFetchLines("const r = await client.fetch(url);")).toEqual([]);
    expect(bareFetchLines("// migrating `fetch(url, init)` calls here")).toEqual([]);
    expect(bareFetchLines(" * a plain fetch(url) has no limit")).toEqual([]);
  });

  it("only the named files call it, each with a reason, and the list stays short", () => {
    expect(Object.keys(ALLOWED).length).toBeLessThanOrEqual(30);
    for (const reason of Object.values(ALLOWED)) expect(reason.trim().length).toBeGreaterThan(0);
    expect(filesWithBareFetch()).toEqual(Object.keys(ALLOWED).sort());
  });
});
