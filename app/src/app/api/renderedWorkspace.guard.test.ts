import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R31 pages L2 (source cure): the active workspace lives in a cookie every tab
 * shares, so a write from a page drawn for workspace A, sent after another tab
 * switched to B, used to act on B (the Queue's post actions said "no longer
 * exists" and reloaded B's posts). Every signed-in write handler under
 * src/app/api now checks the page's workspace id with renderedWorkspaceRefusal
 * (lib/workspaceChanged.ts), in its own body or in a same-file function it
 * calls, unless it is a named exception below. A new write route that does
 * neither fails here.
 */

const API = __dirname;
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Routes that act on no page's workspace, by path under src/app/api (a
 * trailing "/" names a folder and everything under it). Each says why.
 */
export const WORKSPACE_CHECK_EXCEPTIONS: Record<string, string> = {
  "[...path]/route.ts": "the catch-all answers every method with the same 404",
  "admin/": "operator routes: they act on the workspace named in the URL, behind the operator gate",
  "auth/": "sign-in, registration, password and email changes act on the signed-in person's own account (or no one's yet)",
  "inngest/route.ts": "Inngest calls it, signed with its key",
  "webhooks/": "Stripe and Meta call them, signed with their secrets",
  "connect-link/[token]/": "the public /c page: its token names the workspace",
  "review-link/[token]/": "the public /v page: its token names the workspace",
  "upload-link/[token]/": "the public /u page: its token names the workspace",
  "invites/[token]/accept/route.ts": "the invite's token names the workspace the person joins",
  "me/time-zone/route.ts": "the signed-in person's own time zone",
  "workspaces/route.ts": "creates a new workspace for the signed-in person; no page's workspace is acted on",
  "workspaces/switch/route.ts": "the switch itself: it names the workspace to move the cookie to",
};

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** The file's top-level declarations: name -> its text (up to the next top-level line). */
function topLevelChunks(code: string): Map<string, string> {
  const chunks = new Map<string, string>();
  const starts = [...code.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+))/gm)];
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

/** The write methods a route file exports, and those that skip the check. */
export function uncheckedWriteHandlers(source: string): string[] {
  const code = stripComments(source);
  const chunks = topLevelChunks(code);
  const unchecked: string[] = [];
  for (const method of WRITE_METHODS) {
    const exported =
      new RegExp(`^export\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b`, "m").test(code) ||
      new RegExp(`\\bas\\s+${method}\\b`).test(code);
    if (!exported || isNotFoundAlias(code, method)) continue;
    if (!checksWorkspace(method, chunks)) unchecked.push(method);
  }
  return unchecked;
}

function exceptionFor(relative: string): string | undefined {
  return Object.entries(WORKSPACE_CHECK_EXCEPTIONS).find(([key]) =>
    key.endsWith("/") ? relative.startsWith(key) : relative === key,
  )?.[1];
}

describe("every signed-in write route checks the page's workspace id", () => {
  it("the scan sees a check in the handler or in a same-file function it calls, and ignores comments", () => {
    expect(uncheckedWriteHandlers("export async function POST(request: Request) {\n  return save();\n}\n")).toEqual(["POST"]);
    expect(
      uncheckedWriteHandlers(
        "export async function POST(request: Request) {\n  const refusal = renderedWorkspaceRefusal(body.workspaceId, id);\n}\n",
      ),
    ).toEqual([]);
    expect(
      uncheckedWriteHandlers(
        "function guard(sent: unknown) {\n  return renderedWorkspaceRefusal(sent, id);\n}\nexport async function DELETE(request: Request) {\n  const refusal = guard(x);\n}\n",
      ),
    ).toEqual([]);
    expect(
      uncheckedWriteHandlers("export async function PATCH(request: Request) {\n  // renderedWorkspaceRefusal(body.workspaceId, id)\n}\n"),
    ).toEqual(["PATCH"]);
    expect(uncheckedWriteHandlers("export const PUT = adminOtherMethods.PUT;\nexport async function GET() {}\n")).toEqual([]);
    expect(uncheckedWriteHandlers("const handler = NextAuth(options);\nexport { handler as GET, handler as POST };\n")).toEqual([
      "POST",
    ]);
  });

  it("holds for every route under src/app/api, except the named ones", () => {
    const files = routeFiles(API);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.flatMap((file) => {
      const relative = path.relative(API, file).split(path.sep).join("/");
      if (exceptionFor(relative)) return [];
      return uncheckedWriteHandlers(readFileSync(file, "utf8")).map((method) => `${method} ${relative}`);
    });
    expect(offenders).toEqual([]);
  });

  it("every exception names a route that exists", () => {
    const relatives = routeFiles(API).map((file) => path.relative(API, file).split(path.sep).join("/"));
    for (const key of Object.keys(WORKSPACE_CHECK_EXCEPTIONS)) {
      expect(relatives.some((relative) => (key.endsWith("/") ? relative.startsWith(key) : relative === key)), key).toBe(true);
    }
  });
});
