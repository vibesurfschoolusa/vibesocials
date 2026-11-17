import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

/**
 * R38 new-customer L1: a fail-closed limiter whose store can't answer comes
 * back `unavailable` (src/lib/rateLimit.ts). Every caller answers that with
 * "couldn't check" (limitUncheckedResponse / LIMIT_UNCHECKED_MESSAGE), never
 * with its "limit reached" sentence. This reads the source, so a new
 * fail-closed caller that forgets fails here.
 *
 * R38 lead review: a function that hands a fail-closed result on (it is
 * declared to return one) is a wrapper; every file that calls it is held to
 * the same rule, so a wrapper can't hide its callers.
 */

type SourceFile = { rel: string; text: string };

/** Callers that answer no person through the shared sentence, and why. Each is checked for its own rule. */
const EXCEPTIONS: Record<string, { why: string; mustContain: string[] }> = {
  // Log in throws its own code; next-auth carries it to the sign-in page.
  "lib/auth.ts": { why: "Log in's couldn't-check code", mustContain: [".unavailable", "SIGN_IN_UNCHECKED"] },
  // Passes the marked result on; its callers (found as a wrapper's) answer it.
  "lib/aiGuards.ts": { why: "hands the mark to checkWorkspaceAiQuota's callers", mustContain: ["...result"] },
  // A store error leaves the day unclaimed, so no email goes; nobody is answered.
  "server/notifications/onceADay.ts": { why: "no email is sent without a claim", mustContain: [".allowed"] },
};

/** The result types a fail-closed limiter (or a wrapper of one) returns. */
const LIMIT_RESULT_TYPE = /Promise<\s*(RateLimitResult|AiQuotaResult)\b/;

const count = (text: string, needle: string) => text.split(needle).length - 1;
const answersUnchecked = (text: string) =>
  text.includes("limitUncheckedResponse(") || text.includes("LIMIT_UNCHECKED_MESSAGE");

/** Exported functions of a fail-closed file declared to return a limit result. */
function wrappersIn(text: string): string[] {
  const names: string[] = [];
  const declaration = /export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]|\n)*?\)\s*:\s*([^{]+)\{/g;
  for (const match of text.matchAll(declaration)) {
    if (LIMIT_RESULT_TYPE.test(match[3])) names.push(match[1]);
  }
  return names;
}

/** Every rule break in `files`, as "<file>: <why>". Empty when all callers answer the mark. */
function guardFailures(files: SourceFile[]): string[] {
  const failures: string[] = [];
  const failClosed = files.filter((file) => file.rel !== "lib/rateLimit.ts" && file.text.includes("failClosed: true"));

  const wrappers = new Map<string, string>();
  for (const file of failClosed) for (const name of wrappersIn(file.text)) wrappers.set(name, file.rel);

  for (const file of failClosed) {
    const exception = EXCEPTIONS[file.rel];
    if (exception) {
      for (const needle of exception.mustContain) {
        if (!file.text.includes(needle)) failures.push(`${file.rel}: ${exception.why} (missing ${needle})`);
      }
      continue;
    }
    if (count(file.text, ".unavailable") < count(file.text, "failClosed: true")) {
      failures.push(`${file.rel}: a failClosed result without its .unavailable check`);
    }
    if (!answersUnchecked(file.text)) failures.push(`${file.rel}: doesn't answer through the shared sentence`);
  }

  for (const file of files) {
    for (const [name, home] of wrappers) {
      if (file.rel === home) continue;
      const calls = count(file.text, `${name}(`);
      if (calls === 0) continue;
      if (count(file.text, ".unavailable") < calls) failures.push(`${file.rel}: calls ${name} without its .unavailable check`);
      if (!answersUnchecked(file.text)) failures.push(`${file.rel}: calls ${name} without the shared sentence`);
    }
  }
  return failures;
}

const SRC = path.resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

const files: SourceFile[] = sourceFiles(SRC).map((full) => ({
  rel: path.relative(SRC, full).split(path.sep).join("/"),
  text: readFileSync(full, "utf8"),
}));

describe("every fail-closed limiter caller answers a store it couldn't read as couldn't-check", () => {
  it("finds the callers and the wrappers (the scan works)", () => {
    const callers = files.filter((file) => file.text.includes("failClosed: true")).map((file) => file.rel);
    expect(callers.length).toBeGreaterThan(20);
    expect(callers).toContain("app/api/auth/register/route.ts");
    const wrappers = files.flatMap((file) => (file.text.includes("failClosed: true") ? wrappersIn(file.text) : []));
    expect(wrappers).toEqual(expect.arrayContaining(["checkAdminRateLimit", "checkWorkspaceAiQuota"]));
  });

  it("no TikTok route uses failClosed (that code is frozen; none is excepted)", () => {
    expect(files.filter((file) => file.rel.startsWith("app/api/tiktok/") && file.text.includes("failClosed"))).toEqual([]);
  });

  it("every caller, and every caller of a wrapper, checks the mark and answers the shared sentence", () => {
    expect(guardFailures(files)).toEqual([]);
  });

  it("nothing still asks for the old opt-in", () => {
    expect(files.filter((file) => file.text.includes("markUnavailable")).map((file) => file.rel)).toEqual([]);
  });

  describe("the guard itself", () => {
    const wrapper: SourceFile = {
      rel: "lib/someWrapper.ts",
      text: [
        'import { checkRateLimit, type RateLimitResult } from "./rateLimit";',
        "export async function checkSomething(id: string): Promise<RateLimitResult> {",
        '  return checkRateLimit({ userId: id, route: "x", limit: 1, windowMs: 1, failClosed: true });',
        "}",
        "// limitUncheckedResponse( is not this file's job; its callers answer.",
        "// .unavailable",
      ].join("\n"),
    };

    it("a wrapper's caller without the unavailable check fails", () => {
      const caller: SourceFile = {
        rel: "app/some/page.tsx",
        text: 'const limit = await checkSomething("u");\nif (!limit.allowed) return "Too many";',
      };
      expect(guardFailures([wrapper, caller])).toEqual([
        "app/some/page.tsx: calls checkSomething without its .unavailable check",
        "app/some/page.tsx: calls checkSomething without the shared sentence",
      ]);
    });

    it("a wrapper's caller that checks the mark and answers the sentence passes", () => {
      const caller: SourceFile = {
        rel: "app/some/page.tsx",
        text: 'const limit = await checkSomething("u");\nif (limit.unavailable) return LIMIT_UNCHECKED_MESSAGE;',
      };
      expect(guardFailures([wrapper, caller])).toEqual([]);
    });

    it("a direct caller that answers its limit sentence for a store error fails", () => {
      const caller: SourceFile = {
        rel: "app/api/x/route.ts",
        text: 'const r = await checkRateLimit({ failClosed: true });\nif (!r.allowed) return tooMany();',
      };
      expect(guardFailures([caller])).toEqual([
        "app/api/x/route.ts: a failClosed result without its .unavailable check",
        "app/api/x/route.ts: doesn't answer through the shared sentence",
      ]);
    });
  });
});
