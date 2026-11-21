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
      "Come back here and click Continue. LinkedIn asks you to sign in: sign in with a LinkedIn account that is a Super admin of Surf Co page.",
    );
    expect(html).toContain("Already signed in to LinkedIn with an account that manages Surf Co page? Just click Continue.");
    expect(html).not.toContain("sign in to Surf Co page");
    expect(html).toContain(">Continue<");
    expect(html).not.toContain("post numbers");
  });

  // Lead review (R26 pages L6): it opens a new tab, so it says so with the shared hint.
  it("Open LinkedIn sign-out shows the visible new-tab hint in its text", async () => {
    const { NEW_TAB_HINT } = await import("./external-link");
    const html = render();
    // The steps name the button in quotes; this is the button's own text.
    const at = html.indexOf(">Open LinkedIn sign-out ") + 1;
    expect(at).toBeGreaterThan(0);
    const button = html.slice(at, html.indexOf("</button>", at));
    expect(button).toMatch(/^Open LinkedIn sign-out <span class="[^"]*">/);
    expect(button.endsWith(`${NEW_TAB_HINT}</span>`)).toBe(true);
  });

  it("without a name: the connected LinkedIn page", () => {
    expect(render()).toContain("sign in with a LinkedIn account that is a Super admin of the connected LinkedIn page.");
  });

  it("Connect and Switch account keep their own words", () => {
    const html = renderToStaticMarkup(
      createElement(LinkedInAccountDialog, { workspaceId: "ws-1", open: true, onOpenChange: () => {}, mode: "connect" }),
    );
    expect(html).toContain("Connect LinkedIn");
    expect(html).toContain("use an account that is a Super admin of your company page.");
  });
});

// R27 MM3 (new-customer L4): Button is whitespace-nowrap, so "Open LinkedIn
// sign-out (opens in a new tab)" ran past the dialog at 375-390 px. It wraps
// and grows, as the Google sign-in link does (SignInAgainLinkView).
describe("LinkedIn dialog: the sign-out button on a phone", () => {
  it("wraps its text and grows instead of running past the dialog", () => {
    for (const mode of ["connect", "switch", "reconnect"] as const) {
      const html = renderToStaticMarkup(
        createElement(LinkedInAccountDialog, { workspaceId: "ws-1", open: true, onOpenChange: () => {}, mode }),
      );
      const at = html.lastIndexOf("<button", html.indexOf(">Open LinkedIn sign-out "));
      const classes = html.slice(at, html.indexOf(">", at)).match(/class="([^"]*)"/)![1].split(/\s+/);
      for (const cls of ["h-auto", "min-h-10", "flex-wrap", "whitespace-normal", "py-1.5"]) expect(classes, mode).toContain(cls);
      expect(classes, mode).not.toContain("whitespace-nowrap");
    }
  });
});

// R57 pages-b L2 (#282's rule): Connect repeats on every unconnected card, so LinkedIn's names its platform.
describe("LinkedIn Connect button", () => {
  it("is named Connect LinkedIn and keeps its text", async () => {
    const { LinkedInConnectButton } = await import("./linkedin-account-dialog");
    const html = renderToStaticMarkup(createElement(LinkedInConnectButton, { workspaceId: "ws-1" }));
    expect(html).toMatch(/aria-label="Connect LinkedIn"[^>]*>Connect<\/button>/);
  });
});
