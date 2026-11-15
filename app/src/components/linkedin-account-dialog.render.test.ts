import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/dialog", () => {
  const pass = ({ children }: { children?: ReactNode }) => children ?? null;
  return { Dialog: pass, DialogBody: pass, DialogDescription: pass, DialogFooter: pass, DialogHeader: pass, DialogTitle: pass };
});

import { LinkedInAccountDialog } from "./linkedin-account-dialog";

// R6-pages L3: Switch account says what happens to scheduled posts.
describe("LinkedIn Switch account dialog", () => {
  it("shows the scheduled-posts note it is given", () => {
    const html = renderToStaticMarkup(
      createElement(LinkedInAccountDialog, {
        workspaceId: "ws-1",
        open: true,
        onOpenChange: () => {},
        mode: "switch",
        scheduledNote: "Scheduled posts that chose LinkedIn go to the new account once you finish signing in.",
      }),
    );
    expect(html).toContain("Scheduled posts that chose LinkedIn go to the new account once you finish signing in.");
  });
});

// R7-pages M2: Reconnect goes through the same sign-out steps, naming the account to sign in to.
describe("LinkedIn Reconnect dialog", () => {
  function render(accountName?: string): string {
    return renderToStaticMarkup(
      createElement(LinkedInAccountDialog, {
        workspaceId: "ws-1",
        open: true,
        onOpenChange: () => {},
        mode: "reconnect",
        accountName,
      }),
    );
  }

  // R8-client-journey L2: the name is the company page, which nobody signs in to.
  it("says to sign out first, then sign in with an account that manages the page", () => {
    const html = render("Surf Co page");
    expect(html).toContain("Reconnect LinkedIn");
    expect(html).toContain("Open LinkedIn sign-out");
    expect(html).toContain(
      "Come back here and click Continue. LinkedIn asks you to sign in: sign in with a LinkedIn account that manages Surf Co page.",
    );
    expect(html).toContain("Already signed in to LinkedIn with an account that manages Surf Co page? Just click Continue.");
    expect(html).not.toContain("sign in to Surf Co page");
    expect(html).toContain(">Continue<");
    expect(html).not.toContain("post numbers");
  });

  it("without a name: the connected LinkedIn page", () => {
    expect(render()).toContain("sign in with a LinkedIn account that manages the connected LinkedIn page.");
  });

  it("Connect and Switch account keep their own words", () => {
    const html = renderToStaticMarkup(
      createElement(LinkedInAccountDialog, { workspaceId: "ws-1", open: true, onOpenChange: () => {}, mode: "connect" }),
    );
    expect(html).toContain("Connect LinkedIn");
    expect(html).toContain("use the account that manages your company page.");
  });
});
