import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * R28 NN2 (new-customer L1 L2, client-journey L1, pages L1, publishing L3):
 * round after round, a press whose answer was lost told the person "nothing
 * changed", "the account is still connected" or "the old links still work",
 * though the request may have reached the server and done its work. Each
 * site was fixed one by one and new ones kept coming. Two rules, for every
 * file that can run in the browser (src outside app/api and server, no tests):
 *
 * 1. A request that changes data (POST, PATCH, PUT, DELETE) goes through
 *    fetchOrNoAnswer, so a lost answer is told apart from a server's answer.
 *    Plain fetch is allowed only where the method is visibly a read: no second
 *    argument, or an inline object whose `method` (if any) is the literal GET
 *    or HEAD, with no spread. An init held in a variable, a spread, a method
 *    from a variable or fetch passed around as a value all count as a change,
 *    so a variable can't hide one.
 *
 * 2. A no-answer branch never says nothing happened. A no-answer branch is:
 *    the branch an `isNoAnswer(...)` test chooses, a catch clause, a
 *    `.catch(...)` callback, an `unreachableText` prop or field, the second
 *    argument of confirmFailureText, and the value of any constant, function
 *    or field whose name says no answer (unreachable, no answer, offline,
 *    lost, network). Its text is read from the syntax tree, following names
 *    to their constants and functions in the same file and across imports,
 *    so moving a sentence into a variable doesn't hide it. The only exception
 *    is a branch chosen by `navigator.onLine` being false: the browser was
 *    offline at the press, so nothing was sent.
 */

const SRC = __dirname;

/**
 * Sentences that are true whatever reached the server, named one by one.
 * CAPTION_OFFLINE_MESSAGE, CAPTION_FAILED_MESSAGE: asking for an AI caption
 * saves nothing on the server, and the caption box changes only from an
 * answer, so "your caption is unchanged" holds after a lost answer too.
 */
const TRUE_WHATEVER_ARRIVED: Array<{ file: string; constant: string }> = [
  { file: "lib/captionRequest.ts", constant: "CAPTION_OFFLINE_MESSAGE" },
  { file: "lib/captionRequest.ts", constant: "CAPTION_FAILED_MESSAGE" },
];

function isTrueWhateverArrived(file: string, name: string): boolean {
  return TRUE_WHATEVER_ARRIVED.some((entry) => entry.file === rel(file) && entry.constant === name);
}

/** Wordings that say a request which may have arrived did nothing. */
const SAYS_NOTHING_HAPPENED =
  /nothing (?:has |was |is )?(?:changed|saved|sent|posted|deleted|removed|done|connected|created)|unchanged|still connected|still works?\b|still on\b|stays? (?:the same|connected|on)|(?:wasn['’]t|was not|weren['’]t|were not|isn['’]t|is not|hasn['’]t|has not|haven['’]t|have not) (?:been )?(?:changed|posted|saved|sent|deleted|removed|disconnected|replaced|turned off|made|created|cancell?ed|moved|rescheduled|updated)|\bno (?:\w+ )?(?:was|were) (?:sent|saved|made|changed|posted|deleted|removed|created|connected)|didn['’]t (?:change|go through|happen)|no changes? (?:was|were)? ?made/i;

const NO_ANSWER_NAME = /unreachable|no_?answer|offline|answer_?lost|lost_?answer|network|connection_?lost|lost_?connection/i;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return path.relative(SRC, file).split(path.sep).join("/");
}

/** Not browser code whatever imports it: route handlers and server code. */
function isServerFile(file: string): boolean {
  const name = rel(file);
  if (name.startsWith("app/api/") || name.startsWith("server/")) return true;
  if (/(^|\/)route\.tsx?$/.test(name)) return true;
  return /^\s*import\s+["']server-only["']/m.test(readFileSync(file, "utf8"));
}

/** True when the file's first statement is the "use client" directive. */
function isClientModule(source: string): boolean {
  const withoutComments = source.replace(/^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/, "");
  return /^\s*["']use client["']/.test(withoutComments);
}

const parsed = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  let sf = parsed.get(file);
  if (!sf) {
    sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    parsed.set(file, sf);
  }
  return sf;
}

function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fixtureFiles.includes(candidate)) return candidate;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The guard's own test sources, parsed from strings (fake()). */
const fixtureFiles: string[] = [];

type Value = { node: ts.Node } | { from: string; name: string };

/** Every name in a file that holds a value: consts, functions, imports. */
const valuesCache = new Map<string, Map<string, Value[]>>();
function valuesOf(sf: ts.SourceFile): Map<string, Value[]> {
  const cached = valuesCache.get(sf.fileName);
  if (cached) return cached;
  const out = new Map<string, Value[]>();
  const add = (name: string, value: Value) => out.set(name, [...(out.get(name) ?? []), value]);
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) add(node.name.text, { node: node.initializer });
    if (ts.isFunctionDeclaration(node) && node.name && node.body) add(node.name.text, { node: node.body });
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      const target = resolveImport(sf.fileName, node.moduleSpecifier.text);
      if (target) {
        for (const element of node.importClause.namedBindings.elements) {
          add(element.name.text, { from: target, name: (element.propertyName ?? element.name).text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  valuesCache.set(sf.fileName, out);
  return out;
}

/**
 * What a name stands for where it is used: the nearest enclosing declaration
 * (a parameter's value is not known, so nothing), else an import.
 */
function resolveName(id: ts.Identifier): ts.Node[] {
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === id.text)) return [];
    if (ts.isCatchClause(scope) && scope.variableDeclaration && ts.isIdentifier(scope.variableDeclaration.name) && scope.variableDeclaration.name.text === id.text) return [];
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
      const found: ts.Node[] = [];
      for (const statement of scope.statements) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === id.text && declaration.initializer) found.push(declaration.initializer);
          }
        }
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === id.text && statement.body) found.push(statement.body);
      }
      if (found.length > 0) return found;
    }
  }
  const sf = id.getSourceFile();
  return (valuesOf(sf).get(id.text) ?? []).flatMap((value) => ("from" in value ? lookup(parse(value.from), value.name) : []));
}

/** The nodes a name in a file stands for, through imports. */
function lookup(sf: ts.SourceFile, name: string, hops = 0): ts.Node[] {
  if (hops > 20) return [];
  return (valuesOf(sf).get(name) ?? []).flatMap((value) =>
    "node" in value ? [value.node] : lookup(parse(value.from), value.name, hops + 1),
  );
}

function testOf(node: ts.IfStatement | ts.ConditionalExpression): ts.Expression {
  return ts.isIfStatement(node) ? node.expression : node.condition;
}

type Side = "true" | "false";

function flip(side: Side | null): Side | null {
  return side === null ? null : side === "true" ? "false" : "true";
}

function isNavigatorOnLine(node: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "onLine") return false;
  const owner = node.expression;
  return (ts.isIdentifier(owner) && owner.text === "navigator") || (ts.isPropertyAccessExpression(owner) && owner.name.text === "navigator");
}

/**
 * Which side of a test is taken when the browser was offline AT THE PRESS:
 * "true" (the then side), "false" (the else side), or null when that can't
 * be told: then both sides are read. Lead review 2: `navigator.onLine` read
 * where the test is (in a catch, after the request) says nothing about the
 * press, so it counts only inside the initializer of a value captured before
 * the request (`captured`); a value counts by where it came from, never by
 * its name.
 */
function offlineSide(condition: ts.Expression, captured = false, visiting = new Set<ts.Node>()): Side | null {
  let node = condition;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (isNavigatorOnLine(node)) return captured ? "false" : null;
  if (ts.isIdentifier(node)) return capturedOnLineSide(node, visiting);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return flip(offlineSide(node.operand, captured, visiting));
  }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    const equal = kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.EqualsEqualsToken;
    const notEqual = kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken;
    if (!equal && !notEqual) return null;
    const literal = [node.left, node.right].find((side) => side.kind === ts.SyntaxKind.TrueKeyword || side.kind === ts.SyntaxKind.FalseKeyword);
    const read = [node.left, node.right].find((side) => side !== literal);
    if (!literal || !read) return null;
    const inner = offlineSide(read, captured, visiting);
    if (inner === null) return null;
    // `x === true` and `x !== false` keep x's sense; `x === false` and `x !== true` flip it.
    const keeps = (literal.kind === ts.SyntaxKind.TrueKeyword) === equal;
    return keeps ? inner : flip(inner);
  }
  return null;
}

/** The first `await` in a function body, not counting functions inside it. */
function firstAwait(body: ts.Node): number | null {
  let found: number | null = null;
  const visit = (node: ts.Node) => {
    if (found !== null || (node !== body && ts.isFunctionLike(node))) return;
    if (ts.isAwaitExpression(node)) {
      found = node.getStart();
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/**
 * The offline side of a name that holds a captured onLine value: a const or
 * let whose initializer reads navigator.onLine, declared before the
 * function's first await and not in a catch or a `.catch`/`.then` callback; or
 * a parameter every caller fills with such a value (or leaves to a default
 * of true). Anything else: null.
 */
function capturedOnLineSide(id: ts.Identifier, visiting: Set<ts.Node>): Side | null {
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const index = scope.parameters.findIndex((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === id.text);
      if (index >= 0) return parameterSide(scope, index, visiting);
    }
    if (!(ts.isBlock(scope) || ts.isSourceFile(scope))) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const declaration = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === id.text);
      if (!declaration?.initializer) continue;
      if (visiting.has(declaration)) return null;
      visiting.add(declaration);
      let fn: ts.Node = statement;
      while (fn.parent && !ts.isFunctionLike(fn) && !ts.isSourceFile(fn)) {
        if (ts.isCatchClause(fn)) return null;
        fn = fn.parent;
      }
      if (ts.isFunctionLike(fn)) {
        const call = fn.parent;
        if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && ["catch", "then", "finally"].includes(call.expression.name.text)) return null;
        const body = (fn as ts.FunctionLikeDeclaration).body;
        const awaited = body ? firstAwait(body) : null;
        if (awaited !== null && statement.getStart() > awaited) return null;
      }
      return offlineSide(declaration.initializer, true, visiting);
    }
  }
  return null;
}

/** A parameter's offline side, from every call of its function in the scanned files. */
function parameterSide(fn: ts.SignatureDeclaration, index: number, visiting: Set<ts.Node>): Side | null {
  const parameter = fn.parameters[index];
  if (visiting.has(parameter)) return null;
  visiting.add(parameter);
  const name =
    ts.isFunctionDeclaration(fn) && fn.name
      ? fn.name.text
      : ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)
        ? fn.parent.name.text
        : null;
  if (!name) return null;
  const sf = fn.getSourceFile();
  const uses = [...usesIn(sf, name), ...importedUses(sf.fileName, name)];
  // A default of true is "online": a call that leaves it out never says nothing was sent.
  const defaultOnline = parameter.initializer?.kind === ts.SyntaxKind.TrueKeyword;
  let side: Side | null = null;
  let calls = 0;
  for (const use of uses) {
    const call = use.parent;
    if (!ts.isCallExpression(call) || call.expression !== use) return null;
    calls += 1;
    const argument = call.arguments[index];
    if (!argument) {
      if (!defaultOnline) return null;
      continue;
    }
    const argumentSide = offlineSide(argument, false, visiting);
    if (argumentSide === null || (side !== null && side !== argumentSide)) return null;
    side = argumentSide;
  }
  return calls > 0 ? (side ?? "false") : null;
}

/** The expressions a function body returns, not those of functions inside it. */
function returnsOf(body: ts.Block): ts.Expression[] {
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
    ts.forEachChild(node, visit);
  };
  body.statements.forEach(visit);
  return out;
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

/** Text in a no-answer branch that says nothing happened, following names. */
function sayings(node: ts.Node, seen: Set<ts.Node>, out: Finding[]): void {
  if (seen.has(node)) return;
  seen.add(node);
  const sf = node.getSourceFile();
  const report = (text: string) => {
    if (SAYS_NOTHING_HAPPENED.test(text)) {
      out.push({ file: rel(sf.fileName), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
    }
  };
  // Offline at the press: nothing was sent, so only that side may say so.
  if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
    const offline = offlineSide(testOf(node));
    if (offline !== null) {
      const [whenTrue, whenFalse] = ts.isIfStatement(node) ? [node.thenStatement, node.elseStatement] : [node.whenTrue, node.whenFalse];
      const online = offline === "true" ? whenFalse : whenTrue;
      if (online) sayings(online, seen, out);
      return;
    }
  }
  // Inside a catch, `isNoAnswer(error) ? lost : other`: only the lost branch is a no-answer branch.
  if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
    const test = containsNoAnswerTest(testOf(node));
    const [whenTrue, whenFalse] = ts.isIfStatement(node) ? [node.thenStatement, node.elseStatement] : [node.whenTrue, node.whenFalse];
    if (test === "yes") return sayings(whenTrue, seen, out);
    if (test === "negated") {
      if (whenFalse) sayings(whenFalse, seen, out);
      return;
    }
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) report(node.text);
  if (ts.isTemplateExpression(node)) report(node.getText());
  if (ts.isIdentifier(node)) {
    const parent = node.parent;
    const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node);
    // A name is read through to its value. A function with a body is read
    // through what it returns (lead review): a helper that returns "nothing
    // changed" is caught where it is called. A one-line arrow is a value.
    if (!isPropertyName) {
      for (let value of resolveName(node)) {
        if (isTrueWhateverArrived(value.getSourceFile().fileName, node.text)) continue;
        const body = ts.isBlock(value) ? value : (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) && ts.isBlock(value.body) ? value.body : null;
        if (body) {
          for (const returned of returnsOf(body)) sayings(returned, seen, out);
          continue;
        }
        // `MESSAGES.saveLost`: only that field of an object constant.
        while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node && ts.isObjectLiteralExpression(value)) {
          const field = value.properties.find((property) => nameText(property.name) === parent.name.text);
          if (field && ts.isPropertyAssignment(field)) sayings(field.initializer, seen, out);
          else if (!field) sayings(value, seen, out); // a spread or a computed key: read it all
          continue;
        }
        sayings(value, seen, out);
      }
    }
  }
  ts.forEachChild(node, (child) => sayings(child, seen, out));
}

function containsNoAnswerTest(expression: ts.Node): "yes" | "negated" | "no" {
  let found: "yes" | "negated" | "no" = "no";
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "isNoAnswer") {
      const negated = ts.isPrefixUnaryExpression(node.parent) && node.parent.operator === ts.SyntaxKind.ExclamationToken;
      found = negated ? "negated" : "yes";
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function comparesWithNoAnswerName(condition: ts.Expression): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(node.operatorToken.kind) &&
      [node.left, node.right].some((side) => (ts.isStringLiteral(side) || ts.isNoSubstitutionTemplateLiteral(side)) && NO_ANSWER_NAME.test(side.text))
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(condition);
  return found;
}

function nameText(name: ts.Node | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  return null;
}

/** The no-answer branches of one file. */
function noAnswerBranches(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      const test = containsNoAnswerTest(testOf(node));
      const [whenTrue, whenFalse] = ts.isIfStatement(node) ? [node.thenStatement, node.elseStatement] : [node.whenTrue, node.whenFalse];
      if (test === "yes") out.push(whenTrue);
      if (test === "negated" && whenFalse) out.push(whenFalse);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && containsNoAnswerTest(node.left) === "yes") out.push(node.right);
    // `attempt === "network"`, `kind === "no_answer"`: an outcome named for no answer.
    if ((ts.isIfStatement(node) || ts.isConditionalExpression(node)) && comparesWithNoAnswerName(testOf(node))) {
      out.push(ts.isIfStatement(node) ? node.thenStatement : node.whenTrue);
    }
    if (ts.isCatchClause(node)) out.push(node.block);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "catch") out.push(...node.arguments);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "confirmFailureText" && node.arguments[1]) out.push(node.arguments[1]);
    if (ts.isJsxAttribute(node) && nameText(node.name) === "unreachableText" && node.initializer) out.push(node.initializer);
    if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) && node.initializer) {
      const name = nameText(node.name);
      if (name && (name === "unreachableText" || NO_ANSWER_NAME.test(name)) && !isTrueWhateverArrived(sf.fileName, name)) out.push(node.initializer);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body && NO_ANSWER_NAME.test(nameText(node.name) ?? "")) out.push(node.body);
    if (ts.isCaseClause(node) && (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression)) && NO_ANSWER_NAME.test(node.expression.text)) out.push(...node.statements);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Every use, in the scanned files, of `name` imported from `file` (under any
 * local name). Re-exports and `export default` are not followed.
 */
function importedUses(file: string, name: string): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  // A parsed file's name uses forward slashes; the file list uses the system's.
  const target = path.resolve(file);
  for (const other of [...browserFileList(), ...fixtureFiles]) {
    if (path.resolve(other) === target) continue;
    const sf = parse(other);
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const from = resolveImport(other, statement.moduleSpecifier.text);
      if (!from || path.resolve(from) !== target) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === name) out.push(...usesIn(sf, element.name.text));
      }
    }
  }
  return out;
}

/** The function a callee names, in its own file or across an import. */
function functionsNamed(sf: ts.SourceFile, callee: ts.Expression): ts.SignatureDeclaration[] {
  if (!ts.isIdentifier(callee)) return [];
  return lookup(sf, callee.text)
    .map((value) => (ts.isBlock(value) ? value.parent : value))
    .filter((node): node is ts.SignatureDeclaration => ts.isFunctionLike(node));
}

/** Where a request is safe whatever fetch it is given: these tell a lost answer apart. */
const SAFE_SINKS: Array<{ fn: string; arg: number; key?: string }> = [
  { fn: "fetchOrNoAnswer", arg: 2 },
  { fn: "sendActionRequest", arg: 2, key: "fetchImpl" },
];

function readOnlyInit(init: ts.Expression | undefined): boolean {
  if (!init) return true;
  if (!ts.isObjectLiteralExpression(init)) return false;
  for (const property of init.properties) {
    if (ts.isSpreadAssignment(property)) return false;
    if (nameText(property.name) !== "method") continue;
    if (!ts.isPropertyAssignment(property)) return false;
    const value = property.initializer;
    if (!(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) || !/^(get|head)$/i.test(value.text)) return false;
  }
  return true;
}

/** Every use of a name inside a scope (shadowing is not told apart: stricter, never looser). */
function usesIn(scope: ts.Node, name: string): ts.Identifier[] {
  const uses: ts.Identifier[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent;
      const isDeclaration =
        ((ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) ||
        ts.isTypeQueryNode(parent) ||
        ts.isImportSpecifier(parent) ||
        ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) && parent.name === node);
      if (!isDeclaration) uses.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return uses;
}

/**
 * Plain fetch calls that may change data. Tests swap fetch for a fake through
 * a parameter, so the global fetch is followed wherever it goes: into a
 * parameter (as its default or an argument, across imports), into a variable
 * or into a field; every call of what holds it is held to the rule. Handed to
 * fetchOrNoAnswer (or sendActionRequest) it is safe; anywhere the scan can't
 * follow, it is flagged.
 */
function plainFetchesThatMayChange(sf: ts.SourceFile): Finding[] {
  const out: Finding[] = [];
  const at = (node: ts.Node, text: string) => {
    const file = node.getSourceFile();
    out.push({ file: rel(file.fileName), line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
  };
  const followed = new Set<ts.Node>();
  const isWrapper = (node: ts.Node) =>
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node);
  const followParameter = (fn: ts.SignatureDeclaration, index: number) => {
    const parameter = fn.parameters[index];
    if (!parameter || followed.has(parameter)) return;
    followed.add(parameter);
    if (!ts.isIdentifier(parameter.name)) return at(parameter, `fetch handed into a destructured parameter: ${parameter.getText()}`);
    const body = (fn as ts.FunctionLikeDeclaration).body;
    if (body) for (const use of usesIn(body, parameter.name.text)) holder(use);
  };
  /** One place where an expression holding fetch appears. */
  const holder = (node: ts.Expression) => {
    let here: ts.Node = node;
    while (isWrapper(here.parent)) here = here.parent;
    let parent = here.parent;
    // `a ?? fetch`, `a || fetch`, `cond ? fetch : b`: the whole holds fetch.
    while (
      (ts.isBinaryExpression(parent) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind)) ||
      (ts.isConditionalExpression(parent) && parent.condition !== here)
    ) {
      here = parent;
      while (isWrapper(here.parent)) here = here.parent;
      parent = here.parent;
    }
    const file = node.getSourceFile();
    if (ts.isCallExpression(parent) && parent.expression === here) {
      if (!readOnlyInit(parent.arguments[1])) at(parent, parent.getText().slice(0, 120));
      return;
    }
    if (ts.isCallExpression(parent)) {
      const index = parent.arguments.indexOf(here as ts.Expression);
      const name = ts.isIdentifier(parent.expression) ? parent.expression.text : "";
      if (SAFE_SINKS.some((sink) => sink.fn === name && sink.arg === index && !sink.key)) return;
      const fns = functionsNamed(file, parent.expression);
      if (fns.length === 0) return at(parent, `fetch handed to a function the scan can't follow: ${parent.getText().slice(0, 120)}`);
      for (const fn of fns) followParameter(fn, index);
      return;
    }
    if (ts.isParameter(parent) && parent.initializer === here) {
      const fn = parent.parent;
      if (ts.isFunctionLike(fn)) followParameter(fn, fn.parameters.indexOf(parent));
      return;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === here && ts.isIdentifier(parent.name)) {
      if (followed.has(parent)) return;
      followed.add(parent);
      let scope: ts.Node = parent;
      while (scope.parent && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
      for (const use of usesIn(scope, parent.name.text)) holder(use);
      // Lead review: an exported alias is followed into every file that imports it.
      if (ts.isSourceFile(scope)) for (const use of importedUses(scope.fileName, parent.name.text)) holder(use);
      return;
    }
    // `{ fetchImpl: held }` or `{ fetchImpl }` handed to a sink that tells a lost answer apart.
    const inField = (ts.isPropertyAssignment(parent) && parent.initializer === here) || (ts.isShorthandPropertyAssignment(parent) && parent.name === here);
    if (inField && ts.isObjectLiteralExpression(parent.parent)) {
      const call = parent.parent.parent;
      const key = nameText((parent as ts.PropertyAssignment | ts.ShorthandPropertyAssignment).name);
      if (ts.isCallExpression(call) && ts.isIdentifier(call.expression)) {
        const index = call.arguments.indexOf(parent.parent);
        const fn = call.expression.text;
        if (SAFE_SINKS.some((sink) => sink.fn === fn && sink.arg === index && sink.key === key)) return;
      }
    }
    at(here, `fetch held where the scan can't follow it: ${parent.getText().slice(0, 120)}`);
  };
  const visit = (node: ts.Node) => {
    const isGlobalFetch =
      (ts.isIdentifier(node) && node.text === "fetch") ||
      (ts.isPropertyAccessExpression(node) && node.name.text === "fetch" && ts.isIdentifier(node.expression) && ["window", "globalThis", "self"].includes(node.expression.text));
    if (isGlobalFetch) {
      const parent = node.parent;
      const notTheGlobal =
        ts.isTypeQueryNode(parent) ||
        (ts.isIdentifier(node) && ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isIdentifier(node) &&
          (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) || ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) &&
          parent.name === node);
      if (ts.isShorthandPropertyAssignment(parent)) at(node, `fetch held where the scan can't follow it: ${parent.parent.getText().slice(0, 120)}`);
      else if (!notTheGlobal) holder(node as ts.Expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * The code that runs in the browser: every "use client" module and every
 * file it imports, on and on (type-only imports are erased, so not followed).
 */
function browserFiles(): string[] {
  const all = sourceFiles(SRC).filter((file) => !isServerFile(file));
  const reached = new Set(all.filter((file) => isClientModule(readFileSync(file, "utf8"))));
  const queue = [...reached];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    for (const statement of parse(file).statements) {
      const specifier =
        (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) || ts.isExportDeclaration(statement)
          ? statement.moduleSpecifier
          : undefined;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      const target = resolveImport(file, specifier.text);
      if (target && !reached.has(target) && !isServerFile(target) && !/\.test\.tsx?$/.test(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }
  return [...reached].sort();
}

let browserFilesCache: string[] | null = null;
function browserFileList(): string[] {
  browserFilesCache ??= browserFiles();
  return browserFilesCache;
}

const clientFiles = browserFileList();

/** Findings in one scan, deduplicated (a followed helper can be reached from two callers). */
function fetchFindings(files: string[]): Finding[] {
  const all = files.filter((file) => rel(file) !== "lib/requestNoAnswer.ts").flatMap((file) => plainFetchesThatMayChange(parse(file)));
  return [...new Map(all.map((finding) => [`${finding.file}:${finding.line}`, finding])).values()];
}

function wordingFindings(files: string[]): Finding[] {
  const all = files.flatMap((file) => {
    const found: Finding[] = [];
    const seen = new Set<ts.Node>();
    for (const branch of noAnswerBranches(parse(file))) sayings(branch, seen, found);
    return found;
  });
  return [...new Map(all.map((finding) => [`${finding.file}:${finding.line}`, finding])).values()];
}

/** A source file the scan reads as if it were in src. */
function fake(name: string, code: string): string {
  const file = path.join(SRC, "__guard_fixture__", name);
  parsed.set(file, ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  if (!fixtureFiles.includes(file)) fixtureFiles.push(file);
  return file;
}

describe("the guard itself: a variable can't hide a change or a sentence", () => {
  it("flags plain fetch that changes data, however the method or init is held", () => {
    const flagged = [
      `fetch("/x", { method: "POST" });`,
      `const init = { method: "POST" }; fetch("/x", init);`,
      `const verb = "DELETE"; fetch("/x", { method: verb });`,
      `fetch("/x", { ...options });`,
      `window.fetch("/x", { method: "PATCH" });`,
      `const send = fetch; send("/x", { method: "PUT" });`,
      `function go(fetchImpl: typeof fetch = fetch) { return fetchImpl("/x", { method: "POST" }); }`,
      `function go(run: typeof fetch) { return run("/x", { method: "POST" }); } go(fetch);`,
      `const deps = { fetch }; deps.fetch("/x", { method: "POST" });`,
    ];
    flagged.forEach((code, index) => {
      expect(fetchFindings([fake(`flag${index}.ts`, code)]), code).toHaveLength(1);
    });
  });

  it("lets reads and fetchOrNoAnswer through", () => {
    const fine = [
      `fetch("/x");`,
      `fetch("/x", { cache: "no-store" });`,
      `fetch("/x", { method: "GET", signal });`,
      `function go(fetchImpl: typeof fetch = fetch) { return fetchOrNoAnswer("/x", { method: "POST" }, fetchImpl); }`,
      `sendActionRequest("/x", { method: "POST" }, { fetchImpl: fetch });`,
      `function read(fetchImpl: typeof fetch = fetch) { return fetchImpl("/x"); }`,
    ];
    fine.forEach((code, index) => {
      expect(fetchFindings([fake(`fine${index}.ts`, code)]), code).toEqual([]);
    });
  });

  it("flags 'nothing changed' in a no-answer branch, through a constant or a field", () => {
    const flagged = [
      `try { await go(); } catch { show("Nothing changed. Try again."); }`,
      `const LOST = "The account is still connected."; try { await go(); } catch { show(LOST); }`,
      `const TEXTS = { lost: "Your password wasn't changed." }; if (isNoAnswer(error)) show(TEXTS.lost);`,
      `export const SAVE_OFFLINE_MESSAGE = "so the location wasn't saved";`,
      `<ConfirmDialog unreachableText="We couldn't reach Vibe Socials, so nothing changed." />;`,
      `confirmFailureText(error, "The old links still work.");`,
      `if (attempt === "network") show("No email was sent.");`,
    ];
    flagged.forEach((code, index) => {
      expect(wordingFindings([fake(`say${index}.tsx`, code)]).length, code).toBeGreaterThan(0);
    });
  });

  it("lets a server's refusal, the offline-at-the-press branch and comments through", () => {
    const fine = [
      `try { await go(); } catch (error) { show(isNoAnswer(error) ? LOST : "Nothing changed."); }`,
      `async function press() { const online = navigator.onLine; try { await go(); } catch { if (online === false) show("Nothing was sent."); } }`,
      `if (!response.ok) show("Nothing changed.");`,
      `try { await go(); } catch { /* nothing changed */ show(answerLostText("it may have gone through", "Reload.")); }`,
    ];
    fine.forEach((code, index) => {
      expect(wordingFindings([fake(`quiet${index}.tsx`, code)]), code).toEqual([]);
    });
  });
});

// Lead review (R28 NN2): only the side where the browser is offline may say nothing was sent.
describe("the guard itself: the offline side of an onLine test", () => {
  // Captured at the press, before the request.
  const at = (code: string) => `async function press() { const online = navigator.onLine; try { await go(); } catch { ${code} } }`;
  const flagged = [
    at(`if (online) show("Nothing was sent.");`),
    at(`if (online === true) show("Nothing was sent.");`),
    at(`if (online !== false) show("Nothing was sent.");`),
    at(`if (!online) {} else { show("Nothing was sent."); }`),
    at(`show(online ? "Nothing was sent." : LOST);`),
    at(`show(online === false ? LOST : "Nothing was sent.");`),
    // Can't tell which side is offline: both are read.
    at(`show(online && ready ? LOST : "Nothing was sent.");`),
    // Lead review 2: read where the test is, not at the press.
    `async function press() { try { await go(); } catch { if (!navigator.onLine) show("Nothing was sent."); } }`,
    `async function press() { try { await go(); } catch { const online = navigator.onLine; if (!online) show("Nothing was sent."); } }`,
    `async function press(e: unknown) { await go(); const online = navigator.onLine; if (isNoAnswer(e)) { if (!online) show("Nothing was sent."); } }`,
    `fetch("/x").catch(() => { const online = navigator.onLine; if (!online) show("Nothing was sent."); });`,
    // A name is not a read: what it holds is.
    `async function press() { const onLineAtPress = ready; try { await go(); } catch { show(onLineAtPress === false ? "Nothing was sent." : LOST); } }`,
    `async function press() { const onLineLost = !navigator.onLine; try { await go(); } catch { if (!onLineLost) show("Nothing was sent."); } }`,
    // A parameter counts only when its callers pass a captured value.
    `function lostText(e: unknown, onLineAtPress = true) { return onLineAtPress === false ? "Nothing was sent." : LOST; }
async function press() { try { await go(); } catch (e) { show(lostText(e, navigator.onLine)); } }`,
  ];
  const fine = [
    at(`if (!online) show("Nothing was sent.");`),
    at(`if (online === false) show("Nothing was sent.");`),
    at(`if (online !== true) show("Nothing was sent.");`),
    at(`if (online) {} else { show("Nothing was sent."); }`),
    at(`show(online ? LOST : "Nothing was sent.");`),
    at(`show(online == false ? "Nothing was sent." : LOST);`),
    at(`show(false === online ? "Nothing was sent." : LOST);`),
    at(`show(!(online) ? "Nothing was sent." : LOST);`),
    `async function press() { const sentOffline = navigator.onLine === false; try { await go(); } catch { if (sentOffline) show("Nothing was sent."); } }`,
    `async function press() { const onLineLost = !navigator.onLine; try { await go(); } catch { if (onLineLost) show("Nothing was sent."); } }`,
    `function lostText(e: unknown, onLineAtPress = true) { return onLineAtPress === false ? "Nothing was sent." : LOST; }
async function press() { const onLineAtPress = navigator.onLine !== false; try { await go(); } catch (e) { show(lostText(e, onLineAtPress)); show(lostText(e)); } }`,
  ];

  it("flags the online side, a value read after the request, and a test it can't read", () => {
    flagged.forEach((code, index) => {
      expect(wordingFindings([fake(`online${index}.tsx`, code)]).length, code).toBeGreaterThan(0);
    });
  });

  it("lets the offline side of a value captured at the press through, however it is written", () => {
    fine.forEach((code, index) => {
      expect(wordingFindings([fake(`offline${index}.tsx`, code)]), code).toEqual([]);
    });
  });
});

// Lead review (R28 NN2): a helper with a body is read through its returns;
// an exported fetch alias is followed into the files that import it.
describe("the guard itself: helpers and aliases across files", () => {
  it("reads what a block-bodied helper returns", () => {
    const code = `function lostText(kind: string) { if (kind === "a") return "Nothing changed."; return "Try again."; }
try { await go(); } catch { show(lostText("a")); }`;
    expect(wordingFindings([fake("helper.tsx", code)]).length).toBeGreaterThan(0);
  });

  it("follows an exported fetch alias into the file that imports it", () => {
    const alias = fake("alias.ts", `export const send = fetch;`);
    const user = fake("alias-user.ts", `import { send } from "./alias";\nsend("/x", { method: "POST" });`);
    expect(fetchFindings([alias]).map((finding) => finding.file)).toContain("__guard_fixture__/alias-user.ts");
    expect(fetchFindings([user])).toEqual([]);
  });
});

describe("requests that change data, and their no-answer wording", () => {
  it("covers the browser code (sanity)", () => {
    const names = clientFiles.map(rel);
    expect(names).toContain("components/team-section.tsx");
    expect(names).toContain("components/ui/dialog.tsx");
    expect(names).toContain("lib/queueActions.ts");
    expect(names.some((name) => name.startsWith("app/api/"))).toBe(false);
    expect(names.some((name) => name.startsWith("server/"))).toBe(false);
    expect(names).not.toContain("lib/fetchWithTimeout.ts"); // server code only
  });

  it("a request that changes data goes through fetchOrNoAnswer, never plain fetch", () => {
    expect(fetchFindings(clientFiles).map((finding) => `${finding.file}:${finding.line} ${finding.text}`)).toEqual([]);
  });

  it("a no-answer branch never says nothing changed", () => {
    expect(wordingFindings(clientFiles).map((finding) => `${finding.file}:${finding.line} ${finding.text}`)).toEqual([]);
  });

  it("each documented exception names a constant that exists, by name, not by count", () => {
    for (const entry of TRUE_WHATEVER_ARRIVED) {
      const source = readFileSync(path.join(SRC, entry.file), "utf8");
      expect(source, entry.constant).toMatch(new RegExp(`export const ${entry.constant}\\b`));
    }
  });
});
