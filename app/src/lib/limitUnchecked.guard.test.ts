import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

/**
 * R38 new-customer L1: a fail-closed limiter whose store can't answer comes
 * back `unavailable` (src/lib/rateLimit.ts). Every caller answers that with
 * "couldn't check" (limitUncheckedResponse), never with its "limit reached"
 * sentence. This reads the source, so a new fail-closed caller that forgets
 * fails here.
 */

const SRC = path.resolve(__dirname, "..");

/** Callers that answer no person directly, and why. Each is checked for its own rule. */
const EXCEPTIONS: Record<string, { why: string; mustContain: string[] }> = {
  // Log in throws its own code; next-auth carries it to the sign-in page.
  "lib/auth.ts": { why: "Log in's couldn't-check code", mustContain: [".unavailable", "SIGN_IN_UNCHECKED"] },
  // Passes the marked result on; its callers (below) answer it.
  "lib/aiGuards.ts": { why: "hands the mark to checkWorkspaceAiQuota's callers", mustContain: ["...result"] },
  // A store error leaves the day unclaimed, so no email goes; nobody is answered.
  "server/notifications/onceADay.ts": { why: "no email is sent without a claim", mustContain: [".allowed"] },
};

/** Functions that return a fail-closed result for their callers to answer. */
const PASS_THROUGH = ["checkWorkspaceAiQuota("];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

const files = sourceFiles(SRC).map((full) => ({
  rel: path.relative(SRC, full).split(path.sep).join("/"),
  text: readFileSync(full, "utf8"),
}));

const count = (text: string, needle: string) => text.split(needle).length - 1;
const answersUnchecked = (text: string) =>
  text.includes("limitUncheckedResponse(") || text.includes("LIMIT_UNCHECKED_MESSAGE");

describe("every fail-closed limiter caller answers a store it couldn't read as couldn't-check", () => {
  const callers = files.filter((file) => file.rel !== "lib/rateLimit.ts" && file.text.includes("failClosed: true"));

  it("finds the callers (the scan works)", () => {
    expect(callers.length).toBeGreaterThan(20);
    expect(callers.map((file) => file.rel)).toContain("app/api/auth/register/route.ts");
  });

  it("no TikTok route uses failClosed (that code is frozen; none is excepted)", () => {
    expect(callers.filter((file) => file.rel.startsWith("app/api/tiktok/"))).toEqual([]);
  });

  it.each(callers.map((file) => [file.rel, file.text] as const))("%s", (rel, text) => {
    const exception = EXCEPTIONS[rel];
    if (exception) {
      for (const needle of exception.mustContain) expect(text, exception.why).toContain(needle);
      return;
    }
    // One read of the mark per fail-closed limiter, and the shared answer.
    expect(count(text, ".unavailable"), "each failClosed result checks .unavailable").toBeGreaterThanOrEqual(
      count(text, "failClosed: true"),
    );
    expect(answersUnchecked(text), "answers through limitUncheckedResponse / LIMIT_UNCHECKED_MESSAGE").toBe(true);
  });

  const passThroughCallers = files.filter(
    (file) => !file.rel.startsWith("lib/aiGuards") && PASS_THROUGH.some((name) => file.text.includes(name)),
  );

  it("finds the AI-budget callers", () => {
    expect(passThroughCallers.length).toBeGreaterThanOrEqual(3);
  });

  it.each(passThroughCallers.map((file) => [file.rel, file.text] as const))("%s (AI budget)", (rel, text) => {
    expect(text, rel).toContain("quota.unavailable");
    expect(answersUnchecked(text), rel).toBe(true);
  });

  it("nothing still asks for the old opt-in", () => {
    expect(files.filter((file) => file.text.includes("markUnavailable")).map((file) => file.rel)).toEqual([]);
  });
});
