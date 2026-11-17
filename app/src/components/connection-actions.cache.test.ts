import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R37 new-customer (unconfirmed): Switch account disconnects, then leaves for
 * the platform. Back can restore Settings from the back-forward cache with the
 * row still saying "Connected as ...", so a return that way reads the
 * server's data again (returnFromCache's onReturnFromCache).
 *
 * React's hooks are replaced so the row can be called as a function, and its
 * effects run against a fake window (as in returnFromCache.test.ts).
 */
const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  refresh: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, vi.fn()],
    useEffect: (effect: () => void | (() => void)) => {
      h.effects.push(effect);
    },
    useRef: (current: unknown) => ({ current }),
    useCallback: (callback: unknown) => callback,
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: h.refresh }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { ConnectionActions } from "./connection-actions";

type PageShowListener = (event: { persisted: boolean }) => void;

describe("Settings connection row: a return from the back-forward cache", () => {
  const listeners = new Map<string, PageShowListener>();

  beforeEach(() => {
    h.effects.length = 0;
    h.refresh.mockReset();
    listeners.clear();
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: PageShowListener) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes the server data on pageshow with persisted true, not on a fresh load", () => {
    ConnectionActions({ platform: "facebook_page", workspaceId: "ws-1", isConnected: true });
    for (const effect of h.effects) effect();
    const pageshow = listeners.get("pageshow");
    expect(pageshow).toBeDefined();

    pageshow!({ persisted: false });
    expect(h.refresh).not.toHaveBeenCalled();

    pageshow!({ persisted: true });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});
