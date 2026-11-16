import { describe, expect, it, vi } from "vitest";

import {
  FOCUS_RECHECK_MS,
  focusAfterPress,
  focusFallbacks,
  restoreFocus,
  watchFocusAfterClose,
} from "./focusAfter";

/**
 * R26 pages L4: a confirmed action can remove the button that opened the
 * dialog (Team Remove and the "gone" drop, Queue Cancel/Delete/Publish,
 * "Create link"), and focus returned to a button no longer on the page lands
 * on the body. The dialog records, at open, the headings above the trigger
 * (nearest first) and, on close, focuses the first one still on the page.
 * A fake element tree: the panel renders into a portal and vitest has no DOM.
 */
type Fake = {
  tagName: string;
  parentElement: Fake | null;
  children: Fake[];
  attrs: Record<string, string>;
  tabIndex: number;
  focus: ReturnType<typeof vi.fn>;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  readonly isConnected: boolean;
};

function el(tagName: string, children: Fake[] = [], attrs: Record<string, string> = {}): Fake {
  const node: Fake = {
    tagName,
    parentElement: null,
    children,
    attrs,
    tabIndex: tagName === "BUTTON" ? 0 : -1,
    focus: vi.fn(),
    hasAttribute: (name) => name in node.attrs,
    getAttribute: (name) => node.attrs[name] ?? null,
    get isConnected() {
      let at: Fake = node;
      while (at.parentElement) at = at.parentElement;
      return at.tagName === "HTML";
    },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

function detach(node: Fake) {
  const parent = node.parentElement;
  if (parent) parent.children = parent.children.filter((child) => child !== node);
  node.parentElement = null;
}

const asElement = (node: Fake) => node as unknown as HTMLElement;

describe("focus when the dialog's trigger is gone", () => {
  // Team: a heading, then rows of a name and a button; the trigger's row is in the middle.
  function teamPage() {
    const before = el("BUTTON");
    const remove = el("BUTTON");
    const after = el("BUTTON");
    const row = el("LI", [el("P"), remove]);
    const members = el("H3");
    const invite = el("H3", [], { tabindex: "0" });
    const h1 = el("H1");
    const list = el("UL", [el("LI", [el("P"), before]), row, el("LI", [el("P"), after])]);
    el("HTML", [el("BODY", [h1, el("DIV", [invite]), el("DIV", [members, list])])]);
    return { before, remove, after, row, members, invite, h1 };
  }

  it("records the next row's control, then the previous row's, then the headings above", () => {
    const { remove, before, after, members, invite, h1 } = teamPage();
    expect(focusFallbacks(asElement(remove))).toEqual([after, before, members, invite, h1]);
  });

  it("the trigger still on the page gets focus back, as before", () => {
    const { remove } = teamPage();
    restoreFocus(asElement(remove), focusFallbacks(asElement(remove)));
    expect(remove.focus).toHaveBeenCalledTimes(1);
  });

  it("the trigger's row was removed: the next row's control, without scrolling the page", () => {
    const { remove, row, after, members } = teamPage();
    const fallbacks = focusFallbacks(asElement(remove));
    detach(row);
    restoreFocus(asElement(remove), fallbacks);
    expect(remove.focus).not.toHaveBeenCalled();
    expect(after.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(members.focus).not.toHaveBeenCalled();
  });

  it("the last row: the previous row's control", () => {
    const { remove, row, after, before } = teamPage();
    const fallbacks = focusFallbacks(asElement(remove));
    detach(after.parentElement!);
    detach(row);
    restoreFocus(asElement(remove), fallbacks);
    expect(before.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("no row left: the section heading, made focusable, without scrolling; one with a tabindex is left as is", () => {
    const { remove, row, before, after, members, invite } = teamPage();
    const fallbacks = focusFallbacks(asElement(remove));
    for (const node of [before.parentElement!, after.parentElement!, row]) detach(node);
    restoreFocus(asElement(remove), fallbacks);
    expect(members.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(members.tabIndex).toBe(-1);

    detach(members);
    invite.tabIndex = 0;
    restoreFocus(asElement(remove), fallbacks);
    expect(invite.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(invite.tabIndex).toBe(0);
  });

  it("a disabled button in the next row is skipped", () => {
    const disabled = el("BUTTON", [], { disabled: "" });
    const enabled = el("BUTTON");
    const remove = el("BUTTON");
    const row = el("LI", [remove]);
    el("HTML", [el("BODY", [el("UL", [row, el("LI", [disabled, enabled])])])]);
    expect(focusFallbacks(asElement(remove))[0]).toBe(enabled);
  });

  it("nothing was focused at open: nothing to restore", () => {
    expect(focusFallbacks(null)).toEqual([]);
    expect(() => restoreFocus(null, [])).not.toThrow();
  });

  // Lead follow-up: a caller that reloads after close (Queue's series cancel)
  // removes the trigger later, when focus was already given back to it.
  function scheduler() {
    const frames: (() => void)[] = [];
    const timers: { ms: number; run: () => void }[] = [];
    return {
      frames,
      timers,
      schedule: { frame: (run: () => void) => frames.push(run), later: (run: () => void, ms: number) => timers.push({ ms, run }) },
      runAll() {
        for (const run of frames) run();
        for (const timer of timers) timer.run();
      },
    };
  }

  function fakeDoc(active: Fake | null) {
    const body = el("BODY");
    const listeners = new Set<(event: { target: unknown }) => void>();
    const doc = {
      activeElement: (active ?? body) as Fake,
      body,
      addEventListener: (_type: string, listener: (event: { target: unknown }) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: { target: unknown }) => void) => listeners.delete(listener),
    };
    return {
      doc: doc as unknown as Document,
      listeners,
      focusIn(target: Fake) {
        doc.activeElement = target;
        for (const listener of [...listeners]) listener({ target });
      },
      toBody() {
        doc.activeElement = body;
      },
    };
  }

  it("checks again on the next frame and after short timeouts", () => {
    const { remove } = teamPage();
    const { frames, timers, schedule } = scheduler();
    watchFocusAfterClose(asElement(remove), [], schedule, fakeDoc(null).doc);
    expect(frames).toHaveLength(1);
    expect(timers.map((timer) => timer.ms)).toEqual(FOCUS_RECHECK_MS);
  });

  it("the trigger was removed after close and focus fell to the body: one restore, then it stops", () => {
    const { remove, row, after } = teamPage();
    const fallbacks = focusFallbacks(asElement(remove));
    const page = fakeDoc(remove);
    const { frames, timers, schedule } = scheduler();
    watchFocusAfterClose(asElement(remove), fallbacks, schedule, page.doc);
    frames[0]();
    expect(after.focus).not.toHaveBeenCalled(); // the trigger is still there
    detach(row);
    page.toBody();
    timers[0].run();
    expect(after.focus).toHaveBeenCalledTimes(1);
    // Later checks never act again, even if focus is on the body once more.
    page.toBody();
    timers[1].run();
    expect(after.focus).toHaveBeenCalledTimes(1);
    expect(page.listeners.size).toBe(0);
  });

  it("focus the person moved since close, even back to the body, is never pulled back", () => {
    const { remove, row, after } = teamPage();
    const fallbacks = focusFallbacks(asElement(remove));
    const page = fakeDoc(remove);
    const { schedule, runAll } = scheduler();
    watchFocusAfterClose(asElement(remove), fallbacks, schedule, page.doc);
    page.focusIn(el("INPUT"));
    page.toBody();
    detach(row);
    runAll();
    expect(after.focus).not.toHaveBeenCalled();
    expect(page.listeners.size).toBe(0);
  });

  it("focus elsewhere at a check stops the watch too", () => {
    const { remove, row, after } = teamPage();
    const fallbacks = focusFallbacks(asElement(remove));
    const page = fakeDoc(el("INPUT"));
    const { frames, timers, schedule } = scheduler();
    watchFocusAfterClose(asElement(remove), fallbacks, schedule, page.doc);
    detach(row);
    frames[0]();
    page.toBody();
    for (const timer of timers) timer.run();
    expect(after.focus).not.toHaveBeenCalled();
  });
});

/**
 * Lead review: the walk climbed past the page content, so at the body level a
 * "next row" could be a toast's button or the mobile drawer. It stops at the
 * trigger's <main> (or its nearest section when there is none), and skips
 * anything hidden, aria-hidden or inert.
 */
describe("focus fallbacks stay in the page content", () => {
  function shell(extra: { inMain?: Fake[]; besideMain?: Fake[] } = {}) {
    const remove = el("BUTTON");
    const row = el("DIV", [remove]);
    const heading = el("H1");
    const list = el("DIV", [row]);
    const main = el("MAIN", [heading, list, ...(extra.inMain ?? [])]);
    el("HTML", [el("BODY", [el("NAV", [el("A", [], { href: "/" })]), main, ...(extra.besideMain ?? [])])]);
    return { remove, row, heading, list };
  }

  it("a toast region beside main is never chosen; the heading is", () => {
    const toastButton = el("BUTTON");
    const { remove, row, heading } = shell({ besideMain: [el("SECTION", [toastButton], { "aria-label": "Notifications" })] });
    const fallbacks = focusFallbacks(asElement(remove));
    expect(fallbacks).not.toContain(toastButton);
    expect(fallbacks).toEqual([heading]);
    detach(row);
    restoreFocus(asElement(remove), fallbacks);
    expect(toastButton.focus).not.toHaveBeenCalled();
    expect(heading.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("a hidden, aria-hidden or inert control is never chosen; the next row still is", () => {
    const drawerLink = el("A", [], { href: "/queue" });
    const hiddenButton = el("BUTTON");
    const inertButton = el("BUTTON");
    const next = el("BUTTON");
    const remove = el("BUTTON");
    const heading = el("H2");
    const list = el("UL", [
      el("LI", [remove]),
      el("LI", [el("DIV", [drawerLink], { "aria-hidden": "true" })]),
      el("LI", [hiddenButton], { hidden: "" }),
      el("LI", [inertButton], { inert: "" }),
      el("LI", [next]),
    ]);
    el("HTML", [el("BODY", [el("MAIN", [heading, list])])]);
    const fallbacks = focusFallbacks(asElement(remove));
    expect(fallbacks).toEqual([next, heading]);
  });

  it("with no main, the walk stops at the trigger's nearest section", () => {
    const outside = el("BUTTON");
    const remove = el("BUTTON");
    const next = el("BUTTON");
    const heading = el("H2");
    el("HTML", [el("BODY", [el("SECTION", [heading, el("DIV", [el("P", [remove]), el("P", [next])])]), el("DIV", [outside])])]);
    expect(focusFallbacks(asElement(remove))).toEqual([next, heading]);
  });
});

/**
 * R27 MM3 (new-customer L2, pages L1 and L5): a press can remove or disable
 * the control that was pressed with no dialog involved (Team "Create invite
 * link", a rename Save, "Create link", the client pages' Send). focusAfterPress
 * records the fallbacks at the press and, once the page has changed, moves
 * focus to the caller's target, else the first fallback, only while focus is
 * on the page body or the dead control.
 */
describe("focusAfterPress", () => {
  function page() {
    const heading = el("H2");
    const create = el("BUTTON");
    const other = el("BUTTON");
    const block = el("DIV", [create]);
    const main = el("MAIN", [heading, block, el("DIV", [other])]);
    el("HTML", [el("BODY", [main])]);
    return { heading, create, other, block };
  }

  function harness(active: Fake | null) {
    const frames: (() => void)[] = [];
    const timers: { ms: number; run: () => void }[] = [];
    const body = el("BODY");
    const listeners = new Set<(event: { target: unknown }) => void>();
    const doc = {
      activeElement: (active ?? body) as Fake,
      body,
      addEventListener: (_type: string, listener: (event: { target: unknown }) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: { target: unknown }) => void) => listeners.delete(listener),
    };
    return {
      frames,
      timers,
      listeners,
      schedule: { frame: (run: () => void) => frames.push(run), later: (run: () => void, ms: number) => timers.push({ ms, run }) },
      doc: doc as unknown as Document,
      toBody: () => {
        doc.activeElement = body;
      },
      focusIn(target: Fake) {
        doc.activeElement = target;
        for (const listener of [...listeners]) listener({ target });
      },
    };
  }

  it("the pressed control was replaced: the new control takes focus, once", () => {
    const { create, block } = page();
    const copy = el("BUTTON");
    const h = harness(create);
    focusAfterPress(asElement(create), () => asElement(copy), { schedule: h.schedule, doc: h.doc });
    // The page changes after the call: the button goes, the new block comes.
    block.children = [];
    create.parentElement = null;
    block.children.push(copy);
    copy.parentElement = block;
    h.toBody();
    h.frames[0]();
    expect(copy.focus).toHaveBeenCalledTimes(1);
    for (const timer of h.timers) timer.run();
    expect(copy.focus).toHaveBeenCalledTimes(1);
    expect(h.listeners.size).toBe(0);
  });

  it("checks on the next frame and after the same short delays as the dialog", () => {
    const { create } = page();
    const h = harness(create);
    focusAfterPress(asElement(create), undefined, { schedule: h.schedule, doc: h.doc });
    expect(h.frames).toHaveLength(1);
    expect(h.timers.map((timer) => timer.ms)).toEqual(FOCUS_RECHECK_MS);
  });

  it("no target on the page: the fallback recorded at the press, without scrolling", () => {
    const { create, block, other } = page();
    const h = harness(create);
    focusAfterPress(asElement(create), () => null, { schedule: h.schedule, doc: h.doc });
    detach(create);
    h.toBody();
    h.frames[0]();
    expect(other.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(block.children).toHaveLength(0);
  });

  it("the pressed control is still there but disabled, with focus left on it: it moves on", () => {
    const { create, other } = page();
    const h = harness(create);
    focusAfterPress(asElement(create), undefined, { schedule: h.schedule, doc: h.doc });
    create.attrs.disabled = "";
    h.frames[0]();
    expect(other.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("the pressed control is still there and usable: focus is left alone", () => {
    const { create, other } = page();
    const copy = el("BUTTON");
    const h = harness(create);
    focusAfterPress(asElement(create), () => asElement(copy), { schedule: h.schedule, doc: h.doc });
    for (const run of h.frames) run();
    for (const timer of h.timers) timer.run();
    expect(copy.focus).not.toHaveBeenCalled();
    expect(other.focus).not.toHaveBeenCalled();
    expect(create.focus).not.toHaveBeenCalled();
  });

  it("focus the person moved since the press is never pulled back", () => {
    const { create, other } = page();
    const copy = el("BUTTON");
    const h = harness(create);
    focusAfterPress(asElement(create), () => asElement(copy), { schedule: h.schedule, doc: h.doc });
    h.focusIn(el("INPUT"));
    detach(create);
    h.toBody();
    for (const run of h.frames) run();
    for (const timer of h.timers) timer.run();
    expect(copy.focus).not.toHaveBeenCalled();
    expect(other.focus).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
  });

  it("a target that is not a control (a status line) is made focusable by script only", () => {
    const { create, block } = page();
    const status = el("P");
    block.children.push(status);
    status.parentElement = block;
    const h = harness(create);
    focusAfterPress(asElement(create), () => asElement(status), { schedule: h.schedule, doc: h.doc });
    detach(create);
    h.toBody();
    h.frames[0]();
    expect(status.tabIndex).toBe(-1);
    expect(status.focus).toHaveBeenCalledTimes(1);
  });

  it("nothing pressed: does nothing", () => {
    const h = harness(null);
    expect(() => focusAfterPress(null, undefined, { schedule: h.schedule, doc: h.doc })).not.toThrow();
    expect(h.frames).toHaveLength(0);
  });
});

describe("restoreFocus and a disabled trigger", () => {
  it("a trigger still on the page but disabled is passed over for the first fallback", () => {
    const trigger = el("BUTTON", [], { disabled: "" });
    const next = el("BUTTON");
    el("HTML", [el("BODY", [el("MAIN", [el("DIV", [trigger]), el("DIV", [next])])])]);
    expect(restoreFocus(asElement(trigger), [asElement(next)])).toBe(true);
    expect(trigger.focus).not.toHaveBeenCalled();
    expect(next.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("a fallback that became disabled is skipped too", () => {
    const trigger = el("BUTTON");
    const first = el("BUTTON");
    const second = el("BUTTON");
    el("HTML", [el("BODY", [el("MAIN", [el("DIV", [first]), el("DIV", [second])])])]);
    first.attrs.disabled = "";
    restoreFocus(asElement(trigger), [asElement(first), asElement(second)]);
    expect(first.focus).not.toHaveBeenCalled();
    expect(second.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});
