import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  props: {
    platform?: string;
    accountName?: string;
    needsReconnect?: boolean;
    reconnectSoon?: boolean;
    endedAt?: string | null;
    readOnly?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(ConnectionActions, { platform: "linkedin", workspaceId: "ws-1", isConnected: true, ...props }),
  );
}

const START = 'href="/api/auth/linkedin/start?workspaceId=ws-1"';
const RECONNECT_BUTTON = /<button[^>]*>Reconnect<\/button>/;

function reconnectDialogProps(): Record<string, unknown> | undefined {
  return linkedInDialogProps.find((props) => props.mode === "reconnect");
}

describe("Settings connection row", () => {
  beforeEach(() => {
    linkedInDialogProps.length = 0;
  });

  it("healthy, far from expiry: Connected, no Reconnect", () => {
    const html = row();
    expect(html).toContain("Connected");
    expect(html).not.toContain("Reconnect");
    expect(html).not.toContain(START);
    expect(reconnectDialogProps()).toBeUndefined();
  });

  // R7-pages M2: LinkedIn reuses the browser's signed-in account, so Reconnect
  // goes through the sign-out steps, as Connect and Switch account do.
  it("inside the warning window: LinkedIn Reconnect opens the sign-out steps, then the sign-in; says why", () => {
    const html = row({ reconnectSoon: true, accountName: "Surf Co page" });
    expect(html).toMatch(RECONNECT_BUTTON);
    expect(html).not.toContain(START);
    expect(reconnectDialogProps()).toMatchObject({ mode: "reconnect", accountName: "Surf Co page", workspaceId: "ws-1" });
    // Nothing is disconnected before it: the save updates the row in place.
    expect(reconnectDialogProps()?.beforeContinue).toBeUndefined();
    expect(html).toContain("Ends soon");
    expect(html).not.toContain(">Connected<");
    // Switch account and Disconnect are still there, for a different account.
    expect(html).toContain("Switch account");
    expect(html).toContain("Disconnect");
  });

  // R6 review low 3: the end date has passed but the sweep has not flagged it yet.
  it("ended, not flagged yet: says when it ended on its own line, with Reconnect, not Ends soon", () => {
    const html = row({ reconnectSoon: true, endedAt: "2026-11-12T12:00:00.000Z" });
    expect(html).toMatch(/<span class="[^"]*basis-full[^"]*">Ended November 12, 2026. Reconnect to keep posting.<\/span>/);
    expect(html).toMatch(RECONNECT_BUTTON);
    expect(reconnectDialogProps()).toMatchObject({ mode: "reconnect" });
    expect(html).not.toContain("Ends soon");
  });

  it("flagged LinkedIn: the danger Reconnect opens the steps too", () => {
    const html = row({ needsReconnect: true, reconnectSoon: false });
    expect(html).toMatch(RECONNECT_BUTTON);
    expect(html).not.toContain(START);
    expect(reconnectDialogProps()).toMatchObject({ mode: "reconnect" });
    expect(html).not.toContain("Ends soon");
  });

  it("other platforms: Reconnect still goes straight to the sign-in", () => {
    const html = row({ platform: "youtube", needsReconnect: true });
    expect(html).toMatch(/<a href="\/api\/auth\/youtube\/start\?workspaceId=ws-1"[^>]*>Reconnect<\/a>/);
    expect(reconnectDialogProps()).toBeUndefined();
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

  // R7-pages L4: the member view shows the warning window and the end, as the owner's does.
  it("a member: ends within the window -> Ends soon, not Connected", () => {
    const html = row({ readOnly: true, reconnectSoon: true });
    expect(html).toContain("Ends soon");
    expect(html).not.toContain(">Connected<");
    expect(html).not.toContain("<button");
  });

  it("a member: ended, not flagged yet -> Ended with the date, not Connected", () => {
    const html = row({ readOnly: true, reconnectSoon: true, endedAt: "2026-11-12T12:00:00.000Z" });
    expect(html).toContain("Ended November 12, 2026. The workspace owner can reconnect it.");
    expect(html).not.toContain(">Connected<");
    expect(html).not.toContain("Ends soon");
    expect(html).not.toContain("<button");
  });

  it("a member: healthy -> Connected as before", () => {
    expect(row({ readOnly: true })).toContain(">Connected<");
  });
});
