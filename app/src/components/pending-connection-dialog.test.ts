import { readFileSync } from "node:fs";
import { join } from "node:path";

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
// R28 NN2 (new-customer L2): the choice may have been saved before the answer
// was lost or a gateway answered 5xx; pressing Connect again would then say the
// choice expired. Cancel leaves for the connections list, where it shows.
describe("PendingConnectionDialog failure sentences", () => {
  it("a refusal says it wasn't connected; a lost answer that it may have been, and where to check", async () => {
    const { PENDING_CONNECT_FAILED, PENDING_CONNECT_MAYBE, pendingConnectFailureText } = await import("./pending-connection-dialog");
    expect(PENDING_CONNECT_FAILED).toBe("That account wasn't connected. Please press Connect again in a minute.");
    expect(PENDING_CONNECT_MAYBE).toBe(
      "Vibe Socials' answer didn't reach you, so the account may have been connected. If your connection dropped, reconnect first. Press Cancel, then look for it in your connections before you connect again.",
    );
    expect(pendingConnectFailureText(502, null)).toBe(PENDING_CONNECT_MAYBE);
    expect(pendingConnectFailureText(200, null)).toBe(PENDING_CONNECT_MAYBE);
    expect(pendingConnectFailureText(400, null)).toBe(PENDING_CONNECT_FAILED);
    expect(pendingConnectFailureText(403, { error: "Only an owner can connect accounts." })).toBe("Only an owner can connect accounts.");
  });

  it("both presses go through fetchOrNoAnswer, and no answer gets the may-have sentence", () => {
    const source = readFileSync(join(__dirname, "pending-connection-dialog.tsx"), "utf8");
    const connect = source.slice(source.indexOf("async function handleConnect"), source.indexOf("async function handleCancel"));
    expect(connect).toMatch(/await fetchOrNoAnswer\(endpoint, \{\s+method: "POST"/);
    expect(connect).toMatch(/catch \{\s+setConnectError\(PENDING_CONNECT_MAYBE\);/);
    expect(connect).toMatch(/setConnectError\(pendingConnectFailureText\(response\.status, data\)\)/);
    const cancel = source.slice(source.indexOf("async function handleCancel"), source.indexOf("const handleClose"));
    expect(cancel).toMatch(/await fetchOrNoAnswer\(endpoint, \{\s+method: "DELETE"/);
  });
});
