import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * R21 client-journey L2 follow-up: sendEmail's log lines name a send by a fixed
 * label, never its subject. Every sendEmail call in src must give one: an
 * explicit `label: "..."`, or an idempotency key that starts with a fixed label
 * ("client-upload/..."), which sendEmail falls back to. Otherwise its failures
 * would log "unlabelled". A source scan, so a new caller cannot forget.
 */

const SRC = fileURLToPath(new URL("../..", import.meta.url));
const LABEL = /^[a-z][a-z0-9-]{0,40}$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The text of each `sendEmail(...)` call in `source`, up to its matching paren. */
function calls(source: string): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = [];
  const pattern = /(?<![\w.])sendEmail\(/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const before = source.slice(Math.max(0, match.index - 16), match.index);
    if (/function\s+$/.test(before)) continue;
    // A mention in a comment ("transport is the fail-safe sendEmail()") is not a call.
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    if (/^\s*(\*|\/\/|\/\*)/.test(source.slice(lineStart, match.index))) continue;
    let depth = 0;
    let end = match.index + "sendEmail".length;
    for (; end < source.length; end += 1) {
      if (source[end] === "(") depth += 1;
      if (source[end] === ")" && (depth -= 1) === 0) break;
    }
    found.push({ line: source.slice(0, match.index).split("\n").length, text: source.slice(match.index, end + 1) });
  }
  return found;
}

// A key built elsewhere in the same file: the file's builders must start with a fixed label.
const BUILT_KEYS: Record<string, { key: string; builders: RegExp[] }> = {
  "server/notifications/postOutcomeEmail.ts": {
    key: "idempotencyKey: claimed.key",
    builders: [/return `post-outcome\//, /return `post-outcome-pair\//],
  },
};

const sites = sourceFiles(SRC)
  .map((path) => ({
    file: relative(SRC, path).split("\\").join("/"),
    source: readFileSync(path, "utf8").replace(/\r\n/g, "\n"),
  }))
  .filter(({ file }) => file !== "server/notifications/email.ts")
  .flatMap(({ file, source }) => calls(source).map((call) => ({ file, source, ...call })));

describe("every sendEmail call names its email by a fixed label", () => {
  it("finds the call sites", () => {
    expect(sites.length).toBeGreaterThanOrEqual(19);
  });

  it.each(sites.map((site) => [`${site.file}:${site.line}`, site] as const))("%s", (_where, site) => {
    const label = /\blabel:\s*"([^"]*)"/.exec(site.text)?.[1];
    if (label !== undefined) {
      expect(label).toMatch(LABEL);
      return;
    }
    const keyLabel = /\bidempotencyKey:\s*`([^/`$]*)\//.exec(site.text)?.[1];
    if (keyLabel !== undefined) {
      expect(keyLabel).toMatch(LABEL);
      return;
    }
    const built = BUILT_KEYS[site.file];
    expect(built, "pass label: \"...\" to sendEmail").toBeDefined();
    expect(site.text).toContain(built.key);
    for (const builder of built.builders) expect(site.source).toMatch(builder);
  });
});
