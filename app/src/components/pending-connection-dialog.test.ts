import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ query: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.query),
}));

import { PendingConnectionDialog } from "./pending-connection-dialog";

// The markup React builds on a first render. With `document` present this is
// the render hydration compares against the server's HTML.
function firstRender(query: string, inBrowser: boolean): string {
  navigation.query = query;
  if (inBrowser) {
    vi.stubGlobal("document", { body: {}, activeElement: null });
  }
  try {
    return renderToString(createElement(PendingConnectionDialog, { workspaceId: "ws-1" }));
  } finally {
    vi.unstubAllGlobals();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// CI screenshot audit 2026-11-11: React error #418 ("HTML") on
// /settings?choose=<id>. The server rendered no dialog (no document), the
// browser's first render portalled the open dialog into <body>, and React
// tried to hydrate that portal against server HTML that was never sent.
describe("PendingConnectionDialog: first render is the same on the server and in the browser", () => {
  it("renders the same markup with ?choose= whether or not a document exists", () => {
    expect(firstRender("choose=pc_1", true)).toBe(firstRender("choose=pc_1", false));
  });

  it("renders nothing before hydration, so the dialog opens only after it", () => {
    expect(firstRender("choose=pc_1", true)).toBe("");
  });

  it("renders nothing without ?choose=", () => {
    expect(firstRender("", true)).toBe("");
  });
});

// R5 pages L8: a failed connect says what happened and what to do.
describe("PendingConnectionDialog failure sentences", () => {
  it("names a network failure and a server failure plainly", async () => {
    const { PENDING_CONNECT_FAILED, PENDING_CONNECT_OFFLINE } = await import("./pending-connection-dialog");
    expect(PENDING_CONNECT_FAILED).toBe("That account wasn't connected. Please press Connect again in a minute.");
    expect(PENDING_CONNECT_OFFLINE).toBe(
      "We couldn't reach Vibe Socials, so nothing was connected. Check your internet connection and press Connect again.",
    );
  });
});
