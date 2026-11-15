import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const confirmProps: Record<string, unknown>[] = [];
vi.mock("@/components/ui/dialog", () => {
  const pass = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    Dialog: pass,
    DialogBody: pass,
    DialogDescription: pass,
    DialogFooter: pass,
    DialogHeader: pass,
    DialogTitle: pass,
    ConfirmDialog: (props: Record<string, unknown>) => {
      confirmProps.push(props);
      return null;
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }), signOut: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import {
  CLIENT_LINKS_REPLACED_EVENT,
  clientLinksButtonShown,
  requestClientLinksReplace,
  watchClientLinks,
  ClientLinksPanel,
  clientLinksReplacedMessage,
  demotedMessage,
  TeamSection,
} from "./team-section";

/**
 * R5-security L1: a former owner's copies of the client links keep working
 * until the remaining owners make new ones, in one press on the Team card.
 */

function team(role: "owner" | "member"): string {
  return renderToStaticMarkup(createElement(TeamSection, { workspaceId: "ws-1", role, workspaceName: "Surf Co" }));
}

const ON = { included: true, on: { upload: true, review: false, connect: false }, connectStopped: false };

function panel(state: Parameters<typeof ClientLinksPanel>[0]["state"]): string {
  confirmProps.length = 0;
  return renderToStaticMarkup(createElement(ClientLinksPanel, { state, onReplace: async () => {} }));
}

describe("Make new client links", () => {
  it("is shown while a client link is on and the plan includes them, saying why", () => {
    const html = panel(ON);
    expect(html).toContain("Make new client links");
    expect(html).toContain(
      "Someone who stops being an owner can still use the client upload, review and connect links they copied. New links stop the old ones working.",
    );
  });

  // R6 L2: not shown with nothing to replace, or on a plan without client links.
  it("is not shown with no client link on, on a plan without them, or before the state is read", () => {
    expect(clientLinksButtonShown(ON)).toBe(true);
    expect(clientLinksButtonShown({ ...ON, on: { upload: false, review: false, connect: true } })).toBe(true);
    expect(clientLinksButtonShown({ ...ON, on: { upload: false, review: false, connect: false } })).toBe(false);
    expect(clientLinksButtonShown({ ...ON, included: false })).toBe(false);
    expect(clientLinksButtonShown(null)).toBe(false);
    expect(panel({ ...ON, included: false })).toBe("");
    expect(panel(null)).toBe("");
  });

  it("asks first, as a destructive confirm", () => {
    panel(ON);
    expect(confirmProps).toHaveLength(1);
    expect(confirmProps[0]).toMatchObject({
      destructive: true,
      title: "Make new client links?",
      description:
        "The client links that are on stop working, including any copies a former owner kept. Send your client the new ones afterwards.",
      confirmText: "Make new links",
      open: false,
    });
  });

  // Check 3: the Connections card shows the new connect link without a reload.
  it("after a replace, tells the page so the connect link card reads its new link; a refusal tells nothing", async () => {
    const announce = vi.fn();
    const answer = { uploadLink: null, reviewLink: null, connectLink: { url: "https://app.example.com/c/NEW" } };
    const ok = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
    await expect(requestClientLinksReplace(ok as unknown as typeof fetch, "ws-1", announce)).resolves.toEqual(answer);
    expect(ok).toHaveBeenCalledWith("/api/workspaces/client-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-1" }),
    });
    expect(announce).toHaveBeenCalledTimes(1);

    announce.mockClear();
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: "Too many." }), { status: 429 }));
    await expect(requestClientLinksReplace(refused as unknown as typeof fetch, "ws-1", announce)).rejects.toThrow("Too many.");
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(requestClientLinksReplace(offline as unknown as typeof fetch, "ws-1", announce)).rejects.toThrow(
      "Couldn't reach the server. The old client links still work. Check your connection and try again.",
    );
    expect(announce).not.toHaveBeenCalled();
    expect(CLIENT_LINKS_REPLACED_EVENT).toBe("vibe:client-links-replaced");
  });

  it("the owners' Team card holds no button before the state is read, and a member's never", () => {
    expect(team("owner")).not.toContain("Make new client links");
    expect(team("member")).not.toContain("Make new client links");
  });

  it("says which links were made and where to copy them", () => {
    const both = { uploadLink: { url: "u" }, reviewLink: { url: "v" } };
    expect(clientLinksReplacedMessage(both)).toBe(
      "New client links are on and the old ones no longer work. Copy the upload link on the Media page and the review link on the Queue page, and send them to your client.",
    );
    expect(clientLinksReplacedMessage({ uploadLink: { url: "u" }, reviewLink: null })).toBe(
      "A new client upload link is on and the old one no longer works. Copy it on the Media page and send it to your client.",
    );
    expect(clientLinksReplacedMessage({ uploadLink: null, reviewLink: { url: "v" } })).toBe(
      "A new client review link is on and the old one no longer works. Copy it on the Queue page and send it to your client.",
    );
    expect(clientLinksReplacedMessage({ uploadLink: null, reviewLink: null })).toBe(
      "No client link was on, so there was nothing to replace.",
    );
  });

  // R6 M2: the connect link is replaced too.
  it("names the connect link when it was made again, or turned off", () => {
    const connect = { url: "c" };
    expect(clientLinksReplacedMessage({ uploadLink: { url: "u" }, reviewLink: { url: "v" }, connectLink: connect })).toBe(
      "New client links are on and the old ones no longer work. Copy the upload link on the Media page, the review link on the Queue page and the connect link under Connections, and send them to your client.",
    );
    expect(clientLinksReplacedMessage({ uploadLink: null, reviewLink: null, connectLink: connect })).toBe(
      "A new client connect link is on and the old one no longer works. Copy it under Connections and send it to your client.",
    );
    expect(clientLinksReplacedMessage({ uploadLink: { url: "u" }, reviewLink: null, connectLinkTurnedOff: true })).toBe(
      "A new client upload link is on and the old one no longer works. Copy it on the Media page and send it to your client. The client connect link is off: none of its platforms can be connected here any more. Make a new one under Connections if you need it.",
    );
    expect(clientLinksReplacedMessage({ uploadLink: null, reviewLink: null, connectLinkTurnedOff: true })).toBe(
      "The client connect link is off: none of its platforms can be connected here any more. Make a new one under Connections if you need it.",
    );
  });

  // Check 4: from the links' state read after the demotion, naming only the links that still work.
  it("after a demotion, names the links that still work and points to the button", () => {
    expect(demotedMessage({ ...ON, on: { upload: true, review: false, connect: true } })).toBe(
      "Role updated. They could copy the client upload and connect links, which still work. Press Make new client links below to replace them.",
    );
    expect(demotedMessage({ ...ON, on: { upload: false, review: true, connect: false } })).toBe(
      "Role updated. They could copy the client review link, which still works. Press Make new client links below to replace it.",
    );
    expect(demotedMessage({ ...ON, on: { upload: false, review: false, connect: false } })).toBe("Role updated.");
    expect(demotedMessage(null)).toBe("Role updated.");
    // A plan without client links: none of them works, and there is no button.
    expect(demotedMessage({ ...ON, included: false })).toBe("Role updated.");
  });

  it("a stopped connect link is not called working; the button gives the client a new one", () => {
    expect(demotedMessage({ ...ON, on: { upload: false, review: false, connect: true }, connectStopped: true })).toBe(
      "Role updated. The client connect link has stopped working, because the owner who made it is no longer an owner. Press Make new client links below to give your client a new one.",
    );
    expect(demotedMessage({ ...ON, on: { upload: true, review: false, connect: true }, connectStopped: true })).toBe(
      "Role updated. They could copy the client upload link, which still works. The client connect link has stopped working, because the owner who made it is no longer an owner. Press Make new client links below to replace them.",
    );
  });

  // R6-client-journey L3: someone who made themself a member no longer has the button.
  it("after demoting yourself, says only that the role changed", () => {
    expect(demotedMessage({ ...ON, on: { upload: true, review: true, connect: true } }, true)).toBe("Role updated.");
  });
});

// R6 review low 2: the button follows the connect link card on the same page.
describe("Make new client links follows the client links on the page", () => {
  const OFF = { included: true, on: { upload: false, review: false, connect: false }, connectStopped: false };
  const CONNECT_ON = { ...OFF, on: { ...OFF.on, connect: true } };

  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("first connect link turned on: the state is read again and the button appears; last link off: it hides", async () => {
    const answers = [CONNECT_ON, OFF];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(answers.shift()), { status: 200 }));
    const states: unknown[] = [];
    const stop = watchClientLinks("ws-1", (state) => states.push(state), fetchImpl as unknown as typeof fetch);

    announce("connect-link");
    await vi.waitFor(() => expect(states).toHaveLength(1));
    expect(fetchImpl).toHaveBeenCalledWith("/api/workspaces/client-links?workspaceId=ws-1");
    expect(clientLinksButtonShown(states[0] as typeof OFF)).toBe(true);

    announce("connect-link");
    await vi.waitFor(() => expect(states).toHaveLength(2));
    expect(clientLinksButtonShown(states[1] as typeof OFF)).toBe(false);

    stop();
    announce("connect-link");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("its own replace is not read again (the card already has the answer)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(OFF), { status: 200 }));
    watchClientLinks("ws-1", () => {}, fetchImpl as unknown as typeof fetch);
    announce("team");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function announce(source: "team" | "connect-link") {
  window.dispatchEvent(new CustomEvent(CLIENT_LINKS_REPLACED_EVENT, { detail: { source } }));
}
