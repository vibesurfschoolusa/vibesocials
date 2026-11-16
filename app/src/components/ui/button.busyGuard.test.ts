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

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `disabled` with the terms that are false whenever `loading` is true taken
 * out: for `loading={flag}`, `!flag`; for `loading={flag === value}`,
 * `flag !== value` and `flag === <another literal>`, and any parenthesised
 * `&&` group holding one of those. What is left can't stop this button while
 * it loads; another button's action can still disable it (LL3's pattern).
 */
function disabledWhileLoading(flag: string, value: string | null, disabled: string): string {
  const name = escape(flag);
  const falseTerms = value
    ? [
        new RegExp(`${name}\\s*!==\\s*${escape(value)}(?![\\w$])`, "g"),
        ...(/^["']/.test(value)
          ? [new RegExp(`${name}\\s*===\\s*(?!${escape(value)})("[^"]*"|'[^']*')`, "g")]
          : []),
      ]
    : [new RegExp(`!${name}(?![\\w$.])`, "g")];
  const isFalse = (text: string) => falseTerms.some((term) => new RegExp(term.source).test(text));
  let left = disabled.replace(/\([^()]*\)/g, (group) => (group.includes("&&") && isFalse(group) ? "" : group));
  for (const term of falseTerms) left = left.replace(term, "");
  return left;
}

/** The busy flags a Button passes in both `loading` and `disabled` (true while loading). */
export function sharedBusyFlags(tag: string): string[] {
  const loading = propExpression(tag, "loading");
  const disabled = propExpression(tag, "disabled");
  if (loading === null || disabled === null) return [];
  const compared = /^\s*([A-Za-z_$][\w$.]*)\s*===\s*(.+?)\s*$/.exec(loading);
  const plain = /^\s*([A-Za-z_$][\w$.]*)\s*$/.exec(loading);
  if (!compared && !plain) {
    const inDisabled = flagsIn(disabled);
    return [...flagsIn(loading)].filter((flag) => inDisabled.has(flag));
  }
  const flag = (compared ?? plain)![1];
  const left = disabledWhileLoading(flag, compared ? compared[2] : null, disabled);
  return flagsIn(left).has(flag) ? [flag] : [];
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

  // After the rebase: LL3 disables a button only while ANOTHER action runs,
  // which is false whenever this one is loading, so it keeps focus.
  it("allows a disabled that is false whenever this button is loading", () => {
    expect(
      sharedBusyFlags(`<Button disabled={busy || mode === "draft" || none} loading={mode === "schedule"}>`),
    ).toEqual([]);
    expect(
      sharedBusyFlags(`<Button loading={adapting === platform} disabled={disabled || (adapting !== null && adapting !== platform)}>`),
    ).toEqual([]);
    expect(sharedBusyFlags(`<Button loading={saving} disabled={!saving && !ready}>`)).toEqual([]);
  });

  it("still finds one that is true while loading", () => {
    expect(sharedBusyFlags(`<Button loading={mode === "schedule"} disabled={mode !== null}>`)).toEqual(["mode"]);
    expect(sharedBusyFlags(`<Button loading={mode === "schedule"} disabled={mode === "schedule"}>`)).toEqual(["mode"]);
    expect(
      sharedBusyFlags(`<Button loading={adapting === platform} disabled={adapting !== null || adapting !== platform}>`),
    ).toEqual(["adapting"]);
  });

  it("no Button in src passes its busy flag in disabled", () => {
    expect(offences()).toEqual([]);
  });
});
