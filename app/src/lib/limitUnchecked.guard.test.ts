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
  // R46 pages-a L1: a plain form post, so it goes back to /c with its own code; the page
  // says the couldn't-check reason (clientLinkLimit LIMIT_UNCHECKED_REASON, tested against the sentence).
  "app/api/connect-link/[token]/start/route.ts": {
    why: "back to /c, which says couldn't check",
    mustContain: [".unavailable", "CONNECT_LIMIT_CODES.unchecked"],
  },
  // R61 security-billing-2 L1: a browser redirect, so it goes back to Settings with its
  // own code; Settings words x_limit_unchecked as couldn't check (lib/oauthResult.ts, tested).
  "app/api/auth/x/start/route.ts": {
    why: "back to Settings, which says couldn't check",
    mustContain: [".unavailable", '"limit_unchecked"'],
  },
};

/** The result types a fail-closed limiter (or a wrapper of one) returns. */
const LIMIT_RESULT_TYPE = /Promise<\s*(RateLimitResult|AiQuotaResult)\b/;

const answersUnchecked = (text: string) =>
  text.includes("limitUncheckedResponse(") || text.includes("LIMIT_UNCHECKED_MESSAGE");

/** The text from the opening character at `open` to its matching close. */
function balancedAt(text: string, open: number, opener: string, closer: string): string {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === opener) depth++;
    else if (text[index] === closer && --depth === 0) return text.slice(open, index + 1);
  }
  return text.slice(open);
}

/** The call's argument text, from its "(" at `open` to the matching ")". */
const argumentsAt = (text: string, open: number) => balancedAt(text, open, "(", ")");

type LimitFunction = { name: string; exported: boolean; body: string };

/** Where a function's body starts after its return type at `from`: the first "{" outside `<...>` (-1 if none). */
function bodyStart(text: string, from: number): number {
  let angles = 0;
  for (let index = from; index < text.length; index++) {
    const char = text[index];
    if (char === "<") angles++;
    else if (char === ">" && text[index - 1] !== "=") angles--;
    else if (char === "{" && angles === 0) return index;
    else if (char === ";" && angles === 0) return -1;
  }
  return -1;
}

/** Every function declared to return a limit result, with its body. */
function limitFunctions(text: string): LimitFunction[] {
  const found: LimitFunction[] = [];
  for (const match of text.matchAll(/(export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const afterParams = open + argumentsAt(text, open).length;
    const typed = /^\s*:\s*/.exec(text.slice(afterParams));
    if (!typed) continue;
    const start = bodyStart(text, afterParams + typed[0].length);
    if (start < 0 || !LIMIT_RESULT_TYPE.test(text.slice(afterParams, start))) continue;
    found.push({ name: match[2], exported: Boolean(match[1]), body: balancedAt(text, start, "{", "}") });
  }
  return found;
}

/** Exported functions of a fail-closed file declared to return a limit result. */
function wrappersIn(text: string): string[] {
  return limitFunctions(text)
    .filter((fn) => fn.exported)
    .map((fn) => fn.name);
}

/** The catch blocks of `body`: `catch (e) { ... }` and `.catch(...)`. */
function catchBlocks(body: string): string[] {
  const blocks: string[] = [];
  for (const match of body.matchAll(/(?<!\.)\bcatch\b\s*(?:\([^)]*\))?\s*\{/g)) {
    blocks.push(balancedAt(body, (match.index ?? 0) + match[0].length - 1, "{", "}"));
  }
  for (const match of body.matchAll(/\.catch\(/g)) {
    blocks.push(argumentsAt(body, (match.index ?? 0) + match[0].length - 1));
  }
  return blocks;
}

/** Each object literal in `block` that answers `allowed: false`. */
function refusalsIn(block: string): string[] {
  const refusals: string[] = [];
  for (const match of block.matchAll(/allowed:\s*false/g)) {
    let depth = 0;
    for (let index = match.index ?? 0; index >= 0; index--) {
      if (block[index] === "}") depth++;
      else if (block[index] === "{" && depth-- === 0) {
        refusals.push(balancedAt(block, index, "{", "}"));
        break;
      }
    }
  }
  return refusals;
}

/**
 * R39 client-journey L1: a hand-written limiter (its own counter, so neither
 * checkRateLimit nor `failClosed: true` appears): a function declared to
 * return a limit result that refuses from a catch, i.e. fails closed on a
 * store error. It is held to rateLimit.ts's rule (the refusal carries
 * `unavailable: true`), and its callers to the callers' rule.
 */
function handWrittenLimitersIn(text: string): Array<LimitFunction & { unmarked: boolean }> {
  return limitFunctions(text).flatMap((fn) => {
    const refusals = catchBlocks(fn.body).flatMap(refusalsIn);
    if (refusals.length === 0) return [];
    return [{ ...fn, unmarked: refusals.some((refusal) => !/unavailable:\s*true/.test(refusal)) }];
  });
}

/** The limiters themselves; a call to one counts only with `failClosed: true`. */
const LIMITERS = ["checkRateLimit", "consumeFixedWindow"];

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
    for (const limiter of handWrittenLimitersIn(file.text)) {
      if (limiter.unmarked) {
        failures.push(`${file.rel}: ${limiter.name} answers allowed: false from a catch without unavailable: true`);
      }
      if (!wrappers.includes(limiter.name)) wrappers.push(limiter.name);
    }
  }

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

  // R39 client-journey L1: a hand-written counter (no checkRateLimit, no failClosed) is a limiter too.
  it("finds the hand-written limiters, and holds their callers to the rule", () => {
    const limiters = files.flatMap((file) => handWrittenLimitersIn(file.text).map((fn) => fn.name));
    expect(limiters).toEqual(expect.arrayContaining(["consumeUploadLinkDayBytes", "consumeUploadDayBytes"]));
  });

  describe("the guard itself", () => {
    // R39 client-journey L1: the upload link's byte counter answered a store error as "20 GB used".
    const counter = (catchAnswer: string): SourceFile => ({
      rel: "lib/someCounter.ts",
      text: [
        'import type { RateLimitResult } from "./rateLimit";',
        "export async function consumeSomething(id: string, now: number = Date.now()): Promise<RateLimitResult & { unavailable?: true }> {",
        "  try {",
        "    const entry = await prisma.rateLimitEntry.upsert({ where: { key: id } });",
        "    if (entry.count <= 5) return { allowed: true };",
        "    return { allowed: false, retryAfterSeconds: 10 };",
        "  } catch (error) {",
        `    ${catchAnswer}`,
        "  }",
        "}",
      ].join("\n"),
    });
    const counterCaller = (checked: boolean): SourceFile => ({
      rel: "app/api/counted/route.ts",
      text: [
        'const counted = await consumeSomething("u");',
        ...(checked ? ["if (counted.unavailable) return limitUncheckedResponse();"] : []),
        "if (!counted.allowed) return tooMany();",
      ].join("\n"),
    });

    it("a hand-written limiter that answers a store error as a refusal without the mark fails", () => {
      expect(guardFailures([counter("return { allowed: false, retryAfterSeconds: 60 };"), counterCaller(true)])).toEqual([
        "lib/someCounter.ts: consumeSomething answers allowed: false from a catch without unavailable: true",
      ]);
    });

    it("so does one that refuses in a .catch()", () => {
      const text = [
        "export function countIt(id: string): Promise<RateLimitResult> {",
        "  return prisma.rateLimitEntry.upsert({ where: { key: id } }).then(() => ({ allowed: true })).catch(() => ({ allowed: false }));",
        "}",
      ].join("\n");
      expect(guardFailures([{ rel: "lib/other.ts", text }])).toEqual([
        "lib/other.ts: countIt answers allowed: false from a catch without unavailable: true",
      ]);
    });

    it("a hand-written limiter that marks the store error passes, and its caller must check the mark", () => {
      const marked = counter("return { allowed: false, retryAfterSeconds: 60, unavailable: true };");
      expect(guardFailures([marked, counterCaller(true)])).toEqual([]);
      expect(guardFailures([marked, counterCaller(false)])).toEqual([
        'app/api/counted/route.ts: consumeSomething result "counted" is not checked for .unavailable',
        "app/api/counted/route.ts: doesn't answer through the shared sentence",
      ]);
    });

    it("a limit-typed function whose catch hands on no refusal is no limiter", () => {
      const text = [
        "async function firstSpent(ids: string[]): Promise<AiQuotaResult | null> {",
        "  try {",
        "    return { allowed: false, retryAfterSeconds: 5 };",
        "  } catch (error) {",
        "    return null;",
        "  }",
        "}",
      ].join("\n");
      expect(handWrittenLimitersIn(text)).toEqual([]);
      expect(guardFailures([{ rel: "lib/reads.ts", text }])).toEqual([]);
    });

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
