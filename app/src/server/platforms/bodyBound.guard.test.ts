import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
 */
const DIR = fileURLToPath(new URL(".", import.meta.url));

/** Each `fetchWithTimeout(...)` call in `source` (comments skipped), as its full text. */
function fetchWithTimeoutCalls(source: string): string[] {
  const code = source
    .split("\n")
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line))
    .join("\n");
  const calls: string[] = [];
  const pattern = /(?<![\w$.])fetchWithTimeout\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code))) {
    let depth = 0;
    let end = match.index;
    for (let i = match.index + match[0].length - 1; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    calls.push(code.slice(match.index, end));
  }
  return calls;
}

function clientFiles(): string[] {
  return readdirSync(DIR).filter((name) => /\.ts$/.test(name) && !/\.test\.ts$/.test(name));
}

describe("every platform request bounds its body", () => {
  it("finds a header-only call and passes a whole-transfer one", () => {
    expect(fetchWithTimeoutCalls("const r = await fetchWithTimeout(url, { method: \"POST\" }, 30_000);")).toHaveLength(1);
    expect(fetchWithTimeoutCalls("// fetchWithTimeout(url)\n * fetchWithTimeout(url)")).toEqual([]);
    expect(fetchWithTimeoutCalls("fetchWithinLimit(url, init, 5_000)")).toEqual([]);
    expect(
      fetchWithTimeoutCalls("fetchWithTimeout(\n  url,\n  { signal: AbortSignal.timeout(ms) },\n  ms,\n)")[0],
    ).toContain("signal: AbortSignal.timeout(");
  });

  it("no client calls fetchWithTimeout without a whole-transfer signal", () => {
    const headerOnly: Record<string, number> = {};
    for (const name of clientFiles()) {
      const count = fetchWithTimeoutCalls(readFileSync(join(DIR, name), "utf8")).filter(
        (call) => !/\bsignal:\s*AbortSignal\.timeout\(/.test(call),
      ).length;
      if (count > 0) headerOnly[name] = count;
    }
    expect(headerOnly).toEqual({});
  });
});
