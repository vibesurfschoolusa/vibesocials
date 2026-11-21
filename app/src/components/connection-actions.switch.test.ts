import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R65 new-customer-2 (unconfirmed): TikTok's Switch opens tiktok.com/logout
 * only after the disconnect answers. A browser can block a tab opened after an
 * await, and window.open with noopener returns null, so the code can't tell.
 * The success toast names the address, so the person can go there by hand.
 *
 * React's hooks are replaced by the small harness connection-actions.cache.test.ts
 * uses: useState keeps its value in a slot between renders, and a component is
 * "rendered" by calling it and walking the elements it returns.
 */
const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  success: vi.fn(),
  error: vi.fn(),
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
    useEffect: () => {},
    useRef: (current: unknown) => ({ current }),
    useCallback: (callback: unknown) => callback,
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: h.refresh }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: h.success, error: h.error }) }));

import { ConnectionActions, DISCONNECT_MAYBE_MESSAGE } from "./connection-actions";

type Element = { type: unknown; props: Record<string, unknown> };

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

function render(platform: string): Element[] {
  h.cursor = 0;
  return elements(ConnectionActions({ platform, workspaceId: "ws-1", isConnected: true }));
}

const open = vi.fn();
const location = { href: "/settings" };

beforeEach(() => {
  h.slots.length = 0;
  h.cursor = 0;
  h.success.mockReset();
  h.error.mockReset();
  h.refresh.mockReset();
  open.mockReset();
  location.href = "/settings";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("window", { open, location, addEventListener: () => {}, removeEventListener: () => {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TIKTOK_SUCCESS =
  "TikTok disconnected. Log out of TikTok in the new tab, or at tiktok.com/logout if no tab opened, then click Connect.";

async function pressTikTokSwitch() {
  const button = render("tiktok").find(
    (element) => element.props.children === "Disconnect & open TikTok logout" && typeof element.props.onClick === "function",
  );
  expect(button).toBeDefined();
  await (button!.props.onClick as () => Promise<void>)();
}

describe("TikTok Switch account", () => {
  it("success: the toast names tiktok.com/logout, and the logout tab is still opened", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    await pressTikTokSwitch();
    expect(open).toHaveBeenCalledWith("https://www.tiktok.com/logout", "_blank", "noopener,noreferrer");
    expect(h.success).toHaveBeenCalledWith(TIKTOK_SUCCESS);
    expect(h.error).not.toHaveBeenCalled();
  });

  it("a failed disconnect: the error toast as before, and no tab", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    await pressTikTokSwitch();
    expect(open).not.toHaveBeenCalled();
    expect(h.success).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith(DISCONNECT_MAYBE_MESSAGE);
  });
});

describe("another platform's Switch account", () => {
  it("as before: disconnects, then goes to its sign-in, with no toast and no tab", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const confirm = render("facebook_page").find((element) => element.props.title === "Switch account?");
    expect(confirm).toBeDefined();
    await (confirm!.props.onConfirm as () => Promise<void>)();
    expect(location.href).toBe("/api/auth/facebook_page/start?workspaceId=ws-1");
    expect(open).not.toHaveBeenCalled();
    expect(h.success).not.toHaveBeenCalled();
  });
});
