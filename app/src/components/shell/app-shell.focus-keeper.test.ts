import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R28 NN1: the focus keeper is installed once wherever pages render. The root
 * layout wraps every route in AppShell (the signed-in frame, the public pages
 * and the /c, /u and /v client pages, which render bare), so AppShell mounts
 * it on every route, framed or bare, and ends it when it goes.
 */

const { path, install, stop } = vi.hoisted(() => {
  const stop = vi.fn();
  return { path: { value: "/" }, stop, install: vi.fn(() => stop) };
});

vi.mock("@/lib/focusKeeper", () => ({ installFocusKeeper: install }));
vi.mock("next/navigation", () => ({ usePathname: () => path.value, useRouter: () => ({ refresh() {} }) }));
vi.mock("next-auth/react", async () => {
  const { createContext, useContext } = await import("react");
  const SessionContext = createContext<unknown>(undefined);
  return { SessionContext, useSession: () => useContext(SessionContext) };
});
vi.mock("./sidebar", () => ({ Sidebar: () => null }));
vi.mock("./top-bar", () => ({ TopBar: () => null }));
vi.mock("./mobile-drawer", () => ({ MobileDrawer: () => null }));
vi.mock("./time-zone-sync", () => ({ TimeZoneSync: () => null }));
vi.mock("./verify-email-banner", () => ({ VerifyEmailBanner: () => null }));
vi.mock("./workspace-paused-banner", () => ({ WorkspacePausedBanner: () => null }));

import { SessionContext } from "next-auth/react";

import { AppShell } from "./app-shell";
import { makeDocument } from "./fakeDom.testkit";

const SIGNED_IN = {
  status: "authenticated",
  data: { user: { name: "Owner", email: "owner@example.com" }, expires: "2099-01-01T00:00:00Z" },
};
const NOBODY = { status: "unauthenticated", data: null };

let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("window", made.doc.defaultView);
  root = createRoot(made.container as unknown as HTMLElement);
  install.mockClear();
  stop.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AppShell installs the focus keeper", () => {
  for (const [label, pathname, session] of [
    ["the signed-in frame", "/queue", SIGNED_IN],
    ["a public page", "/forgot-password", NOBODY],
    ["the /c client page", "/c/token", NOBODY],
    ["the /u client page", "/u/token", NOBODY],
    ["the /v client page", "/v/token", NOBODY],
  ] as const) {
    it(`${label}: once, and ended when the page goes`, async () => {
      path.value = pathname;
      await act(async () => {
        root.render(
          createElement(SessionContext.Provider as never, { value: session } as never, createElement(AppShell, null, "PAGE")),
        );
      });
      expect(install).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      await act(async () => root.unmount());
      expect(stop).toHaveBeenCalledTimes(1);
    });
  }
});
