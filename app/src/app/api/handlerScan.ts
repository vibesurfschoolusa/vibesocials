import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The route-file scan behind the workspace guards (renderedWorkspace.guard.test.ts
 * for writes, renderedWorkspaceRead.guard.test.ts for reads): which handlers a
 * route.ts exports and whether each checks the page's workspace id with
 * renderedWorkspaceRefusal (lib/workspaceChanged.ts), in its own body or in a
 * same-file function it calls. One scan, so the two guards judge alike.
 */

/** Every route.ts under `dir`. */
export function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

/** `file`'s path under `root`, with forward slashes. */
export function relativeRoute(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** The file's top-level declarations: name -> its text (up to the next top-level line). */
function topLevelChunks(code: string): Map<string, string> {
  const chunks = new Map<string, string>();
  const starts = [...code.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+))/gm)];
  starts.forEach((match, index) => {
    const name = match[1] ?? match[2];
    const end = index + 1 < starts.length ? starts[index + 1].index : code.length;
    chunks.set(name, code.slice(match.index, end));
  });
  return chunks;
}

const CHECK = /\brenderedWorkspaceRefusal\s*\(/;

/** Whether `name`'s text checks the id, itself or through a same-file function it calls. */
function checksWorkspace(name: string, chunks: Map<string, string>, seen = new Set<string>()): boolean {
  const text = chunks.get(name);
  if (!text || seen.has(name)) return false;
  seen.add(name);
  if (CHECK.test(text)) return true;
  for (const other of chunks.keys()) {
    if (other !== name && new RegExp(`\\b${other}\\s*\\(`).test(text) && checksWorkspace(other, chunks, seen)) return true;
  }
  return false;
}

/** A handler re-exported from the admin helper answers 404 to that method; it acts on nothing. */
function isNotFoundAlias(code: string, method: string): boolean {
  return new RegExp(`^export\\s+const\\s+${method}\\s*=\\s*adminOtherMethods\\.${method}\\s*;`, "m").test(code);
}

/**
 * What a route file exports, by exported name: the same-file function or
 * constant that answers it, or null when it is re-exported from another file
 * (which can't be judged here). Covers `export async function POST`, `export
 * const POST`, `export { POST }`, `export { handler as PATCH }` and
 * `export { POST } from "./x"`, `export let` / `export var`, and (lead
 * review 2) next-auth v5's `export const { GET, POST } = handlers`: a
 * destructured handler comes from another object, so it is null too.
 */
function exportedNames(code: string): Map<string, string | null> {
  const names = new Map<string, string | null>();
  for (const match of code.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var)\s+(\w+)/gm)) names.set(match[1], match[1]);
  for (const match of code.matchAll(/^export\s+(?:const|let|var)\s*\{([\s\S]*?)\}\s*\}*\s*=/gm)) {
    // `{ handlers: { POST: PUT } }`: a key followed by `{` is a path, not a name.
    const pattern = match[1].replace(/\w+\s*:\s*\{/g, "");
    for (const part of pattern.split(/[,{}]/)) {
      const bound = part.split("=")[0].split(":").pop()?.trim();
      if (bound && /^\w+$/.test(bound)) names.set(bound, null);
    }
  }
  for (const match of code.matchAll(/\bexport\s*\{([^}]*)\}\s*(from\s*["'][^"']+["'])?/g)) {
    for (const part of match[1].split(",")) {
      const [local, exported = local] = part.trim().split(/\s+as\s+/).map((name) => name.trim());
      if (local) names.set(exported, match[2] ? null : local);
    }
  }
  return names;
}

/** Of `methods`, those a route file exports that skip the check. */
export function uncheckedHandlers(source: string, methods: readonly string[]): string[] {
  const code = stripComments(source);
  const chunks = topLevelChunks(code);
  const names = exportedNames(code);
  const unchecked: string[] = [];
  for (const method of methods) {
    if (!names.has(method) || isNotFoundAlias(code, method)) continue;
    const local = names.get(method);
    if (local === null || local === undefined || !checksWorkspace(local, chunks)) unchecked.push(method);
  }
  return unchecked;
}

/** The reason `exceptions` gives for `relative` (a trailing "/" names a folder), if any. */
export function exceptionFor(exceptions: Record<string, string>, relative: string): string | undefined {
  return Object.entries(exceptions).find(([key]) => (key.endsWith("/") ? relative.startsWith(key) : relative === key))?.[1];
}
