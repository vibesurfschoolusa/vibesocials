import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R20 new-customer L2: a 401 for "no session" used to answer
 * { error: "Unauthorized" }, which the account menu, Workspaces, the Team
 * section and Create showed word for word. Every route now answers with
 * signedOutResponse() (lib/signedOutResponse.ts); this keeps the bare word out
 * of every route under src/app/api, and out of the shared owner gate.
 */

const API = __dirname;
const WORKSPACE = path.join(__dirname, "..", "..", "lib", "workspace.ts");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** The string literal "Unauthorized" in code (comments stripped). */
function returnsBareUnauthorized(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  return /(["'`])Unauthorized\1/.test(code);
}

describe("no API route answers the bare word Unauthorized", () => {
  it("the scan sees a literal and ignores a comment", () => {
    expect(returnsBareUnauthorized('return NextResponse.json({ error: "Unauthorized" }, { status: 401 });')).toBe(true);
    expect(returnsBareUnauthorized("return new Response('Unauthorized', { status: 401 });")).toBe(true);
    expect(returnsBareUnauthorized('// was { error: "Unauthorized" }\nreturn signedOutResponse();')).toBe(false);
  });

  it("holds for every file under src/app/api and lib/workspace.ts", () => {
    const files = [...sourceFiles(API), WORKSPACE];
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) => returnsBareUnauthorized(readFileSync(file, "utf8"))).map((file) => path.relative(API, file));
    expect(offenders).toEqual([]);
  });
});
