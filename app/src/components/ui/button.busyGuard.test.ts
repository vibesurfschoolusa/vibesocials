import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * R26 pages L1 (= new-customer L5): a Button that passes its busy flag in
 * `disabled` as well as `loading` becomes a real disabled button while busy,
 * and the browser drops keyboard focus to the page body. Button already
 * ignores presses while loading (button.tsx), so the busy flag belongs in
 * `loading` only. This reads every .tsx file under src, so a new caller can't
 * bring it back.
 */
const SRC = fileURLToPath(new URL("../..", import.meta.url));

// LL2/LL3: remove after rebase. Those briefs fix these call sites in parallel
// (google-business-location-form's dropdown too, which is a select, not a
// Button, so this guard never listed it).
const ALLOWED = new Set<string>([
  "app/posts/bulk/bulk-posts-form.tsx loading={sendingMode === \"schedule\"}", // LL2/LL3: remove after rebase
  "app/posts/bulk/bulk-posts-form.tsx loading={sendingMode === \"draft\"}", // LL2/LL3: remove after rebase
  "components/composer/attached-photos.tsx loading={writing}", // LL2/LL3: remove after rebase
  "components/composer/platform-caption-editor.tsx loading={adapting === platform}", // LL2/LL3: remove after rebase
  "components/create-post-form.tsx loading={autoCaptionLoading}", // LL2/LL3: remove after rebase
  "components/create-post-form.tsx loading={enhancingCaption}", // LL2/LL3: remove after rebase
]);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

/** The text of `name={...}` in an opening tag, braces balanced; null if absent. */
function propExpression(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}=\\{`).exec(tag);
  if (!match) return null;
  let depth = 1;
  let at = match.index + match[0].length;
  const start = at;
  while (at < tag.length && depth > 0) {
    if (tag[at] === "{") depth += 1;
    if (tag[at] === "}") depth -= 1;
    at += 1;
  }
  return tag.slice(start, at - 1);
}

/** `<Button ...>` opening tags, `>` inside braces skipped. */
export function buttonOpeningTags(source: string): string[] {
  const tags: string[] = [];
  const re = /<Button\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    let depth = 0;
    let at = match.index;
    for (; at < source.length; at += 1) {
      const char = source[at];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (char === ">" && depth === 0 && source[at - 1] !== "=") break;
    }
    tags.push(source.slice(match.index, at + 1));
  }
  return tags;
}

const NOT_FLAGS = new Set(["null", "undefined", "true", "false"]);

function flagsIn(expression: string): Set<string> {
  const withoutStrings = expression.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "");
  return new Set(
    (withoutStrings.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) ?? []).filter((name) => !NOT_FLAGS.has(name)),
  );
}

/** The busy flags a Button passes in both `loading` and `disabled`. */
export function sharedBusyFlags(tag: string): string[] {
  const loading = propExpression(tag, "loading");
  const disabled = propExpression(tag, "disabled");
  if (loading === null || disabled === null) return [];
  const inDisabled = flagsIn(disabled);
  return [...flagsIn(loading)].filter((flag) => inDisabled.has(flag));
}

function offences(): string[] {
  return tsxFiles(SRC).flatMap((path) => {
    const file = relative(SRC, path).split(sep).join("/");
    return buttonOpeningTags(readFileSync(path, "utf8"))
      .filter((tag) => sharedBusyFlags(tag).length > 0)
      .map((tag) => `${file} loading={${propExpression(tag, "loading")}}`);
  });
}

describe("Button busy guard", () => {
  it("finds a busy flag passed in both loading and disabled", () => {
    const [tag] = buttonOpeningTags(
      `<Button loading={busy === "a"} disabled={busy !== null || !ready} onClick={() => go()}>Go</Button>`,
    );
    expect(sharedBusyFlags(tag)).toEqual(["busy"]);
    expect(sharedBusyFlags(`<Button loading={state.saving} disabled={state.saving}>`)).toEqual(["state.saving"]);
  });

  it("allows a disabled that doesn't come from the busy flag", () => {
    expect(sharedBusyFlags(`<Button loading={busy === "a"} disabled={!ready}>`)).toEqual([]);
    expect(sharedBusyFlags(`<Button loading={busy} aria-disabled={busy || undefined}>`)).toEqual([]);
    expect(sharedBusyFlags(`<Button disabled={busy}>`)).toEqual([]);
  });

  it("no Button in src passes its busy flag in disabled", () => {
    expect(offences().filter((offence) => !ALLOWED.has(offence))).toEqual([]);
  });

  it("every allowed site still offends, so the list empties as they are fixed", () => {
    const found = new Set(offences());
    expect([...ALLOWED].filter((offence) => !found.has(offence))).toEqual([]);
  });
});
