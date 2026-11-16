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
 * A line inside a component of the same file is judged where that component
 * is rendered, and a line kept in a variable where the variable is used.
 *
 * Known limits: a line returned by a plain helper call, and a component
 * imported from another file and rendered conditionally, are not followed.
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

/** The name a component function is known by in its file, or null. */
function componentName(fn: ts.FunctionLikeDeclaration): string | null {
  let name: string | null = null;
  if (ts.isFunctionDeclaration(fn) && fn.name) name = fn.name.text;
  else if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) name = fn.parent.name.text;
  else if (ts.isCallExpression(fn.parent) && ts.isVariableDeclaration(fn.parent.parent) && ts.isIdentifier(fn.parent.parent.name)) {
    name = fn.parent.parent.name.text; // forwardRef(function X() {...}) and the like
  }
  return name && /^[A-Z]/.test(name) ? name : null;
}

function nodesWhere(root: ts.Node, test: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (test(n)) out.push(n);
    n.forEachChild(visit);
  };
  visit(root);
  return out;
}

/**
 * Why this element is rendered only sometimes, or null when it is always
 * there. R30 lead review: a line inside a component of the same file is
 * judged where that component is rendered, and a line kept in a variable
 * where the variable is used.
 */
function conditionalReason(el: ts.Node, seen: Set<ts.Node> = new Set()): string | null {
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
    if (ts.isVariableDeclaration(parent) && child === parent.initializer && ts.isIdentifier(parent.name)) {
      if (seen.has(parent)) return null;
      seen.add(parent);
      const name = parent.name.text;
      const declaration = parent.name;
      let scope: ts.Node = parent;
      while (scope.parent && !isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
      for (const use of nodesWhere(scope, (n) => ts.isIdentifier(n) && n.text === name && n !== declaration)) {
        const reason = conditionalReason(use, seen);
        if (reason) return `kept in ${name}, used ${reason}`;
      }
      return null;
    }
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
      const name = componentName(parent);
      if (name && !seen.has(parent)) {
        seen.add(parent);
        const uses = nodesWhere(
          parent.getSourceFile(),
          (n) => (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText() === name,
        );
        for (const use of uses) {
          const reason = conditionalReason(ts.isJsxOpeningElement(use) ? use.parent : use, seen);
          if (reason) return `in <${name}>, rendered ${reason}`;
        }
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
    // R30 lead review: a same-file component rendered conditionally, and a line kept in a variable.
    expect(probe(`function L() { return <p role="status">Loading</p>; } function A({m}) { return <div>{m ? <L /> : null}</div>; }`)).toMatch(/in <L>, rendered in a ternary/);
    expect(probe(`function A({m}) { const line = <p role="status">{m}</p>; return <div>{m && line}</div>; }`)).toMatch(/kept in line, used on the right of &&/);
    expect(probe(`function A({m}) { const line = <p role="status">{m}</p>; return <div>{line}</div>; }`)).toBeNull();
    expect(probe(`function L({m}) { return <p role="status">{m}</p>; } function A({m}) { return <div><L m={m} /></div>; }`)).toBeNull();
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
