import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * R36 new-customer (unconfirmed): a control that sets a busy state and then
 * leaves the page stays busy if the browser restores the page from its
 * back-forward cache. Every such control resets from one helper here.
 *
 * React's hooks are replaced so each component can be called as a function:
 * every useState answers its initial value and records its setter, and every
 * effect is kept to run against a fake window.
 */
const h = vi.hoisted(() => ({
  setters: [] as Array<{ initial: unknown; set: Mock }>,
  effects: [] as Array<() => void | (() => void)>,
  query: "",
  getProviders: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const value = typeof initial === "function" ? (initial as () => unknown)() : initial;
      const set = vi.fn();
      h.setters.push({ initial: value, set });
      return [value, set];
    },
    useEffect: (effect: () => void | (() => void)) => {
      h.effects.push(effect);
    },
    useRef: (current: unknown) => ({ current }),
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useCallback: (callback: unknown) => callback,
  };
});
vi.mock("next-auth/react", () => ({ getProviders: h.getProviders }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(h.query),
}));

import { GoogleSignInButton } from "./google-sign-in-button";
import { LinkedInAccountDialog } from "./linkedin-account-dialog";
import { LinkedInSetupDialog } from "./linkedin-setup-dialog";
import { PendingConnectionDialog } from "./pending-connection-dialog";
import { PlanActions } from "./plan-actions";
import { onReturnFromCache } from "./returnFromCache";

type PageShowListener = (event: { persisted: boolean }) => void;

function fakeWindow() {
  const listeners = new Map<string, PageShowListener>();
  return {
    listeners,
    addEventListener: (type: string, listener: PageShowListener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };
}

describe("onReturnFromCache", () => {
  it("calls back when the page is shown again from the cache, not on a fresh load", () => {
    const target = fakeWindow();
    const reset = vi.fn();
    onReturnFromCache(target as never, reset);
    target.listeners.get("pageshow")?.({ persisted: false });
    expect(reset).not.toHaveBeenCalled();
    target.listeners.get("pageshow")?.({ persisted: true });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("stops listening when the component goes", () => {
    const target = fakeWindow();
    const stop = onReturnFromCache(target as never, () => {});
    stop();
    expect(target.listeners.has("pageshow")).toBe(false);
  });
});

describe("controls that leave the page reset their busy state on a return from the cache", () => {
  let win: ReturnType<typeof fakeWindow>;

  beforeEach(() => {
    h.setters.length = 0;
    h.effects.length = 0;
    h.query = "";
    win = fakeWindow();
    vi.stubGlobal("window", { ...win, sessionStorage: { getItem: () => null, setItem: () => {} } });
    // The pending choice loads its accounts on mount, and the Google button its
    // providers; neither answer comes here.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    h.getProviders.mockReset();
    h.getProviders.mockReturnValue(new Promise(() => {}));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  type Element = { type: (props: Record<string, unknown>) => unknown; props: Record<string, unknown> };

  /** Calls the component (and, for a wrapper, the one it returns), runs its effects, and answers the pageshow listener. */
  function mount(element: unknown, unwrap: boolean): PageShowListener {
    const top = element as Element;
    const rendered = top.type(top.props) as Element;
    if (unwrap) rendered.type(rendered.props);
    for (const effect of h.effects) effect();
    const listener = win.listeners.get("pageshow");
    expect(listener).toBeDefined();
    return listener!;
  }

  const CONTROLS: Array<{
    name: string;
    element: () => unknown;
    busyState: number;
    idle: unknown;
    query?: string;
    unwrap?: boolean;
  }> = [
    {
      name: "LinkedIn setup dialog (Continue to LinkedIn)",
      element: () => ({ type: LinkedInSetupDialog, props: { workspaceId: "ws-1" } }),
      busyState: 1, // vanityName, isConnecting, fieldError
      idle: false,
      query: "linkedin_setup=true",
    },
    {
      name: "LinkedIn account dialog (Connect, Reconnect, Switch account)",
      element: () => ({
        type: LinkedInAccountDialog,
        props: { workspaceId: "ws-1", open: true, onOpenChange: () => {}, mode: "connect" },
      }),
      busyState: 0, // busy
      idle: false,
    },
    {
      name: "pending connection choice (Connect, Cancel)",
      element: () => ({ type: PendingConnectionDialog, props: { workspaceId: "ws-1" } }),
      busyState: 2, // load, selectedId, busy, connectError
      idle: null,
      query: "choose=pending-1",
      unwrap: true, // PendingConnectionDialog returns the choice that holds the state
    },
    {
      name: "Continue with Google (login and register)",
      element: () => ({ type: GoogleSignInButton, props: { callbackUrl: "/dashboard" } }),
      busyState: 1, // available, loading, error
      idle: false,
    },
    {
      name: "plan buttons (checkout and portal)",
      element: () => ({ type: PlanActions, props: { workspaceId: "ws-1", offers: [], manage: true } }),
      busyState: 0, // busy, error, interval
      idle: null,
    },
  ];

  for (const control of CONTROLS) {
    it(`${control.name}: resets on pageshow with persisted true, not on a fresh load`, () => {
      h.query = control.query ?? "";
      const pageshow = mount(control.element(), control.unwrap === true);
      const calls = () => h.setters.filter((s) => s.set.mock.calls.length > 0);

      pageshow({ persisted: false });
      expect(calls()).toEqual([]);

      pageshow({ persisted: true });
      expect(calls()).toHaveLength(1);
      expect(calls()[0]).toBe(h.setters[control.busyState]);
      expect(calls()[0].set).toHaveBeenCalledWith(control.idle);
    });
  }
});

// The Google button otherwise behaves as before: nothing until NextAuth says
// Google is set up, and a failed provider check never shows it.
describe("Continue with Google, apart from the reset", () => {
  beforeEach(() => {
    h.setters.length = 0;
    h.effects.length = 0;
    h.getProviders.mockReset();
    vi.stubGlobal("window", fakeWindow());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function shownAfterProviders(answer: () => Promise<unknown>): Promise<unknown[]> {
    h.getProviders.mockImplementation(answer);
    expect(GoogleSignInButton({ callbackUrl: "/dashboard" })).toBeNull();
    for (const effect of h.effects) effect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return h.setters[0].set.mock.calls.map((call) => call[0]);
  }

  it("renders nothing first, then shows when Google is configured", async () => {
    expect(await shownAfterProviders(async () => ({ google: { id: "google" } }))).toEqual([true]);
  });

  it("stays hidden without Google, or when the provider check fails", async () => {
    expect(await shownAfterProviders(async () => ({ credentials: {} }))).toEqual([false]);
    h.setters.length = 0;
    h.effects.length = 0;
    expect(await shownAfterProviders(async () => Promise.reject(new Error("offline")))).toEqual([false]);
  });
});

// One reset rule: only this helper listens for pageshow.
describe("the back-forward-cache reset lives in one place", () => {
  it("no other client file listens for pageshow", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join, relative, sep } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = fileURLToPath(new URL("..", import.meta.url));
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return files(path);
        return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
      });
    const listening = files(src)
      .filter((path) => /["']pageshow["']/.test(readFileSync(path, "utf8")))
      .map((path) => relative(src, path).split(sep).join("/"));
    expect(listening).toEqual(["components/returnFromCache.ts"]);
  });
});
