import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/dialog", () => {
  const pass = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    Dialog: pass,
    DialogBody: pass,
    DialogDescription: pass,
    DialogFooter: pass,
    DialogHeader: pass,
    DialogTitle: pass,
    ConfirmDialog: () => null,
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }), signOut: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { clientLinksReplacedMessage, demotedMessage, TeamSection } from "./team-section";

/**
 * R5-security L1: a former owner's copies of the client links keep working
 * until the remaining owners make new ones, in one press on the Team card.
 */

function team(role: "owner" | "member"): string {
  return renderToStaticMarkup(createElement(TeamSection, { workspaceId: "ws-1", role, workspaceName: "Surf Co" }));
}

describe("Make new client links", () => {
  it("is on the owners' Team card, saying why", () => {
    const html = team("owner");
    expect(html).toContain("Make new client links");
    expect(html).toContain(
      "Someone who stops being an owner can still use the client upload and review links they copied. New links stop the old ones working.",
    );
  });

  it("is not on a member's card", () => {
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

  it("after a demotion, points to the button when client links are on", () => {
    expect(demotedMessage({ ok: true, role: "member", clientLinksToReplace: true })).toBe(
      "Role updated. They could copy the client links, which still work: press Make new client links below to replace them.",
    );
    expect(demotedMessage({ ok: true, role: "member", clientLinksToReplace: false })).toBe("Role updated.");
    expect(demotedMessage(null)).toBe("Role updated.");
  });
});
