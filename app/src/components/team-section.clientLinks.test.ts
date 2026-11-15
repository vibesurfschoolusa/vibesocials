import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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
  clientLinksButtonShown,
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

const ON = { included: true, on: { upload: true, review: false, connect: false } };

function panel(state: Parameters<typeof ClientLinksPanel>[0]["state"], freshConnectUrl: string | null = null): string {
  confirmProps.length = 0;
  return renderToStaticMarkup(
    createElement(ClientLinksPanel, { state, freshConnectUrl, onReplace: async () => {}, onCopyConnect: () => {} }),
  );
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
    expect(clientLinksButtonShown({ included: true, on: { upload: false, review: false, connect: true } })).toBe(true);
    expect(clientLinksButtonShown({ included: true, on: { upload: false, review: false, connect: false } })).toBe(false);
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

  it("shows a new connect link to copy, because the one under Connections is the old one until the page reloads", () => {
    const html = panel({ ...ON, on: { ...ON.on, connect: true } }, "https://app.example.com/c/NEW");
    expect(html).toContain('value="https://app.example.com/c/NEW"');
    expect(html).toContain('aria-label="New client connect link"');
    expect(html).toContain("Copy");
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
      "New client links are on and the old ones no longer work. Copy the upload link on the Media page, the review link on the Queue page and the connect link below, and send them to your client.",
    );
    expect(clientLinksReplacedMessage({ uploadLink: null, reviewLink: null, connectLink: connect })).toBe(
      "A new client connect link is on and the old one no longer works. Copy it below and send it to your client.",
    );
    expect(clientLinksReplacedMessage({ uploadLink: { url: "u" }, reviewLink: null, connectLinkTurnedOff: true })).toBe(
      "A new client upload link is on and the old one no longer works. Copy it on the Media page and send it to your client. The client connect link is off: none of its platforms can be connected here any more. Make a new one under Connections if you need it.",
    );
    expect(clientLinksReplacedMessage({ uploadLink: null, reviewLink: null, connectLinkTurnedOff: true })).toBe(
      "The client connect link is off: none of its platforms can be connected here any more. Make a new one under Connections if you need it.",
    );
  });

  it("after a demotion, points to the button when client links are on", () => {
    expect(demotedMessage({ ok: true, role: "member", clientLinksToReplace: true })).toBe(
      "Role updated. They could copy the client links, which still work: press Make new client links below to replace them.",
    );
    expect(demotedMessage({ ok: true, role: "member", clientLinksToReplace: false })).toBe("Role updated.");
    expect(demotedMessage(null)).toBe("Role updated.");
  });

  // R6-client-journey L3: someone who made themself a member no longer has the button.
  it("after demoting yourself, says only that the role changed", () => {
    expect(demotedMessage({ ok: true, role: "member", clientLinksToReplace: true }, true)).toBe("Role updated.");
  });
});
