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

/** The limiters themselves; a call to one counts only with `failClosed: true`. */
const LIMITERS = ["checkRateLimit", "consumeFixedWindow"];

/** The call's argument text, from its "(" at `open` to the matching ")". */
function argumentsAt(text: string, open: number): string {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")" && --depth === 0) return text.slice(open, index + 1);
  }
  return text.slice(open);
}

type LimitCall = { callee: string; at: number; end: number; variable: string | null; returned: boolean };

/** Each fail-closed limiter call and each wrapper call in `text`, in order, with the variable it is kept in. */
function limitCalls(text: string, wrapperNames: string[]): LimitCall[] {
  const pattern = new RegExp(`\\b(${[...LIMITERS, ...wrapperNames].join("|")})\\(`, "g");
  const calls: LimitCall[] = [];
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    const before = text.slice(Math.max(0, at - 200), at);
    if (/function\s+$/.test(before)) continue;
    const open = at + match[1].length;
    const args = argumentsAt(text, open);
    if (LIMITERS.includes(match[1]) && !args.includes("failClosed: true")) continue;
    const kept = /(?:const|let)\s+(\w+)\s*=\s*await\s+$/.exec(before);
    calls.push({
      callee: match[1],
      at,
      end: open + args.length,
      variable: kept ? kept[1] : null,
      returned: /return\s+(?:await\s+)?$/.test(before),
    });
  }
  return calls;
}

/**
 * Every rule break in `files`, as "<file>: <why>". Empty when all callers
 * answer the mark. R38 second look: each limit call is tied to its own
 * result: the variable it is kept in must be read as `<variable>.unavailable`
 * after the call and before the next limit call, so another limit's check
 * never stands in for it. A wrapper may hand its limiter's result straight on
 * (`return checkRateLimit(...)`); its callers are held to the rule instead.
 */
function guardFailures(files: SourceFile[]): string[] {
  const failures: string[] = [];
  const scanned = files.filter((file) => file.rel !== "lib/rateLimit.ts");

  const wrappers: string[] = [];
  for (const file of scanned) if (file.text.includes("failClosed: true")) wrappers.push(...wrappersIn(file.text));

  for (const file of scanned) {
    const exception = EXCEPTIONS[file.rel];
    if (exception) {
      for (const needle of exception.mustContain) {
        if (!file.text.includes(needle)) failures.push(`${file.rel}: ${exception.why} (missing ${needle})`);
      }
      continue;
    }
    const definesWrapper = wrappersIn(file.text).length > 0;
    const calls = limitCalls(file.text, wrappers).filter((call) => !(call.returned && definesWrapper));
    calls.forEach((call, index) => {
      if (!call.variable) {
        failures.push(`${file.rel}: a ${call.callee} call whose result isn't kept in a variable`);
        return;
      }
      const after = file.text.slice(call.end, calls[index + 1]?.at ?? file.text.length);
      if (!after.includes(`${call.variable}.unavailable`)) {
        failures.push(`${file.rel}: ${call.callee} result "${call.variable}" is not checked for .unavailable`);
      }
    });
    if (calls.length > 0 && !answersUnchecked(file.text)) {
      failures.push(`${file.rel}: doesn't answer through the shared sentence`);
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
      ].join("\n"),
    };

    it("a wrapper's caller without the unavailable check fails", () => {
      const caller: SourceFile = {
        rel: "app/some/page.tsx",
        text: 'const limit = await checkSomething("u");\nif (!limit.allowed) return "Too many";',
      };
      expect(guardFailures([wrapper, caller])).toEqual([
        'app/some/page.tsx: checkSomething result "limit" is not checked for .unavailable',
        "app/some/page.tsx: doesn't answer through the shared sentence",
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
        'app/api/x/route.ts: checkRateLimit result "r" is not checked for .unavailable',
        "app/api/x/route.ts: doesn't answer through the shared sentence",
      ]);
    });

    // R38 second look: two limits in one route are each tied to their own result.
    const aiGuards: SourceFile = {
      rel: "lib/aiGuards.ts",
      text: [
        "export async function checkWorkspaceAiQuota(workspaceId: string): Promise<AiQuotaResult> {",
        '  const result = await checkRateLimit({ userId: workspaceId, route: "ai", limit: 1, windowMs: 1, failClosed: true });',
        "  return { ...result };",
        "}",
      ].join("\n"),
    };
    const twoLimitRoute = (handleQuota: boolean): SourceFile => ({
      rel: "app/api/ai/route.ts",
      text: [
        "const rateLimit = await checkRateLimit({ userId, route: \"r\", limit: 2, windowMs: 1, failClosed: true });",
        "if (rateLimit.unavailable) return limitUncheckedResponse();",
        "if (!rateLimit.allowed) return tooMany();",
        "// a second read of the same result, as a route may have",
        "if (rateLimit.unavailable) log();",
        "const quota = await checkWorkspaceAiQuota(context.workspace.id);",
        ...(handleQuota ? ["if (quota.unavailable) return limitUncheckedResponse();"] : []),
        "if (!quota.allowed) return aiWorkspaceLimitResponse();",
      ].join("\n"),
    });

    it("a two-limit route that handles both passes", () => {
      expect(guardFailures([aiGuards, twoLimitRoute(true)])).toEqual([]);
    });

    it("removing the AI-budget handling fails, whatever else reads .unavailable", () => {
      expect(guardFailures([aiGuards, twoLimitRoute(false)])).toEqual([
        'app/api/ai/route.ts: checkWorkspaceAiQuota result "quota" is not checked for .unavailable',
      ]);
    });

    it("a check that comes before its call, or only after the next limit, doesn't count", () => {
      const route: SourceFile = {
        rel: "app/api/two/route.ts",
        text: [
          "if (b.unavailable) return limitUncheckedResponse();",
          "const a = await checkRateLimit({ failClosed: true });",
          "const b = await checkRateLimit({ failClosed: true });",
          "if (a.unavailable) return limitUncheckedResponse();",
        ].join("\n"),
      };
      expect(guardFailures([route])).toEqual([
        'app/api/two/route.ts: checkRateLimit result "a" is not checked for .unavailable',
        'app/api/two/route.ts: checkRateLimit result "b" is not checked for .unavailable',
      ]);
    });

    it("a fail-closed call whose result isn't kept in a variable fails", () => {
      const route: SourceFile = {
        rel: "app/api/inline/route.ts",
        text: "if (!(await checkRateLimit({ failClosed: true })).allowed) return limitUncheckedResponse();",
      };
      expect(guardFailures([route])).toEqual([
        "app/api/inline/route.ts: a checkRateLimit call whose result isn't kept in a variable",
      ]);
    });
  });
});
