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

/** Columns a write is pinned to when taken from a value read (any name: row., existing., decision.version). */
const PINNED_COLUMNS = new Set(["updatedAt", "submittedForApprovalAt", "approvedAt"]);
/** The calls that write. */
const WRITE_CALL = /\.(?:updateMany|deleteMany|update|delete)$|^finishPostJob$/;
/** Where a property is a condition; a nearer data/select/... makes it a value written or read. */
const NOT_A_CONDITION = new Set(["data", "select", "include", "orderBy", "_count"]);

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

/**
 * 409s a listed handler sends after its pinned write that are not a lost race,
 * by a piece of their text, and why. An entry no longer found fails too.
 */
const LATER_409: Record<string, Record<string, string>> = {
  "posts/[postJobId]/publish/route.ts#POST": {
    "nothingSentMessage(": "the claim won and nothing could be sent (no connected platform): not a lost race",
  },
};

/** A sentence that words a lost race (a moved-on sentence comes from postMovedOnText). */
const LOST_TEXT = /changed in the meantime|no longer available to|can no longer be|\btry again\b/i;

/** Texts a listed file keeps that LOST_TEXT matches, and why. An entry no longer in its file fails too. */
const KEPT_TEXTS: Record<string, Record<string, string>> = {
  "posts/[postJobId]/cancel-series/route.ts": {
    "This post can no longer be cancelled.":
      "the fallback of the check before any write, for a status that is not a draft or scheduled (postMovedOnText words every such status)",
  },
};
/** Never read by a person: a log line's "[tag] ...". */
const NOT_SHOWN = /^\[/;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [full] : [];
  });
}

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Each exported handler's source, keyed "NAME". */
function handlersOf(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const statement of parse(source).statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      found.set(statement.name.text, statement.getText());
    }
  }
  return found;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

const propertyName = (node: ts.PropertyAssignment) => (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : "");

/** Is this property a condition of a query or write: under `where`, in a `...Where` value, or an argument of a write? */
function inCondition(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isPropertyAssignment(at)) {
      const name = propertyName(at);
      if (name === "where") return true;
      if (NOT_A_CONDITION.has(name)) return false;
    }
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name) && /where/i.test(at.name.text)) return true;
    if (ts.isCallExpression(at) && WRITE_CALL.test(at.expression.getText())) return true;
  }
  return false;
}

/**
 * The pins in a source: a pinned column (or the status) whose condition is a
 * value read (a name or a property, any name: row.updatedAt, existing.updatedAt,
 * decision.version; a status taken from row.status).
 */
function pinsOf(file: ts.SourceFile): ts.PropertyAssignment[] {
  const pins: ts.PropertyAssignment[] = [];
  walk(file, (node) => {
    if (!ts.isPropertyAssignment(node) || !inCondition(node)) return;
    const name = propertyName(node);
    const value = node.initializer.getText();
    if (PINNED_COLUMNS.has(name) && /^[\w.]+$/.test(value) && !/^(?:null|undefined|true|false)$/.test(value)) pins.push(node);
    else if (name === "status" && /\b\w+\.status\b/.test(value)) pins.push(node);
  });
  return pins;
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
  const file = parse(handler);
  let writes = false;
  walk(file, (node) => {
    if (ts.isCallExpression(node) && WRITE_CALL.test(node.expression.getText())) writes = true;
  });
  return writes && pinsOf(file).length > 0;
}

/** Every string and template text in a source; a template's expressions read as ${}. */
function textsOf(source: string): string[] {
  const file = parse(source);
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

/** The texts in a whole file (its module constants too) that word a lost race. */
function lostTexts(file: string): string[] {
  return textsOf(file).filter((text) => LOST_TEXT.test(text) && !NOT_SHOWN.test(text));
}

/** `NextResponse.json(body, { status: 409 })`. */
function is409(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || node.expression.getText() !== "NextResponse.json") return false;
  const init = node.arguments[1];
  return (
    !!init &&
    ts.isObjectLiteralExpression(init) &&
    init.properties.some((p) => ts.isPropertyAssignment(p) && propertyName(p) === "status" && p.initializer.getText() === "409")
  );
}

/** The local helpers that send a 409 (e.g. `const notCancelable = (status) => NextResponse.json(..., { status: 409 })`). */
function helpers409(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  walk(file, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
    if (!ts.isArrowFunction(node.initializer) && !ts.isFunctionExpression(node.initializer)) return;
    let sends = false;
    walk(node.initializer, (inner) => {
      if (is409(inner)) sends = true;
    });
    if (sends) names.add(node.name.text);
  });
  return names;
}

/**
 * The statements that can run after a pinned write: the ones after it in each
 * enclosing block, up to the handler, stopping at a branch that ends in a
 * return (its path ends there). A callback's body (a transaction) does not stop it.
 */
function statementsAfter(pin: ts.Node): ts.Statement[] {
  const after: ts.Statement[] = [];
  for (let node: ts.Node = pin; node.parent; node = node.parent) {
    const parent = node.parent;
    if (!ts.isBlock(parent) && !ts.isSourceFile(parent)) continue;
    const statements = [...parent.statements];
    after.push(...statements.slice(statements.indexOf(node as ts.Statement) + 1));
    if (ts.isSourceFile(parent) || ts.isFunctionDeclaration(parent.parent)) break;
    const callback = ts.isArrowFunction(parent.parent) || ts.isFunctionExpression(parent.parent);
    if (!callback && statements.length > 0 && ts.isReturnStatement(statements[statements.length - 1])) break;
  }
  return after;
}

/**
 * The 409s a handler sends after a pinned write that lostRaceAnswer did not
 * word, leaving out those `allowed` names by a piece of their text.
 */
function handWrittenLostRaces(handler: string, allowed: readonly string[] = []): string[] {
  const file = parse(handler);
  const helpers = helpers409(file);
  const found = new Set<string>();
  for (const pin of pinsOf(file)) {
    for (const statement of statementsAfter(pin)) {
      walk(statement, (node) => {
        if (!ts.isCallExpression(node)) return;
        const viaHelper = ts.isIdentifier(node.expression) && helpers.has(node.expression.text);
        if (!viaHelper && !is409(node)) return;
        const body = node.arguments[0];
        const worded = !viaHelper && !!body && ts.isCallExpression(body) && body.expression.getText() === "lostRaceAnswer";
        const text = node.getText();
        if (!worded && !allowed.some((piece) => text.includes(piece))) found.add(text);
      });
    }
  }
  return [...found];
}

/** Every 409 after a pinned write, worded or not (to check that LATER_409 entries still exist). */
function every409After(handler: string): string[] {
  return handWrittenLostRaces(handler);
}

describe("a lost race is worded by lostRaceAnswer alone", () => {
  const all = files();
  const handlers = new Map(
    [...all].flatMap(([file, source]) => [...handlersOf(source)].map(([name, body]) => [`${file}#${name}` as string, body] as const)),
  );

  it("every handler with a pinned write is listed", () => {
    const pinned = [...handlers].filter(([, source]) => hasPinnedWrite(source)).map(([key]) => key);
    expect(pinned.sort()).toEqual([...Object.keys(PINNED), ...Object.keys(OWN_RULE)].sort());
  });

  it.each(Object.keys(PINNED))("%s: every 409 after a pinned write comes from lostRaceAnswer", (key) => {
    const source = handlers.get(key);
    expect(source, key).toBeDefined();
    expect(source, key).toMatch(/\blostRaceAnswer\(/);
    expect(handWrittenLostRaces(source!, Object.keys(LATER_409[key] ?? {})), key).toEqual([]);
  });

  it("each LATER_409 entry is still a 409 after a pinned write", () => {
    for (const [key, entries] of Object.entries(LATER_409)) {
      const later = every409After(handlers.get(key) ?? "");
      for (const piece of Object.keys(entries)) expect(later.some((text) => text.includes(piece)), `${key}: ${piece}`).toBe(true);
    }
  });

  it.each(Object.keys(PINNED))("%s's file words no lost race itself, module constants included", (key) => {
    const file = key.split("#")[0];
    const kept = KEPT_TEXTS[file] ?? {};
    const texts = lostTexts(all.get(file)!);
    expect(texts.filter((text) => !(text in kept))).toEqual([]);
    for (const text of Object.keys(kept)) expect(texts, `${file}: kept "${text}"`).toContain(text);
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

  it("a 409 from a top-of-file function helper, returned after the publish claim", () => {
    const file = `function lost() {
  return NextResponse.json({ error: "Someone else got there first." }, { status: 409 });
}
export async function POST() {
  const result = await applyToPair({
    write: async (db, row) =>
      (await db.postJob.updateMany({ where: { id: row.id, status: { in: ["draft", "scheduled"] }, updatedAt: row.updatedAt }, data: {} })).count === 1,
  });
  if (!result.ok) return lost();
  return NextResponse.json({ ok: true });
}`;
    expect(handWrittenLostRaces(handlersOf(file).get("POST")!, [], file)).not.toEqual([]);
  });

  it("a lost-race sentence kept as a module constant", () => {
    const file = `const DRAFT_GONE = "This draft can no longer be scheduled.";
export async function POST() {
  return NextResponse.json({ error: DRAFT_GONE }, { status: 409 });
}`;
    expect(lostTexts(file)).not.toEqual([]);
  });
});
