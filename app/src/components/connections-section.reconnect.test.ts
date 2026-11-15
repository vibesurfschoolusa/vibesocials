import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The real ConnectionActions renders; only its dialogs and hooks are stubbed.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: () => null,
  DialogBody: () => null,
  DialogDescription: () => null,
  DialogFooter: () => null,
  DialogHeader: () => null,
  DialogTitle: () => null,
  ConfirmDialog: () => null,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings",
}));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock("./linkedin-setup-dialog", () => ({ LinkedInSetupDialog: () => null }));
vi.mock("./pending-connection-dialog", () => ({ PendingConnectionDialog: () => null }));
vi.mock("./google-business-location-form", () => ({ GoogleBusinessLocationForm: () => null }));

import type { ConnectionSummary } from "@/lib/connectionSummary";

import { ConnectionsSection } from "./connections-section";

/** R6-pages M1: Settings shows Reconnect for a LinkedIn connection in its warning window. */

const LINKEDIN: ConnectionSummary = {
  platform: "linkedin",
  accountIdentifier: "li-1",
  username: "Surf Co page",
  locationName: null,
  needsReconnect: false,
};

function linkedInRow(
  reconnectSoon: ("linkedin" | "youtube")[],
  endedAt: Record<string, string> = {},
  sameEndAt: Record<string, string> = {},
): string {
  const html = renderToStaticMarkup(
    createElement(ConnectionsSection, { workspaceId: "ws-1", connections: [LINKEDIN], reconnectSoon, endedAt, sameEndAt }),
  );
  // The LinkedIn card: from its label to the next card.
  const start = html.indexOf("Surf Co page");
  return html.slice(start, start + 4000);
}

// R7-pages M2: LinkedIn's Reconnect is a button that opens the sign-out steps
// (the dialog, stubbed here, then starts the sign-in); never a link straight to it.
const RECONNECT = /<button[^>]*>Reconnect<\/button>/;
const START = "/api/auth/linkedin/start";

describe("Settings, Connections: a LinkedIn connection about to end", () => {
  it("in its warning window: Ends soon and a Reconnect that opens the sign-out steps", () => {
    const html = linkedInRow(["linkedin"]);
    expect(html).toMatch(RECONNECT);
    expect(html).not.toContain(START);
    expect(html).toContain("Ends soon");
  });

  it("its end date has passed (not flagged yet): Ended <date>", () => {
    const html = linkedInRow(["linkedin"], { linkedin: "2026-11-12T12:00:00.000Z" });
    expect(html).toContain("Ended November 12, 2026. Reconnect to keep posting.");
    expect(html).toMatch(RECONNECT);
  });

  // R8-pages L5: the page passes the kept end date down to the row.
  it("just reconnected with the same end date: the row says LinkedIn kept it", () => {
    const html = linkedInRow(["linkedin"], {}, { linkedin: "2026-11-16T12:00:00.000Z" });
    expect(html).toContain("Ends November 16, 2026. LinkedIn kept this end date.");
    expect(html).not.toContain("Ends soon");
  });

  it("far from its expiry (another platform in the list): Connected, no Reconnect", () => {
    const html = linkedInRow(["youtube"]);
    expect(html).not.toMatch(RECONNECT);
    expect(html).toContain("Connected");
  });
});
