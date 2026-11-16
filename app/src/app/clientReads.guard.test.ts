import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R32 publishing L1 / new-customer L3: the read routes under the page's-workspace
 * check (api/renderedWorkspaceRead.guard.test.ts) refuse a read without the
 * page's id, so every client read of them sends it. A read whose address is a
 * bare literal (no workspaceId in the call) fails here, unless named below.
 */

const SRC = path.join(__dirname, "..");

/** The guarded reads' paths (the Settings-only workspace routes have their own callers' checks). */
const GUARDED = /^\/api\/(posts|media|dashboard\/summary|insights\/|connections|reviews)/;

/** Calls that may read without the id this round, by file: each says why. */
const NAMED: Record<string, { path: string; why: string }[]> = {
  "components/create-post-form.tsx": [
    { path: "/api/media/", why: "Create's reuse-a-file read: outside RR2's brief, its route is pending (lead)" },
  ],
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "api" && entry !== "node_modules") out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Each fetch whose first argument starts with a literal address: the address and the call's next 400 characters. */
export function literalReads(source: string): { path: string; call: string }[] {
  const reads: { path: string; call: string }[] = [];
  for (const match of source.matchAll(/\b(?:fetch|fetchOrNoAnswer|fetchImpl)\(\s*["'`](\/api\/[^"'`?$]*)/g)) {
    reads.push({ path: match[1], call: source.slice(match.index, match.index + 400) });
  }
  return reads;
}

/** A read of a guarded route whose call never names the workspace id. */
export function readsWithoutId(source: string): string[] {
  return literalReads(source)
    .filter(({ path: address }) => GUARDED.test(address))
    .filter(({ call }) => {
      const first = call.slice(0, call.search(/\)\s*[;.,]|\)\s*\n/) + 1 || undefined);
      if (/method:\s*["'](POST|PUT|PATCH|DELETE)["']/.test(call.slice(0, 300))) return false;
      return !/workspaceId/.test(first);
    })
    .map(({ path: address }) => address);
}

describe("every client read of a guarded route sends the page's workspace id", () => {
  it("the scan sees a bare read, and passes one that names the id or a write", () => {
    expect(readsWithoutId('fetch("/api/posts?status=completed");')).toEqual(["/api/posts"]);
    expect(readsWithoutId('fetch(withWorkspaceId("/api/posts?status=completed", workspaceId));')).toEqual([]);
    expect(readsWithoutId("fetch(`/api/media?cursor=${c}&workspaceId=${encodeURIComponent(workspaceId)}`);")).toEqual([]);
    expect(readsWithoutId('fetchOrNoAnswer("/api/posts", { method: "POST", body });')).toEqual([]);
    expect(readsWithoutId('fetch("/api/workspaces/status");')).toEqual([]);
  });

  it("holds for every file under src outside the routes, except the named calls", () => {
    const offenders = sourceFiles(SRC).flatMap((file) => {
      const relative = path.relative(SRC, file).split(path.sep).join("/");
      const named = NAMED[relative] ?? [];
      return readsWithoutId(readFileSync(file, "utf8"))
        .filter((address) => !named.some((entry) => address.startsWith(entry.path)))
        .map((address) => `${relative}: ${address}`);
    });
    expect(offenders).toEqual([]);
  });
});
