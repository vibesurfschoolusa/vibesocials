import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * R35 pages L3: LoadError has no role of its own, so a load error that
 * replaces a status line is heard only from inside an announcing parent.
 * Every place that renders <LoadError puts it inside an open
 * <Alert variant="danger"> (or "warning"), which is role="alert".
 */

const SRC = join(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return name.endsWith(".tsx") && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Whether the code before `at` leaves an announcing Alert open. */
function insideAnnouncingAlert(source: string, at: number): boolean {
  const before = source.slice(0, at);
  const open = before.lastIndexOf("<Alert");
  if (open === -1 || open < before.lastIndexOf("</Alert>")) return false;
  const tag = source.slice(open, source.indexOf(">", open) + 1);
  return !tag.endsWith("/>") && /variant="(?:danger|warning)"/.test(tag);
}

describe("every LoadError is announced", () => {
  const sites = files(SRC)
    .filter((path) => !path.endsWith(join("components", "load-error.tsx")))
    .flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return [...source.matchAll(/<LoadError\b/g)].map((match) => ({
        file: relative(SRC, path),
        inside: insideAnnouncingAlert(source, match.index ?? 0),
      }));
    });

  it("finds the sites", () => {
    expect(sites.length).toBeGreaterThanOrEqual(7);
  });

  it("puts each inside a danger or warning Alert", () => {
    expect(sites.filter((site) => !site.inside).map((site) => site.file)).toEqual([]);
  });
});

/**
 * R41 pages L3: a load error written by hand (a plain <p> in the error branch
 * of a loading view) is missed by the check above. Every `: <name>Error ? (`
 * branch opens with an announcing Alert, or ErrorState, which is one.
 */
describe("every hand-written load-error branch is announced", () => {
  const ANNOUNCING = /^(?:<Alert\b[^>]*variant="(?:danger|warning)"|<ErrorState\b)/;
  const branches = files(SRC).flatMap((path) => {
    const source = readFileSync(path, "utf8");
    // Skips `//` comment lines between the branch and its first element.
    return [...source.matchAll(/:\s*[A-Za-z.]*[eE]rror \? \(\s*((?:\/\/[^\n]*\n\s*)*)(<[^\n]*)/g)].map((match) => ({
      file: relative(SRC, path),
      opens: match[2],
    }));
  });

  it("finds the branches", () => {
    expect(branches.length).toBeGreaterThanOrEqual(8);
  });

  it("opens each with a danger or warning Alert", () => {
    expect(branches.filter((branch) => !ANNOUNCING.test(branch.opens))).toEqual([]);
  });
});
