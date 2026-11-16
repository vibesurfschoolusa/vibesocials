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
    expect(connect).toMatch(/await fetchOrNoAnswer\(choiceAddress\(endpoint, [^)]*\), \{\s+method: "POST"/);
    expect(connect).toMatch(/catch \{\s+setConnectError\(PENDING_CONNECT_MAYBE\);/);
    expect(connect).toMatch(/setConnectError\(pendingConnectFailureText\(response\.status, data\)\)/);
    const cancel = source.slice(source.indexOf("async function handleCancel"), source.indexOf("const handleClose"));
    expect(cancel).toMatch(/await fetchOrNoAnswer\(endpoint, \{\s+method: "DELETE"/);
  });
});

// R29 lead follow-up (as /c): a gone choice said "This choice expired —
// connect again." although Settings may show the account connected, or a
// Reconnect button. The dialog shows the route's sentence (which follows the
// row) and asks with the platform once known, kept for the tab as /c does.
describe("PendingConnectionDialog: a choice that is gone", () => {
  it("shows the route's sentence; without one, a sentence that names no button", async () => {
    const { pendingGoneText } = await import("./pending-connection-dialog");
    expect(pendingGoneText({ error: "This choice was already used: Facebook Page is connected." })).toBe(
      "This choice was already used: Facebook Page is connected.",
    );
    for (const data of [null, {}, { error: "" }]) {
      expect(pendingGoneText(data)).toBe(
        "This choice has ended: it expired, or an account was already chosen. Close this to see your connections.",
      );
    }
  });

  it("asks with the platform, shows the sentence, and no longer says connect again", () => {
    const source = readFileSync(join(__dirname, "pending-connection-dialog.tsx"), "utf8");
    expect(source).toContain("await fetch(withWorkspaceId(choiceAddress(endpoint, rememberedChoicePlatform(pendingId)), workspaceId))");
    expect(source).toMatch(/rememberChoicePlatform\(pendingId, data\.platform\)/);
    expect(source).toMatch(/await fetchOrNoAnswer\(choiceAddress\(endpoint, load\.status === "ready" \? load\.platform : null\), \{/);
    expect(source).toMatch(/setLoad\(\{ status: "expired", message: pendingGoneText\(data\) \}\)/);
    expect(source).toMatch(/<Alert variant="warning">\{load\.message\}<\/Alert>/);
    expect(source).not.toContain("connect again.</Alert>");
    expect(source).not.toContain("Close this and connect again");
  });
});

// R30 pages L2: a gone answer to Connect swaps the radios, Cancel and Connect
// for the warning and Close; the pressed Connect is removed, and inside a
// dialog the focus keeper does nothing, so the press hands focus to Close (as /c).
describe("PendingConnectionDialog: focus when Connect finds the choice gone", () => {
  it("Connect passes the pressed button, and the gone branch hands focus to Close", () => {
    const source = readFileSync(join(__dirname, "pending-connection-dialog.tsx"), "utf8");
    const connect = source.slice(source.indexOf("async function handleConnect"), source.indexOf("async function handleCancel"));
    expect(connect).toMatch(/async function handleConnect\(pressed: HTMLElement \| null\)/);
    expect(connect).toMatch(
      /if \(response\.status === 404\) \{\s+focusAfterPress\(pressed, \(\) => closeRef\.current\);\s+setLoad\(\{ status: "expired", message: pendingGoneText\(data\) \}\);/,
    );
    expect(source).toMatch(/onClick=\{\(event\) => handleConnect\(event\.currentTarget\)\}/);
    expect(source).toMatch(/<Button ref=\{closeRef\} variant="outline" onClick=\{handleClose\}/);
  });
});

// R31 follow-up: a failed load showed a fixed sentence whose "Close this"
// cancelled the choice before the reload it advised.
describe("PendingConnectionDialog: a load that fails", () => {
  it("shows the route's sentence, else one that keeps the choice", async () => {
    const { pendingLoadFailedText } = await import("./pending-connection-dialog");
    expect(pendingLoadFailedText({ error: "Couldn't load your accounts. Reload the page to try again, or close this and press Reconnect on Facebook Page." })).toBe(
      "Couldn't load your accounts. Reload the page to try again, or close this and press Reconnect on Facebook Page.",
    );
    for (const data of [null, {}, { error: 5 }]) {
      expect(pendingLoadFailedText(data)).toBe("Couldn't load your accounts. Reload the page to try again.");
    }
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./pending-connection-dialog.tsx", import.meta.url)), "utf8");
    expect(source).not.toContain("Close this and reload the page");
    expect(source).toMatch(/<Alert variant="danger">\{load\.message\}<\/Alert>/);
  });
});

// R32 publishing L1: the choice is read for the workspace Settings was drawn
// for; the route's refusal sentence is what the dialog then says.
describe("the choice read and the page's workspace", () => {
  it("sends the page's id and shows a refusal's own sentence", () => {
    const source = readFileSync(join(__dirname, "pending-connection-dialog.tsx"), "utf8");
    expect(source).toContain("fetch(withWorkspaceId(choiceAddress(endpoint, rememberedChoicePlatform(pendingId)), workspaceId))");
    expect(source).toMatch(/\}, \[endpoint, pendingId, workspaceId\]\);/);
  });
});
