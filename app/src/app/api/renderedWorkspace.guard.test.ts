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
  // Lead review: named one by one, so a new route under admin/ or auth/ must be judged.
  ...Object.fromEntries(
    ["end-trial", "exempt", "limits", "pause", "resume", "trial"].map((action) => [
      `admin/workspaces/[id]/${action}/route.ts`,
      "an operator route: it acts on the workspace named in the URL, behind the operator gate",
    ]),
  ),
  "auth/[...nextauth]/route.ts": "next-auth's sign-in and sign-out: no workspace yet",
  "auth/register/route.ts": "makes a new account: no workspace yet",
  "auth/forgot-password/route.ts": "signed out: emails a reset link to an address",
  "auth/reset-password/route.ts": "signed out: its token names the account",
  "auth/verify-email/route.ts": "its token names the account whose address is confirmed",
  "auth/resend-verification/route.ts": "the signed-in person's own confirmation email",
  "auth/change-password/route.ts": "the signed-in person's own password",
  "auth/change-email/route.ts": "the signed-in person's own email address",
  "auth/change-email/confirm/route.ts": "its token names the account whose address changes",
  "auth/change-email/undo/route.ts": "its token names the account whose change is undone",
  "auth/account/route.ts": "deletes the signed-in person's own account",
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

/**
 * What a route file exports, by exported name: the same-file function or
 * constant that answers it, or null when it is re-exported from another file
 * (which can't be judged here). Covers `export async function POST`, `export
 * const POST`, `export { POST }`, `export { handler as PATCH }` and
 * `export { POST } from "./x"`.
 */
function exportedNames(code: string): Map<string, string | null> {
  const names = new Map<string, string | null>();
  for (const match of code.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)) names.set(match[1], match[1]);
  for (const match of code.matchAll(/\bexport\s*\{([^}]*)\}\s*(from\s*["'][^"']+["'])?/g)) {
    for (const part of match[1].split(",")) {
      const [local, exported = local] = part.trim().split(/\s+as\s+/).map((name) => name.trim());
      if (local) names.set(exported, match[2] ? null : local);
    }
  }
  return names;
}

/** The write methods a route file exports, and those that skip the check. */
export function uncheckedWriteHandlers(source: string): string[] {
  const code = stripComments(source);
  const chunks = topLevelChunks(code);
  const names = exportedNames(code);
  const unchecked: string[] = [];
  for (const method of WRITE_METHODS) {
    if (!names.has(method) || isNotFoundAlias(code, method)) continue;
    const local = names.get(method);
    if (local === null || local === undefined || !checksWorkspace(local, chunks)) unchecked.push(method);
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

  // Lead review: handlers declared without `export` and exported in a list, or re-exported from another file.
  it("sees handlers exported in a list, renamed, or re-exported from another file", () => {
    const unchecked = "async function POST(request: Request) {\n  return save();\n}\n";
    const checked = "async function POST(request: Request) {\n  const refusal = renderedWorkspaceRefusal(body.workspaceId, id);\n}\n";
    expect(uncheckedWriteHandlers(`${unchecked}export { POST };\n`)).toEqual(["POST"]);
    expect(uncheckedWriteHandlers(`${checked}export { POST };\n`)).toEqual([]);
    expect(uncheckedWriteHandlers(`${unchecked}export { POST as PATCH };\n`)).toEqual(["PATCH"]);
    expect(uncheckedWriteHandlers(`${checked}export { POST as PATCH, POST as DELETE };\n`)).toEqual([]);
    expect(uncheckedWriteHandlers(`${unchecked}export { POST as GET };\n`)).toEqual([]);
    // Another file's handler can't be judged here: it must be checked where it is written, or named.
    expect(uncheckedWriteHandlers('export { POST } from "./x";\n')).toEqual(["POST"]);
    expect(uncheckedWriteHandlers('export { handler as PUT } from "../shared";\n')).toEqual(["PUT"]);
  });

  it("names auth and admin routes one by one, so a new route there must be judged", () => {
    expect(Object.keys(WORKSPACE_CHECK_EXCEPTIONS).filter((key) => /^(auth|admin)\//.test(key) && key.endsWith("/"))).toEqual([]);
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
