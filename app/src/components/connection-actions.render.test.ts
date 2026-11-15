import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const linkedInDialogProps: Record<string, unknown>[] = [];
vi.mock("./linkedin-account-dialog", () => ({
  LinkedInAccountDialog: (props: Record<string, unknown>) => {
    linkedInDialogProps.push(props);
    return null;
  },
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: () => null,
  DialogBody: () => null,
  DialogDescription: () => null,
  DialogFooter: () => null,
  DialogHeader: () => null,
  DialogTitle: () => null,
  ConfirmDialog: () => null,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { ConnectionActions } from "./connection-actions";

/**
 * R6-pages M1: inside the warning window (lib/connectionExpiry.ts) Settings
 * shows Reconnect, a plain link straight to the platform's sign-in: nothing is
 * disconnected first, so the post numbers stay and the save updates the row.
 */

function row(
  props: { needsReconnect?: boolean; reconnectSoon?: boolean; endedAt?: string | null; readOnly?: boolean } = {},
): string {
  return renderToStaticMarkup(
    createElement(ConnectionActions, { platform: "linkedin", workspaceId: "ws-1", isConnected: true, ...props }),
  );
}

const START = 'href="/api/auth/linkedin/start?workspaceId=ws-1"';
const RECONNECT_LINK = /<a href="\/api\/auth\/linkedin\/start\?workspaceId=ws-1"[^>]*>Reconnect<\/a>/;

describe("Settings connection row", () => {
  it("healthy, far from expiry: Connected, no Reconnect", () => {
    const html = row();
    expect(html).toContain("Connected");
    expect(html).not.toContain("Reconnect");
    expect(html).not.toContain(START);
  });

  it("inside the warning window: Reconnect goes straight to the sign-in, and says why", () => {
    const html = row({ reconnectSoon: true });
    expect(html).toMatch(RECONNECT_LINK);
    expect(html).toContain("Ends soon");
    expect(html).not.toContain(">Connected<");
    // Switch account and Disconnect are still there, for a different account.
    expect(html).toContain("Switch account");
    expect(html).toContain("Disconnect");
  });

  // R6 review low 3: the end date has passed but the sweep has not flagged it yet.
  it("ended, not flagged yet: says when it ended, with Reconnect, not Ends soon", () => {
    const html = row({ reconnectSoon: true, endedAt: "2026-11-12T12:00:00.000Z" });
    expect(html).toContain("Ended November 12, 2026. Reconnect to keep posting.");
    expect(html).toMatch(RECONNECT_LINK);
    expect(html).not.toContain("Ends soon");
  });

  it("flagged: the danger Reconnect as before", () => {
    const html = row({ needsReconnect: true, reconnectSoon: false });
    expect(html).toMatch(RECONNECT_LINK);
    expect(html).not.toContain("Ends soon");
  });

  it("Switch account for LinkedIn tells what happens to scheduled posts", () => {
    linkedInDialogProps.length = 0;
    row();
    expect(linkedInDialogProps[0]).toMatchObject({
      mode: "switch",
      scheduledNote:
        "Scheduled posts that chose LinkedIn go to the new account once you finish signing in. If you stop before then, they fail on LinkedIn until you connect an account again.",
    });
  });

  it("a member sees the status and no button", () => {
    expect(row({ readOnly: true, reconnectSoon: true })).not.toContain("Reconnect");
    expect(row({ readOnly: true, needsReconnect: true })).toContain("Needs reconnect");
  });
});
