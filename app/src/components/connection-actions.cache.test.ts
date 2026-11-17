import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "@prisma/client";

/**
 * R37 new-customer (unconfirmed) and lead follow-up: Switch account
 * disconnects, then leaves for the platform. Back can restore Settings from
 * the back-forward cache with the rows still saying "Connected as ..." and
 * the dialog still open. On such a return the Connections section reads the
 * server's data once (not once per row), and each row closes the dialogs
 * that lead off the page.
 *
 * React's hooks are replaced by a small harness: useState keeps its value in
 * a slot between renders, effects are run against a fake window, and a
 * component is "rendered" by calling it and walking the elements it returns.
 */
const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => void | (() => void)>,
  refresh: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const slot = h.cursor++;
      if (!(slot in h.slots)) h.slots[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      const set = (value: unknown) => {
        h.slots[slot] = typeof value === "function" ? (value as (prev: unknown) => unknown)(h.slots[slot]) : value;
      };
      return [h.slots[slot], set];
    },
    useEffect: (effect: () => void | (() => void)) => {
      h.effects.push(effect);
    },
    useRef: (current: unknown) => ({ current }),
    useCallback: (callback: unknown) => callback,
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: h.refresh }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { ConnectionActions } from "./connection-actions";
import { ConnectionsSection } from "./connections-section";
import type { ConnectionSummary } from "@/lib/connectionSummary";

type PageShowListener = (event: { persisted: boolean }) => void;
type Element = { type: unknown; props: Record<string, unknown> };

const listeners: PageShowListener[] = [];

function pageshow(persisted: boolean) {
  for (const listener of [...listeners]) listener({ persisted });
}

/** Every element in a returned tree, without calling the components in it. */
function elements(node: unknown, found: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, found);
  } else if (node && typeof node === "object" && "props" in node) {
    const element = node as Element;
    found.push(element);
    elements(element.props.children, found);
  }
  return found;
}

/** Calls the component from the first slot, as React would on each render. */
function render<P>(component: (props: P) => unknown, props: P): Element[] {
  h.cursor = 0;
  return elements(component(props));
}

beforeEach(() => {
  h.slots.length = 0;
  h.cursor = 0;
  h.effects.length = 0;
  h.refresh.mockReset();
  listeners.length = 0;
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: PageShowListener) => {
      if (type === "pageshow") listeners.push(listener);
    },
    removeEventListener: (_type: string, listener: PageShowListener) => {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Settings connections: a return from the back-forward cache", () => {
  const CONNECTED: Platform[] = ["youtube", "x", "tiktok", "pinterest", "instagram", "facebook_page", "linkedin"];

  function mountSection() {
    const connections = CONNECTED.map(
      (platform) =>
        ({ platform, accountIdentifier: "acct", username: "Some account", locationName: null, needsReconnect: false }) as ConnectionSummary,
    );
    const tree = render(ConnectionsSection, { workspaceId: "ws-1", connections });
    const rows = tree.filter((element) => element.type === ConnectionActions);
    expect(rows).toHaveLength(7);
    // Each row is a component of its own: call it with its own hooks.
    for (const row of rows) (row.type as (props: unknown) => unknown)(row.props);
    for (const effect of h.effects) effect();
  }

  it("one pageshow with persisted true refreshes the server data exactly once, with 7 rows mounted", () => {
    mountSection();
    pageshow(true);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("a normal pageshow refreshes nothing", () => {
    mountSection();
    pageshow(false);
    expect(h.refresh).not.toHaveBeenCalled();
  });
});

describe("a connection row's dialogs that lead off the page close on a return from the cache", () => {
  function press(tree: Element[], label: string) {
    const button = tree.find((element) => element.props.children === label && typeof element.props.onClick === "function");
    expect(button, label).toBeDefined();
    (button!.props.onClick as () => void)();
  }

  function dialog(tree: Element[], title: string): Element {
    const found = tree.find((element) => element.props.title === title || element.props.mode === title);
    expect(found, title).toBeDefined();
    return found!;
  }

  it("Switch account (the standard confirm): open, then closed after the return", () => {
    const props = { platform: "facebook_page", workspaceId: "ws-1", isConnected: true };
    press(render(ConnectionActions, props), "Switch account");
    for (const effect of h.effects) effect();
    expect(dialog(render(ConnectionActions, props), "Switch account?").props.open).toBe(true);

    pageshow(true);

    expect(dialog(render(ConnectionActions, props), "Switch account?").props.open).toBe(false);
  });

  it("a normal pageshow leaves an open Switch dialog open", () => {
    const props = { platform: "facebook_page", workspaceId: "ws-1", isConnected: true };
    press(render(ConnectionActions, props), "Switch account");
    for (const effect of h.effects) effect();

    pageshow(false);

    expect(dialog(render(ConnectionActions, props), "Switch account?").props.open).toBe(true);
  });

  it("LinkedIn's Switch account and Reconnect dialogs close too", () => {
    const props = { platform: "linkedin", workspaceId: "ws-1", isConnected: true, reconnectSoon: true };
    press(render(ConnectionActions, props), "Switch account");
    press(render(ConnectionActions, props), "Reconnect");
    for (const effect of h.effects) effect();
    let tree = render(ConnectionActions, props);
    expect(dialog(tree, "switch").props.open).toBe(true);
    expect(dialog(tree, "reconnect").props.open).toBe(true);

    pageshow(true);

    tree = render(ConnectionActions, props);
    expect(dialog(tree, "switch").props.open).toBe(false);
    expect(dialog(tree, "reconnect").props.open).toBe(false);
  });
});
