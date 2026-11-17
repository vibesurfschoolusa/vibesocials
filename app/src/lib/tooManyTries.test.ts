import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

import { LIMIT_UNCHECKED_MESSAGE } from "./limitUncheckedMessage";
import { tooManyTriesResponse, tooManyTriesSentence } from "./tooManyTries";

describe("tooManyTriesSentence (R42 pages-a L3)", () => {
  it.each([
    [30, "Too many tries. Wait a minute, then try again."],
    [60, "Too many tries. Wait a minute, then try again."],
    [61, "Too many tries. Wait 2 minutes, then try again."],
    [59 * 60, "Too many tries. Wait 59 minutes, then try again."],
    // R45 second review: an hour reads "1 hour", as dailyLimitSentence and the AI line say it (waitText).
    [60 * 60, "Too many tries. Wait 1 hour, then try again."],
  ])("at %i s says %s", (seconds, sentence) => {
    expect(tooManyTriesSentence(seconds)).toBe(sentence);
  });

  it("an unknown wait never names a number", () => {
    expect(tooManyTriesSentence(undefined)).toBe("Too many tries. Wait a few minutes, then try again.");
  });
});

describe("tooManyTriesResponse", () => {
  it("answers 429 with the wait sentence, the seconds and a Retry-After header", async () => {
    const response = tooManyTriesResponse({ retryAfterSeconds: 1500 });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1500");
    await expect(response.json()).resolves.toEqual({
      error: "Too many tries. Wait 25 minutes, then try again.",
      retryAfterSeconds: 1500,
    });
  });

  it("a store that couldn't be read keeps its own couldn't-check answer, never the wait", async () => {
    const response = tooManyTriesResponse({ retryAfterSeconds: 60, unavailable: true });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: LIMIT_UNCHECKED_MESSAGE });
  });

  it("R43 new-customer L2: a reason goes before the wait sentence", async () => {
    const response = tooManyTriesResponse({ retryAfterSeconds: 1500 }, "This network used its tries.");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1500");
    await expect(response.json()).resolves.toEqual({
      error: "This network used its tries. Too many tries. Wait 25 minutes, then try again.",
      retryAfterSeconds: 1500,
    });
  });

  it("with a reason, a store that couldn't be read still answers the couldn't-check 503", async () => {
    const response = tooManyTriesResponse({ retryAfterSeconds: 60, unavailable: true }, "This network used its tries.");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: LIMIT_UNCHECKED_MESSAGE });
  });
});

/** Every non-test source file under src. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("guard: no route answers a 429 with no wait", () => {
  it('no non-test file under src says "slow down"', () => {
    const src = path.resolve(__dirname, "..");
    const offenders = sourceFiles(src).filter((file) => /slow down\./i.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => path.relative(src, file).split(path.sep).join("/"))).toEqual([]);
  });
});
