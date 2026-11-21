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
 *
 * 3. Positive (lead review 3): a no-answer branch of a data change shows only
 *    the shared answerLost text, the offline-at-the-press "nothing was sent",
 *    or a named exception in TRUE_WHATEVER_ARRIVED that says why. Reads (GET)
 *    are left out. Rule 2 stays as a second check.
 *
 * Known limits (rule 3; rules 1 and 2 still apply everywhere):
 * - A catch that rethrows is not followed: the branch is that catch, not the
 *   one its rethrow reaches.
 * - An outcome reshaped and worded by a caller (a helper that returns
 *   { kind: "network" } or { lost: true } for another function to word) gets
 *   only the banned-phrase check, as does an outcome compared in a function
 *   other than the one that made the request.
 * - A request made through a passed-in fetch function (a parameter or a
 *   field holding fetch) gets only the banned-phrase check.
 * - Re-exports and `export default` of a fetch alias are not followed.
 */

const SRC = __dirname;

/**
 * Sentences that are true whatever reached the server, named one by one (a
 * constant, or an inline text by its start), each with why. Nothing else may
 * stand in a no-answer branch of a data change but the shared answerLost text
 * and the offline-at-the-press "nothing was sent".
 */
const AI_WRITE =
  "An AI write: on a lost answer the AI ran and used the allowance, but nothing is saved (the box changes only from an answer). The sentence says the answer isn't shown and nothing was saved.";
const UPLOAD_STEP =
  "The file-storage step: nothing is in the library or on a post until a later request saves it, and that one has its own lost-answer text.";
/** `usedIn`: only where that file names the constant (R32), not on every data change. */
const TRUE_WHATEVER_ARRIVED: Array<{ file: string; constant?: string; text?: string; usedIn?: string; why: string }> = [
  { file: "lib/captionRequest.ts", constant: "CAPTION_OFFLINE_MESSAGE", why: AI_WRITE },
  { file: "lib/captionRequest.ts", constant: "CAPTION_FAILED_MESSAGE", why: AI_WRITE },
  { file: "app/reviews/reviews-view.tsx", constant: "DRAFT_OFFLINE_MESSAGE", why: AI_WRITE },
  { file: "components/composer/attached-photos.tsx", constant: "PHOTO_DESCRIPTION_OFFLINE_MESSAGE", why: AI_WRITE },
  { file: "app/posts/bulk/bulkExtras.ts", constant: "BULK_IMPROVE_FAILED_TEXT", why: AI_WRITE },
  { file: "app/posts/bulk/bulkExtras.ts", constant: "BULK_IMPROVE_LOST_TEXT", why: AI_WRITE },
  { file: "app/posts/bulk/bulkExtras.ts", constant: "BULK_CAPTION_LOST_TEXT", why: AI_WRITE },
  { file: "components/composer/platform-caption-editor.tsx", constant: "adaptLostText", why: AI_WRITE },
  { file: "app/posts/bulk/bulk-post-row.tsx", text: "No caption was written", why: AI_WRITE },
  { file: "components/composer/platform-caption-editor.tsx", text: "Couldn't adapt the caption for", why: AI_WRITE },
  { file: "lib/uploadFailure.ts", constant: "UPLOAD_OFFLINE_MESSAGE", why: UPLOAD_STEP },
  { file: "lib/uploadFailure.ts", constant: "UPLOAD_REFUSED_MESSAGE", why: UPLOAD_STEP },
  { file: "lib/uploadFailure.ts", constant: "UPLOAD_STORAGE_UNREACHABLE_MESSAGE", why: UPLOAD_STEP },
  { file: "components/media-library.tsx", constant: "uploadNetwork", why: UPLOAD_STEP },
  // R32 (lead review: scoped to the upload path): explainUploadFailure's question is
  // refused for a page drawn for another workspace (or one that sent no id).
  {
    file: "lib/workspaceChanged.ts",
    constant: "readWorkspaceRefusalText",
    usedIn: "lib/uploadFailure.ts",
    why: `${UPLOAD_STEP} The page is for another workspace (or from before the id was sent), so its upload token is refused too; the shared sentence says to reload and try again, not that nothing happened.`,
  },
  { file: "app/posts/bulk/bulkExtras.ts", constant: "BULK_COVER_FAILED_TEXT", why: UPLOAD_STEP },
  { file: "app/posts/bulk/bulk-posts-form.tsx", text: "The upload failed. Retry it or remove it.", why: UPLOAD_STEP },
  { file: "app/u/[token]/send-file.ts", constant: "UPLOAD_FAILED_MESSAGE", why: `${UPLOAD_STEP} On /u the token and storage steps register nothing; the last step says the file may have arrived.` },
  // R53 pages-a L1-L3: the same steps, when our server or file storage answered and refused.
  { file: "app/u/[token]/send-file.ts", constant: "UPLOAD_FAILED_OUR_SIDE_MESSAGE", why: `${UPLOAD_STEP} On /u the token and storage steps register nothing; the last step says the file may have arrived.` },
  { file: "lib/uploadFailure.ts", constant: "UPLOAD_STORAGE_REFUSED_MESSAGE", why: UPLOAD_STEP },
  { file: "lib/uploadFailure.ts", constant: "UPLOAD_STORAGE_TOO_LARGE_MESSAGE", why: UPLOAD_STEP },
  {
    file: "components/create-post-form.tsx",
    text: "Failed to prepare media for posting.",
    why: `${UPLOAD_STEP} Create uploads the picked file for the caption step; the post is made only by Publish.`,
  },
  // R62 fix review L1: only the named helper, which only the SingleUploadAbortedError
  // branch of the submit catch calls; any other "nothing was posted" is still flagged.
  {
    file: "components/create-post-form.tsx",
    constant: "singleUploadStoppedText",
    usedIn: "components/create-post-form.tsx",
    why: "The upload was stopped in the browser before the post request was sent, so nothing reached the server.",
  },
  {
    file: "components/plan-actions.tsx",
    text: "Vibe Socials didn't answer, so nothing was charged.",
    why: "Starting Stripe Checkout or the portal makes a session and charges nothing; the plan changes only from Stripe's webhook.",
  },
  { file: "lib/signedOutMessage.ts", constant: "SIGNED_OUT_ERROR", why: "An answer arrived (401): the session had ended, so nothing was done." },
  {
    file: "components/ui/dialog.tsx",
    constant: "CONFIRM_FAILED_MESSAGE",
    why: "An unexpected failure, not a lost answer (those are worded where they are caught); it already says to reload to see whether it went through.",
  },
];

function isTrueWhateverArrived(file: string, name: string, usedAt?: string): boolean {
  return TRUE_WHATEVER_ARRIVED.some(
    (entry) =>
      entry.file === rel(file) &&
      entry.constant !== undefined &&
      entry.constant === name &&
      (entry.usedIn === undefined || (usedAt !== undefined && rel(usedAt) === entry.usedIn)),
  );
}

function isUploadOrSignIn(name: string, sf: ts.SourceFile): boolean {
  const from = (module: string) =>
    sf.statements.some((statement) => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === module);
  // Signing in or out sets or clears the session: a data change whose answer can be lost.
  if (/^sign(In|Out)(Fn)?$/.test(name)) return from("next-auth/react");
  return UPLOAD_HELPERS.has(name) && from("@vercel/blob/client");
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
        if (isTrueWhateverArrived(value.getSourceFile().fileName, node.text, sf.fileName)) continue;
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
    const isTest =
      (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "isNoAnswer") ||
      // `error instanceof PostConnectionLostError`: a class named for a lost answer.
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
        ts.isIdentifier(node.right) &&
        NO_ANSWER_NAME.test(node.right.text));
    if (isTest) {
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

/*
 * Lead review 3 (R28 NN2): the positive rule. A no-answer branch of a request
 * that changes data shows only the shared answerLost text, the offline-at-the-
 * press "nothing was sent", or a named exception above. The branches are the
 * catch (or `.catch`) around a mutation, followed out of any function that
 * lets the no-answer error through to the try of its callers; outcome
 * comparisons (`=== "no_answer"`, `"network"`) in a file that makes such a
 * request; every `unreachableText`; and confirmFailureText's second argument.
 */

/** Blob uploads store a file: a data change, like a POST. */
const UPLOAD_HELPERS = new Set(["upload", "put"]);

/** A call that changes data: fetchOrNoAnswer, sendActionRequest or a fetch-named field with a changing init, or a blob upload. */
function isMutationCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
  if (name === "fetchOrNoAnswer" || name === "sendActionRequest" || (name === "fetch" && ts.isPropertyAccessExpression(callee))) {
    return !readOnlyInit(call.arguments[1]);
  }
  return isUploadOrSignIn(name, call.getSourceFile());
}

/** The name a function is called by: its own, or the variable it (or a useCallback around it) is stored in. */
function functionName(fn: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  let holder: ts.Node = fn.parent;
  if (ts.isCallExpression(holder) && ts.isIdentifier(holder.expression) && holder.expression.text === "useCallback") holder = holder.parent;
  return ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) ? holder.name.text : null;
}

/** The no-answer branches of every data-changing request in the files. */
function mutationBranches(files: string[]): ts.Node[] {
  const branches = new Set<ts.Node>();
  const seen = new Set<ts.Node>();
  const queue: ts.CallExpression[] = [];
  // Functions that make (or pass on) a data-changing request: their outcome comparisons are branches.
  const mutating = new Set<ts.Node>();
  const enclosingFunction = (node: ts.Node): ts.Node => {
    let at: ts.Node = node;
    while (at.parent && !ts.isFunctionLike(at) && !ts.isSourceFile(at)) at = at.parent;
    return at;
  };
  for (const file of files) {
    const sf = parse(file);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && isMutationCall(node)) queue.push(node);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  while (queue.length > 0) {
    const point = queue.pop() as ts.CallExpression;
    if (seen.has(point)) continue;
    seen.add(point);
    mutating.add(enclosingFunction(point.parent));
    // sendActionRequest answers { kind: "no_answer" } rather than throwing: its branches are those comparisons.
    if (ts.isIdentifier(point.expression) && point.expression.text === "sendActionRequest") continue;
    let handled = false;
    let node: ts.Node = point;
    while (node.parent && !ts.isFunctionLike(node.parent) && !ts.isSourceFile(node.parent)) {
      const parent: ts.Node = node.parent;
      if (ts.isTryStatement(parent) && parent.tryBlock === node && parent.catchClause) {
        branches.add(parent.catchClause.block);
        handled = true;
        break;
      }
      if (ts.isPropertyAccessExpression(parent) && parent.name.text === "catch" && ts.isCallExpression(parent.parent)) {
        for (const argument of parent.parent.arguments) branches.add(argument);
        handled = true;
        break;
      }
      node = parent;
    }
    if (handled) continue;
    // The no-answer error leaves the function: its callers' catches are the branches.
    const fn = node.parent;
    if (!fn || !ts.isFunctionLike(fn)) continue;
    const name = functionName(fn);
    // An unnamed callback handed to a call (`beforeSignIn(() => signIn(...))`): that call runs it.
    if (!name) {
      if (ts.isCallExpression(fn.parent) && fn.parent.arguments.includes(fn as ts.Expression)) queue.push(fn.parent);
      continue;
    }
    const sf = fn.getSourceFile();
    for (const use of [...usesIn(sf, name), ...importedUses(sf.fileName, name)]) {
      if (ts.isCallExpression(use.parent) && use.parent.expression === use) queue.push(use.parent);
    }
  }
  for (const fn of mutating) {
    const visit = (node: ts.Node) => {
      if (node !== fn && ts.isFunctionLike(node)) return;
      if ((ts.isIfStatement(node) || ts.isConditionalExpression(node)) && comparesWithNoAnswerName(testOf(node))) {
        branches.add(ts.isIfStatement(node) ? node.thenStatement : node.whenTrue);
      }
      ts.forEachChild(node, visit);
    };
    visit(fn);
  }
  for (const file of files) {
    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node) && nameText(node.name) === "unreachableText" && node.initializer) branches.add(node.initializer);
      if ((ts.isPropertyAssignment(node) || ts.isParameter(node)) && nameText(node.name) === "unreachableText" && node.initializer) branches.add(node.initializer);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "confirmFailureText" && node.arguments[1]) {
        branches.add(node.arguments[1]);
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file));
  }
  return [...branches];
}

/**
 * What a helper returns for a lost answer: once it tests for one at the top
 * (`if (isNoAnswer(error)) return ...`), only that return; the returns after
 * it are for other failures.
 */
function lostReturnsOf(body: ts.Block): ts.Expression[] {
  const out: ts.Expression[] = [];
  for (const statement of body.statements) {
    if (ts.isIfStatement(statement) && containsNoAnswerTest(statement.expression) === "yes") {
      const then = statement.thenStatement;
      if (ts.isReturnStatement(then) && then.expression) out.push(then.expression);
      else if (ts.isBlock(then)) out.push(...returnsOf(then));
      return out;
    }
    if (ts.isReturnStatement(statement)) {
      if (statement.expression) out.push(statement.expression);
      return out;
    }
    const visit = (node: ts.Node) => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
      ts.forEachChild(node, visit);
    };
    visit(statement);
  }
  return out;
}

/** A string a person reads: words, ending as a sentence. */
function isSentence(text: string): boolean {
  const trimmed = text.trim().replace(/^`|`$/g, "");
  return /\s/.test(trimmed) && /[A-Za-z]{3}/.test(trimmed) && /[.!?]["'’)]?$/.test(trimmed);
}

function isExceptedText(file: string, text: string): boolean {
  return TRUE_WHATEVER_ARRIVED.some((entry) => entry.file === rel(file) && entry.text !== undefined && text.trim().replace(/^`|`$/g, "").startsWith(entry.text));
}

/** Sentences in a branch that aren't the shared text, the offline side or a named exception. */
function unsharedSentences(node: ts.Node, seen: Set<ts.Node>, out: Finding[]): void {
  if (seen.has(node)) return;
  seen.add(node);
  const sf = node.getSourceFile();
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    if (name === "answerLostText") return; // the shared text
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "console") return;
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "ConfirmFailureShown") return;
  if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
    const [whenTrue, whenFalse] = ts.isIfStatement(node) ? [node.thenStatement, node.elseStatement] : [node.whenTrue, node.whenFalse];
    const offline = offlineSide(testOf(node));
    if (offline !== null) {
      const online = offline === "true" ? whenFalse : whenTrue;
      if (online) unsharedSentences(online, seen, out);
      return;
    }
    const test = containsNoAnswerTest(testOf(node));
    if (test === "yes") return unsharedSentences(whenTrue, seen, out);
    if (test === "negated") {
      if (whenFalse) unsharedSentences(whenFalse, seen, out);
      return;
    }
  }
  const report = (text: string) => {
    if (isSentence(text) && !isExceptedText(sf.fileName, text)) {
      out.push({ file: rel(sf.fileName), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
    }
  };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) report(node.text);
  if (ts.isTemplateExpression(node)) report(node.getText());
  if (ts.isIdentifier(node)) {
    const parent = node.parent;
    const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node);
    if (!isPropertyName) {
      for (let value of resolveName(node)) {
        if (isTrueWhateverArrived(value.getSourceFile().fileName, node.text, sf.fileName)) continue;
        // `useCallback(async () => ..., deps)`: the function inside.
        if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "useCallback" && value.arguments[0]) {
          value = value.arguments[0];
        }
        const body = ts.isBlock(value) ? value : (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) && ts.isBlock(value.body) ? value.body : null;
        if (body) {
          for (const returned of lostReturnsOf(body)) unsharedSentences(returned, seen, out);
          continue;
        }
        while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node && ts.isObjectLiteralExpression(value)) {
          const field = value.properties.find((property) => nameText(property.name) === parent.name.text);
          if (field && ts.isPropertyAssignment(field)) {
            if (!isTrueWhateverArrived(value.getSourceFile().fileName, parent.name.text)) unsharedSentences(field.initializer, seen, out);
          } else if (!field) unsharedSentences(value, seen, out);
          continue;
        }
        unsharedSentences(value, seen, out);
      }
    }
  }
  ts.forEachChild(node, (child) => unsharedSentences(child, seen, out));
}

function positiveFindings(files: string[]): Finding[] {
  const found: Finding[] = [];
  const seen = new Set<ts.Node>();
  for (const branch of mutationBranches(files)) unsharedSentences(branch, seen, found);
  return [...new Map(found.map((finding) => [`${finding.file}:${finding.line}:${finding.text}`, finding])).values()];
}

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

// Lead review 3 (R28 NN2): the positive rule, on fixtures.
describe("the guard itself: only the shared text on a data change's no-answer branch", () => {
  const flagged = [
    `try { await fetchOrNoAnswer("/x", { method: "POST" }); } catch { toast.error("Couldn't reach Vibe Socials. Check your connection and try again."); }`,
    `async function save() { await fetchOrNoAnswer("/x", { method: "DELETE" }); }
async function press() { try { await save(); } catch { setError("Couldn't reach Vibe Socials. Check your connection and try again."); } }`,
    `const LOST = "Couldn't reach the server. Try again."; try { await fetchOrNoAnswer("/x", { method: "PATCH", body }); } catch (e) { show(isNoAnswer(e) ? LOST : "Other."); }`,
    `async function press() { const answer = await sendActionRequest("/x", { method: "POST" }); if (answer.kind === "no_answer") toast.error("Couldn't save. Try again."); }`,
  ];
  const fine = [
    `try { await fetchOrNoAnswer("/x", { method: "POST" }); } catch { toast.error(answerLostText("it may have been saved", "Reload to see.")); }`,
    `const LOST = answerLostText("it may have gone through", "Reload the page."); try { await fetchOrNoAnswer("/x", { method: "POST" }); } catch { toast.error(LOST); }`,
    `async function press() { const online = navigator.onLine; try { await fetchOrNoAnswer("/x", { method: "POST" }); } catch { if (!online) toast.error("You're offline, so nothing was sent."); } }`,
    // A read changes nothing: its wording is its own.
    `try { await fetchOrNoAnswer("/x"); } catch { toast.error("Couldn't load your media. Check your connection, then press Retry."); }`,
    // Not a lost answer: the other branch of the test.
    `try { await fetchOrNoAnswer("/x", { method: "POST" }); } catch (e) { show(isNoAnswer(e) ? answerLostText("it may have gone", "Reload.") : "Something else went wrong. Try again."); }`,
  ];

  it("fails a custom sentence on a mutation's no-answer branch, through a helper, a constant or an outcome", () => {
    flagged.forEach((code, index) => {
      expect(positiveFindings([fake(`custom${index}.tsx`, code)]).length, code).toBeGreaterThan(0);
    });
  });

  it("passes the shared text, the offline side, a read, and the other branch", () => {
    fine.forEach((code, index) => {
      expect(positiveFindings([fake(`shared${index}.tsx`, code)]), code).toEqual([]);
    });
  });

  it("passes a named exception, and only in its own file", () => {
    const named = fake("components/plan-actions.tsx", `try { await fetchOrNoAnswer("/x", { method: "POST" }); } catch { show("Vibe Socials didn't answer, so nothing was charged."); }`);
    expect(positiveFindings([named]).length).toBeGreaterThan(0); // a fixture path is not the real file
    expect(isExceptedText(path.join(SRC, "components/plan-actions.tsx"), "Vibe Socials didn't answer, so nothing was charged.")).toBe(true);
    expect(isExceptedText(path.join(SRC, "components/settings-form.tsx"), "Vibe Socials didn't answer, so nothing was charged.")).toBe(false);
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

  it("a no-answer branch of a data change shows only the shared text, the offline side or a named exception", () => {
    expect(positiveFindings(clientFiles).map((finding) => `${finding.file}:${finding.line} ${finding.text}`)).toEqual([]);
  });

  // R32 lead review: the shared reload sentences are allowed on the upload's no-answer path only.
  it("the workspace refusal is named for the upload's question only", () => {
    const workspaceEntries = TRUE_WHATEVER_ARRIVED.filter((entry) => entry.file === "lib/workspaceChanged.ts");
    expect(workspaceEntries.map((entry) => [entry.constant, entry.usedIn])).toEqual([["readWorkspaceRefusalText", "lib/uploadFailure.ts"]]);
    const elsewhere = fake(
      "elsewhere.tsx",
      `import { readWorkspaceRefusalText } from "@/lib/workspaceChanged";
async function press() { try { await fetchOrNoAnswer("/x", { method: "POST" }); } catch { const r = await fetch("/y"); toast.error(await readWorkspaceRefusalText(r)); } }`,
    );
    expect(positiveFindings([elsewhere]).length).toBeGreaterThan(0);
  });

  it("each documented exception names a constant or text that exists, and says why", () => {
    for (const entry of TRUE_WHATEVER_ARRIVED) {
      const source = readFileSync(path.join(SRC, entry.file), "utf8");
      if (entry.usedIn) expect(readFileSync(path.join(SRC, entry.usedIn), "utf8"), entry.usedIn).toContain(entry.constant);
      if (entry.constant) expect(source, entry.constant).toMatch(new RegExp(`(const |\\b)${entry.constant}\\b\\s*[:=]|function ${entry.constant}\\(`));
      if (entry.text) expect(source, entry.text).toContain(entry.text);
      expect(entry.why.length, entry.file).toBeGreaterThan(20);
    }
  });
});
