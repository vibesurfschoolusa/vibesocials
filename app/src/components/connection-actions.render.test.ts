import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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

function row(props: { needsReconnect?: boolean; reconnectSoon?: boolean; readOnly?: boolean } = {}): string {
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

  it("flagged: the danger Reconnect as before", () => {
    const html = row({ needsReconnect: true, reconnectSoon: false });
    expect(html).toMatch(RECONNECT_LINK);
    expect(html).not.toContain("Ends soon");
  });

  it("a member sees the status and no button", () => {
    expect(row({ readOnly: true, reconnectSoon: true })).not.toContain("Reconnect");
    expect(row({ readOnly: true, needsReconnect: true })).toContain("Needs reconnect");
  });
});
