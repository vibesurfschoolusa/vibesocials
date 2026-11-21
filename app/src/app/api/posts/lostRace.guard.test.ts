import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * R60 (publishing-flow L1, L2; pages-a L1): what a post action says when its
 * pinned write matched nothing is decided by lostRaceAnswer (lib/postMovedOn.ts)
 * alone. The wording was patched route by route three rounds running (#294
 * gave Cancel series and Edit the re-read, Publish now and Schedule still said
 * the post was gone), so this guard finds every handler under api/posts whose
 * write is pinned to a value it read, and fails when one answers its lost race
 * without the helper, or words one itself. A handler that keeps its own rule is
 * listed with why, so a new one is a decision, not an accident.
 */

const POSTS = __dirname;

/** A write pinned to the version read: updatedAt or an approval column taken from the row read. */
const PIN = /\b(updatedAt|submittedForApprovalAt|approvedAt): (?:row|post)\.\1\b|\bstatus: memberUnderApproval \? row\.status\b/;
const WRITES = /\.(?:updateMany|deleteMany)\(|\bfinishPostJob\(/;

/** The handlers whose lost race lostRaceAnswer words. */
const PINNED: Record<string, string> = {
  "[postJobId]/publish/route.ts#POST": "Publish now, Schedule and Submit for approval: each claim is pinned to updatedAt",
  "[postJobId]/cancel/route.ts#POST": "Cancel: pinned to the approval columns read",
  "[postJobId]/cancel-series/route.ts#POST": "Cancel series: each post pinned to the approval columns read",
  "[postJobId]/route.ts#PATCH": "Edit: a member under approval is pinned to the status the approval rule was decided on",
};

/** Handlers with a pinned write that keep their own lost-race rule, and why. */
const OWN_RULE: Record<string, string> = {
  "[postJobId]/approval/route.ts#POST":
    "Approve or Reject: a post still awaiting a decision was edited since the owner opened it, so the answer is CHANGED_SINCE_REVIEW (review the latest version); trying again would decide text the owner has not seen",
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

/** Each exported handler's source, keyed "dir/route.ts#NAME". */
function handlers(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of routeFiles(POSTS)) {
    const source = readFileSync(file, "utf8");
    const rel = path.relative(POSTS, file).split(path.sep).join("/");
    const parts = source.split(/^export async function (\w+)/m);
    for (let i = 1; i < parts.length; i += 2) found.set(`${rel}#${parts[i]}`, parts[i + 1]);
  }
  return found;
}

/** Every string and template text in a file; a template's expressions read as ${}. */
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

/** The text of each lost-race block: from its opening to the matching close. */
function lostBranches(source: string): string[] {
  const blocks: string[] = [];
  for (const match of source.matchAll(LOST_BRANCH)) {
    let depth = 0;
    const start = match.index! + match[0].length - 1;
    for (let at = start; at < source.length; at += 1) {
      if (source[at] === "{") depth += 1;
      else if (source[at] === "}" && --depth === 0) {
        blocks.push(source.slice(start, at + 1));
        break;
      }
    }
  }
  return blocks;
}

describe("a lost race is worded by lostRaceAnswer alone", () => {
  const all = handlers();

  it("every handler with a pinned write is listed", () => {
    const pinned = [...all].filter(([, source]) => PIN.test(source) && WRITES.test(source)).map(([key]) => key);
    expect(pinned.sort()).toEqual([...Object.keys(PINNED), ...Object.keys(OWN_RULE)].sort());
  });

  it.each(Object.keys(PINNED))("%s answers each lost race with lostRaceAnswer", (key) => {
    const source = all.get(key);
    expect(source, key).toBeDefined();
    const branches = lostBranches(source!);
    expect(branches.length, key).toBeGreaterThan(0);
    for (const branch of branches) expect(branch, key).toMatch(/\blostRaceAnswer\(/);
  });

  it.each(Object.keys(PINNED))("%s words no lost race itself", (key) => {
    expect(textsOf(all.get(key)!).filter((text) => LOST_TEXT.test(text) && !NOT_SHOWN.test(text))).toEqual([]);
  });
});
