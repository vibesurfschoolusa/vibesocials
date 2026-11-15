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
