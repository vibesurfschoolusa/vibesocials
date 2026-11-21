import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R57 pages-b L1-L3 (#282's rule): a button repeated on every item of a list
 * says which item it acts on, so a screen reader's list of buttons doesn't
 * read "Delete, Delete, Delete". #282 named only the places its brief listed,
 * and the same fault came back elsewhere.
 *
 * This scan finds every <Button>, <ButtonLink>, <Link>, <ExternalLink>,
 * <button> and <a> written inside a `.map(` callback in src/app and
 * src/components whose text is static (fixed words, even inside a wrapping
 * element or a ternary of two string literals) and that has no aria-label or
 * aria-labelledby. Give it an aria-label that
 * starts with the visible text and names the item, as the Queue's cards do.
 *
 * It is a text scan, not a compiler. It cannot see a button in a component
 * that a `.map(` renders from another file (e.g. one card per post); those
 * were named by hand in the R57 sweep and are covered by their own tests.
 */

const SRC = path.join(__dirname, "..");
const ROOTS = ["app", "components"].map((dir) => path.join(SRC, dir));

/**
 * `relative/path.tsx: visible text` of a button whose text is already unique
 * per item (so needs no aria-label). Each entry says why; add one only for
 * such a control.
 */
const EXEMPT: ReadonlySet<string> = new Set<string>([
  // Only inside the LinkedIn row's Reconnect steps, so the page shows it once.
  "app/c/[token]/page.tsx: Open LinkedIn sign-out",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".tsx") && !/\.test\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

/** Index of the bracket closing the one at `open`, counting only `open`'s kind; -1 when none. */
function closingIndex(source: string, open: number): number {
  const opener = source[open];
  const closer = opener === "(" ? ")" : "}";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === opener) depth++;
    else if (source[i] === closer && --depth === 0) return i;
  }
  return -1;
}

/** End of a JSX opening tag that starts at `start` (its `>`), skipping `{…}` attribute values and quotes. */
function openingTagEnd(source: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "{") {
      const close = closingIndex(source, i);
      if (close < 0) return -1;
      i = close;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

export type UnnamedButton = { index: number; text: string };

const STRING_ONLY = /^\s*(?:"([^"]*)"|'([^']*)')\s*$/;
// `cond ? "A" : "B"`: both words are fixed, so the text is as static as one.
const FIXED_TERNARY = /^[^?]+\?\s*(?:"([^"]*)"|'([^']*)')\s*:\s*(?:"[^"]*"|'[^']*')\s*$/;

/**
 * The words a control's children always show, or null when any part of them
 * comes from data. Tags are dropped (icons, a wrapping <span>); a `{…}` may be
 * a comment, a string literal or a ternary of two string literals.
 */
export function staticText(children: string): string | null {
  let text = "";
  for (let i = 0; i < children.length; i++) {
    const ch = children[i];
    if (ch === "<") {
      const end = openingTagEnd(children, i);
      if (end < 0) return null;
      i = end;
      text += " ";
    } else if (ch === "{") {
      const close = closingIndex(children, i);
      if (close < 0) return null;
      const expression = children.slice(i + 1, close);
      i = close;
      if (/^\s*\/\*[\s\S]*\*\/\s*$/.test(expression)) continue;
      const literal = STRING_ONLY.exec(expression) ?? FIXED_TERNARY.exec(expression);
      if (!literal) return null;
      text += literal[1] ?? literal[2];
    } else {
      text += ch;
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

/** Buttons and links inside a `.map(` callback with static text and no accessible name of their own. */
export function unnamedRepeatedButtons(source: string): UnnamedButton[] {
  const found = new Map<number, UnnamedButton>();
  for (const map of source.matchAll(/\.map\(/g)) {
    const open = (map.index as number) + map[0].length - 1;
    const close = closingIndex(source, open);
    if (close < 0) continue;
    const body = source.slice(open, close);
    for (const button of body.matchAll(/<(Button|ButtonLink|Link|ExternalLink|button|a)(?=[\s>])/g)) {
      const start = open + (button.index as number);
      if (found.has(start)) continue;
      const tagEnd = openingTagEnd(source, start);
      if (tagEnd < 0) continue;
      const tag = source.slice(start, tagEnd + 1);
      if (tag.endsWith("/>") || /\baria-label(ledby)?=/.test(tag)) continue;
      const childrenEnd = source.indexOf(`</${button[1]}>`, tagEnd);
      if (childrenEnd < 0) continue;
      const text = staticText(source.slice(tagEnd + 1, childrenEnd));
      if (text) found.set(start, { index: start, text });
    }
  }
  return [...found.values()];
}

describe("repeated buttons name their item", () => {
  it("finds a static-text Button in a .map( with no aria-label", () => {
    const bad = `items.map((item) => (\n  <li key={item.id}>\n    <Button type="button" onClick={() => remove(item.id)}>\n      <TrashIcon />\n      Delete\n    </Button>\n  </li>\n))`;
    expect(unnamedRepeatedButtons(bad)).toEqual([expect.objectContaining({ text: "Delete" })]);
  });

  it("finds a static-text link in a .map( with no aria-label", () => {
    const bad = `rows.map((row) => (
  <ExternalLink key={row.id} href={row.url}>
    View post
  </ExternalLink>
))`;
    expect(unnamedRepeatedButtons(bad)).toEqual([expect.objectContaining({ text: "View post" })]);
  });

  // R57 fix review: text inside a wrapper, a ternary of two fixed words, and
  // native <button> and <a> are just as static.
  it("finds static text inside a wrapper element", () => {
    const bad = `items.map((item) => (\n  <Button onClick={() => reuse(item)}>\n    <Repeat className="h-3.5 w-3.5" aria-hidden />\n    <span className={cn("truncate", item.x && "a")}>Use in new post</span>\n  </Button>\n))`;
    expect(unnamedRepeatedButtons(bad)).toEqual([expect.objectContaining({ text: "Use in new post" })]);
  });

  it("finds a ternary of two string literals", () => {
    const bad = `items.map((item) => <Button onClick={() => save(item)}>{busy ? "Saving…" : "Save"}</Button>)`;
    expect(unnamedRepeatedButtons(bad)).toEqual([expect.objectContaining({ text: "Saving…" })]);
  });

  it("finds a native button", () => {
    const bad = `items.map((item) => (\n  <button type="button" onClick={() => remove(item)}>\n    Remove{" "}\n  </button>\n))`;
    expect(unnamedRepeatedButtons(bad)).toEqual([expect.objectContaining({ text: "Remove" })]);
  });

  it("finds a native link", () => {
    const bad = `rows.map((row) => <a key={row.id} href={row.url}>Open</a>)`;
    expect(unnamedRepeatedButtons(bad)).toEqual([expect.objectContaining({ text: "Open" })]);
  });

  it("passes a named one, a dynamic one, and one outside any .map(", () => {
    const named = `items.map((item) => <Button onClick={() => go(item)} aria-label={\`Delete \${item.name}\`}>Delete</Button>)`;
    const dynamic = `items.map((item) => <Button onClick={() => go(item)}>{item.name}</Button>)`;
    const mixed = `items.map((item) => <button onClick={() => go(item)}>{busy ? "Saving" : item.name}</button>)`;
    const wrapped = `items.map((item) => <a href={item.url}><span>{item.name}</span></a>)`;
    const outside = `<Button onClick={() => save()}>Save</Button>`;
    for (const source of [named, dynamic, mixed, wrapped, outside]) expect(unnamedRepeatedButtons(source)).toEqual([]);
  });

  it("every repeated button and link under src/app and src/components has a name", () => {
    const faults: string[] = [];
    for (const file of ROOTS.flatMap(sourceFiles)) {
      const relative = path.relative(SRC, file).split(path.sep).join("/");
      for (const { text } of unnamedRepeatedButtons(readFileSync(file, "utf8"))) {
        const key = `${relative}: ${text}`;
        if (!EXEMPT.has(key)) faults.push(key);
      }
    }
    expect(faults).toEqual([]);
  });
});
