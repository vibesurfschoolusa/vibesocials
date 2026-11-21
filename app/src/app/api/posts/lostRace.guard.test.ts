import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * R60 (publishing-flow L1, L2; pages-a L1): what a post action says when its
 * pinned write matched nothing is decided by lostRaceAnswer (lib/postMovedOn.ts)
 * alone. The wording was patched route by route three rounds running (#294
 * gave Cancel series and Edit the re-read, Publish now and Schedule still said
 * the post was gone), so this guard finds every handler under api/posts and
 * the client review link whose write is pinned to a value it read, and fails
 * when one answers its lost race without the helper, or words one itself. A
 * handler that keeps its own rule is listed with why, so a new one is a
 * decision, not an accident.
 */

const API = path.join(__dirname, "..");
const SCANNED = ["posts", "review-link"];

/** A write pinned to the version read: updatedAt or an approval column taken from the row read. */
const PIN = /\b(updatedAt|submittedForApprovalAt|approvedAt): (?:row|post)\.\1\b|\bstatus: memberUnderApproval \? row\.status\b/;
const WRITES = /\.(?:updateMany|deleteMany)\(|\bfinishPostJob\(/;

/** The handlers whose lost race lostRaceAnswer words. */
const PINNED: Record<string, string> = {
  "posts/[postJobId]/publish/route.ts#POST": "Publish now, Schedule and Submit for approval: each claim is pinned to updatedAt",
  "posts/[postJobId]/cancel/route.ts#POST": "Cancel: pinned to the approval columns read",
  "posts/[postJobId]/cancel-series/route.ts#POST": "Cancel series: each post pinned to the approval columns read",
  "posts/[postJobId]/route.ts#PATCH": "Edit: a member under approval is pinned to the status the approval rule was decided on",
};

/** Handlers with a pinned write that keep their own lost-race rule, and why. */
const OWN_RULE: Record<string, string> = {
  "posts/[postJobId]/approval/route.ts#POST":
    "Approve or Reject: a post still awaiting a decision was edited since the owner opened it, so the answer is CHANGED_SINCE_REVIEW (review the latest version); trying again would decide text the owner has not seen",
  "review-link/[token]/posts/[postJobId]/route.ts#POST":
    "the client's Approve on /v is pinned to the version the page showed: the client must see the latest text, so a changed post answers REVIEW_POST_CHANGED_MESSAGE",
};

/** The opening of each block a lost race is answered in. */
const LOST_BRANCH = /if \(!result\.ok\) \{|if \(cancelled === 0\) \{/g;

/** A sentence that words a lost race (a moved-on sentence comes from postMovedOnText). */
const LOST_TEXT = /changed in the meantime|no longer available to|\btry again\b/i;
/** Never read by a person: a log line's "[tag] ...". */
const NOT_SHOWN = /^\[/;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [full] : [];
  });
}

/** Each exported handler's source, keyed "NAME". */
function handlersOf(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const parts = source.split(/^export async function (\w+)/m);
  for (let i = 1; i < parts.length; i += 2) found.set(parts[i], parts[i + 1]);
  return found;
}

/** Every scanned file's source, keyed "dir/route.ts". */
function files(): Map<string, string> {
  const found = new Map<string, string>();
  for (const dir of SCANNED) {
    for (const file of routeFiles(path.join(API, dir))) {
      found.set(path.relative(API, file).split(path.sep).join("/"), readFileSync(file, "utf8"));
    }
  }
  return found;
}

/** Does this handler hold a write pinned to a value it read? */
function hasPinnedWrite(handler: string): boolean {
  return PIN.test(handler) && WRITES.test(handler);
}

/** Every string and template text in a source; a template's expressions read as ${}. */
function textsOf(source: string): string[] {
  const file = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const texts: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) texts.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      texts.push(node.head.text + node.templateSpans.map((span) => `\${}${span.literal.text}`).join(""));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return texts;
}

/** The texts in a file that word a lost race. */
function lostTexts(file: string): string[] {
  const handlers = [...handlersOf(file).values()].join("\n");
  return textsOf(handlers).filter((text) => LOST_TEXT.test(text) && !NOT_SHOWN.test(text));
}

/** The lost-race answers in a handler not given by lostRaceAnswer. */
function handWrittenLostRaces(handler: string): string[] {
  const blocks: string[] = [];
  for (const match of handler.matchAll(LOST_BRANCH)) {
    let depth = 0;
    const start = match.index! + match[0].length - 1;
    for (let at = start; at < handler.length; at += 1) {
      if (handler[at] === "{") depth += 1;
      else if (handler[at] === "}" && --depth === 0) {
        blocks.push(handler.slice(start, at + 1));
        break;
      }
    }
  }
  return blocks.filter((block) => !/\blostRaceAnswer\(/.test(block));
}

describe("a lost race is worded by lostRaceAnswer alone", () => {
  const all = files();
  const handlers = new Map(
    [...all].flatMap(([file, source]) => [...handlersOf(source)].map(([name, body]) => [`${file}#${name}`, body] as const)),
  );

  it("every handler with a pinned write is listed", () => {
    const pinned = [...handlers].filter(([, source]) => hasPinnedWrite(source)).map(([key]) => key);
    expect(pinned.sort()).toEqual([...Object.keys(PINNED), ...Object.keys(OWN_RULE)].sort());
  });

  it.each(Object.keys(PINNED))("%s answers each lost race with lostRaceAnswer", (key) => {
    const source = handlers.get(key);
    expect(source, key).toBeDefined();
    expect(source, key).toMatch(/\blostRaceAnswer\(/);
    expect(handWrittenLostRaces(source!), key).toEqual([]);
  });

  it.each(Object.keys(PINNED))("%s's file words no lost race itself", (key) => {
    expect(lostTexts(all.get(key.split("#")[0])!)).toEqual([]);
  });
});

// The fix review of R60: the guard caught only today's exact forms. Each of
// these must fail it.
describe("the guard catches", () => {
  it("a pin on any name read (existing.updatedAt)", () => {
    const handler = `{
      const existing = await prisma.postJob.findFirst({ where: { id } });
      const { count } = await prisma.postJob.updateMany({ where: { id, updatedAt: existing.updatedAt }, data: { baseCaption } });
    }`;
    expect(hasPinnedWrite(handler)).toBe(true);
  });

  it("a hand-written 409 in a count === 0 branch after a pinned write", () => {
    const handler = `{
      const { count } = await prisma.postJob.updateMany({ where: { id, updatedAt: row.updatedAt }, data: {} });
      if (count === 0) {
        return NextResponse.json({ error: "Someone else got there first.", code: "NOT_EDITABLE" }, { status: 409 });
      }
      return NextResponse.json({ ok: true });
    }`;
    expect(handWrittenLostRaces(handler)).not.toEqual([]);
  });

  it("a lost-race sentence kept as a module constant", () => {
    const file = `const DRAFT_GONE = "This draft can no longer be scheduled.";
export async function POST() {
  return NextResponse.json({ error: DRAFT_GONE }, { status: 409 });
}`;
    expect(lostTexts(file)).not.toEqual([]);
  });
});
