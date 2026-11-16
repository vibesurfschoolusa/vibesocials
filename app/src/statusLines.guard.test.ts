import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * R30 PP2 (pages A1 and the class before it: /u, /v, forgot, reset, Add
 * many): a screen reader reads a status line when its text changes, not
 * always when the line is added already filled. Each site was fixed one by
 * one and new ones kept coming. The rule, for every .tsx under src (no
 * tests): an element with role="status" or aria-live is on the page from the
 * component's first render and only its text changes. So it may not stand:
 *
 * - on the right of &&, || or ??;
 * - in a branch of a ternary;
 * - in the branch of an if or a switch case;
 * - in a function that has more than one return (an early return means the
 *   component returns it only sometimes);
 * - in a callback handed to a call (a .map renders one line per item, each
 *   added already filled).
 *
 * role="alert" is out of scope: an alert is read when it is added.
 *
 * Known limits: an element kept in a variable or returned by a helper that
 * the caller renders conditionally is not followed; a component imported
 * from another file and rendered conditionally is not followed.
 *
 * The shared Alert (info, success) and a labelled Spinner may be rendered
 * conditionally: they have no role="status" of their own and announce their
 * text through the page's one announcer (components/ui/announcer.tsx,
 * lib/announcer.test.ts). The checks below keep it that way.
 */

const SRC = __dirname;

/**
 * Regions that truly must mount with their content, each with why. `contains`
 * is a piece of the element's opening tag that names it in its file.
 */
const MOUNTS_WITH_CONTENT: Array<{ file: string; contains: string; why: string }> = [
  {
    file: "components/ui/toast.tsx",
    contains: 'role={toast.variant === "error" ? "alert" : "status"}',
    why: "Each toast is added inside the toaster's own aria-live list, which is on the page from the first render; the list is the region that announces it.",
  },
  {
    file: "components/tiktok-post-settings.tsx",
    contains: 'className="text-xs font-medium text-primary" role="status"',
    why: "Frozen TikTok part of the Create page (F-common): not changed here; to convert when the freeze lifts.",
  },
  {
    file: "components/create-post-form.tsx",
    contains: 'className="text-sm text-muted-foreground" role="status"',
    why: "The TikTok: line by the button (tiktokBlock), a frozen TikTok part of the Create page (F-common); to convert when the freeze lifts.",
  },
  {
    // TEMPORARY (R30): remove when PP2 is rebased on PP1 and converts this site.
    file: "app/c/[token]/connect-link-choice.tsx",
    contains: '<p role="status" className="text-sm text-muted-foreground">',
    why: "PP1 owns this file in round 30; PP2 converts it after the lead rebases PP2 on PP1.",
  },
  {
    file: "components/settings-form.tsx",
    contains: 'id="brandVoiceExamplesCount" aria-live="polite"',
    why: "A counter that always has text (N of 5 examples), in the owner's part of the page, which is fixed while the page is open, so it is there from the first render; only its text changes.",
  },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".tsx") && !/\.test\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return path.relative(SRC, file).split(path.sep).join("/");
}

function attributeIsLive(attr: ts.JsxAttributeLike): boolean {
  if (!ts.isJsxAttribute(attr)) return false;
  const name = attr.name.getText();
  const init = attr.initializer;
  if (name === "aria-live") {
    return !(init && ts.isStringLiteral(init) && init.text === "off");
  }
  if (name !== "role" || !init) return false;
  if (ts.isStringLiteral(init)) return init.text === "status";
  let found = false;
  const visit = (n: ts.Node) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === "status") found = true;
    n.forEachChild(visit);
  };
  visit(init);
  return found;
}

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);
}

/** Return statements of this function, not of functions inside it. */
function ownReturns(fn: ts.FunctionLikeDeclaration): number {
  let count = 0;
  const visit = (n: ts.Node) => {
    if (n !== fn && isFunctionLike(n)) return;
    if (ts.isReturnStatement(n)) count += 1;
    n.forEachChild(visit);
  };
  visit(fn);
  return count;
}

/** Why this element is rendered only sometimes, or null when it is always there. */
function conditionalReason(el: ts.Node): string | null {
  let child: ts.Node = el;
  let parent: ts.Node | undefined = el.parent;
  while (parent) {
    if (ts.isBinaryExpression(parent) && child === parent.right) {
      const op = parent.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        return `on the right of ${parent.operatorToken.getText()}`;
      }
    }
    if (ts.isConditionalExpression(parent) && (child === parent.whenTrue || child === parent.whenFalse)) {
      return "in a ternary branch";
    }
    if (ts.isIfStatement(parent) && (child === parent.thenStatement || child === parent.elseStatement)) {
      return "in an if branch";
    }
    if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) return "in a switch case";
    if (isFunctionLike(parent)) {
      if (ownReturns(parent) > 1) return "in a function with an early return";
      const call = parent.parent;
      if (
        call &&
        ts.isCallExpression(call) &&
        call.arguments.includes(parent as ts.Expression) &&
        ts.isPropertyAccessExpression(call.expression) &&
        /^(map|flatMap)$/.test(call.expression.name.text)
      ) {
        return "in a .map callback (one line per item, each added already filled)";
      }
      return null;
    }
    child = parent;
    parent = parent.parent;
  }
  return null;
}

type Site = { file: string; line: number; tag: string; reason: string };

function findSites(): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    if (!/role=|aria-live/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node) => {
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        if (n.attributes.properties.some(attributeIsLive)) {
          const element = ts.isJsxOpeningElement(n) ? n.parent : n;
          const reason = conditionalReason(element);
          if (reason) {
            sites.push({
              file: rel(file),
              line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
              tag: n.getText(sf).replace(/\s+/g, " "),
              reason,
            });
          }
        }
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return sites;
}

describe("status lines are on the page from the first render (R30 PP2)", () => {
  const sites = findSites();
  const excepted = (s: Site) => MOUNTS_WITH_CONTENT.some((e) => e.file === s.file && s.tag.includes(e.contains));

  it("no role=\"status\" or aria-live element is rendered conditionally", () => {
    const bad = sites.filter((s) => !excepted(s)).map((s) => `${s.file}:${s.line} ${s.reason}: ${s.tag}`);
    expect(bad).toEqual([]);
  });

  it("every named exception still names a site and says why", () => {
    for (const e of MOUNTS_WITH_CONTENT) {
      expect(e.why.length, `${e.file} ${e.contains}`).toBeGreaterThan(20);
      expect(sites.some((s) => s.file === e.file && s.tag.includes(e.contains)), `${e.file} ${e.contains}`).toBe(true);
    }
  });

  // The rule's own cases, so a change to the walker can't quietly stop finding them.
  it("finds the shapes it is meant to find", () => {
    const probe = (code: string) => {
      const sf = ts.createSourceFile("probe.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let reason: string | null | undefined;
      const visit = (n: ts.Node) => {
        if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.attributes.properties.some(attributeIsLive)) {
          reason = conditionalReason(ts.isJsxOpeningElement(n) ? n.parent : n);
        }
        n.forEachChild(visit);
      };
      visit(sf);
      return reason;
    };
    expect(probe(`function A({m}) { return <div>{m && <p role="status">{m}</p>}</div>; }`)).toMatch(/&&/);
    expect(probe(`function A({m}) { return <div>{m ? <p aria-live="polite">{m}</p> : null}</div>; }`)).toMatch(/ternary/);
    expect(probe(`function A({m}) { if (!m) return null; return <p role="status">{m}</p>; }`)).toMatch(/early return/);
    expect(probe(`function A({xs}) { return <ul>{xs.map((x) => <li role="status">{x}</li>)}</ul>; }`)).toMatch(/\.map callback/);
    expect(probe(`const A = forwardRef(function A({m}, ref) { return <p ref={ref} role="status">{m}</p>; });`)).toBeNull();
    expect(probe(`function A({m}) { return <p role="status" className="empty:sr-only">{m}</p>; }`)).toBeNull();
    expect(probe(`function A({m}) { return <p role="alert">{m}</p>; }`)).toBeUndefined();
    expect(probe(`function A({m}) { return <p aria-live="off">{m}</p>; }`)).toBeUndefined();
    // R30 PP2 (lead): these announce through the announcer, so they may come and go.
    expect(probe(`function A({m}) { return <div>{m && <Alert variant="success">{m}</Alert>}</div>; }`)).toBeUndefined();
    expect(probe(`function A({m}) { return <div>{m ? <Spinner label="Loading" /> : null}</div>; }`)).toBeUndefined();
  });

  it("Alert and Spinner carry no role=\"status\" of their own, and announce instead", () => {
    const alert = readFileSync(path.join(SRC, "components/ui/alert.tsx"), "utf8");
    const spinner = readFileSync(path.join(SRC, "components/ui/spinner.tsx"), "utf8");
    for (const source of [alert, spinner]) {
      expect(source).not.toContain('"status"');
      expect(source).toContain("useAnnounceOnShow(");
    }
  });
});
