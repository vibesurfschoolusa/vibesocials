import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { ConnectionActions, endsAtText } from "./connection-actions";

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
    sameEndAt?: string | null;
    endsAt?: string | null;
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
    expect(html).toMatch(/<span class="[^"]*basis-full[^"]*">Ended November 12, 2026, 12:00 UTC. Reconnect to keep posting.<\/span>/);
    expect(html).toMatch(RECONNECT_BUTTON);
    expect(reconnectDialogProps()).toMatchObject({ mode: "reconnect" });
    expect(html).not.toContain("Ends soon");
  });

  // R8-pages L5: just reconnected, and LinkedIn kept the end date: said, without asking for another Reconnect.
  // R11 review: the same words as /c, in UTC and labelled, so server and browser render the same text.
  it("endsAtText: the date and a 24-hour time in UTC, labelled", () => {
    expect(endsAtText("2026-11-21T01:00:00.000Z")).toBe("November 21, 2026, 01:00 UTC");
    expect(endsAtText("2026-11-20T23:05:59.000Z")).toBe("November 20, 2026, 23:05 UTC");
    expect(endsAtText("not a date")).toBe("");
  });

  it("same end date after a reconnect: Ends <date>. LinkedIn kept this end date.", () => {
    const html = row({ reconnectSoon: true, sameEndAt: "2026-11-16T12:00:00.000Z" });
    // R11 follow-up: date and time with the viewer's zone name, so it can't read as another day than /c's UTC line.
    expect(html).toMatch(
      /<span class="[^"]*basis-full[^"]*">Ends November 16, 2026, 12:00 UTC\. LinkedIn kept this end date\.<\/span>/,
    );
    expect(html).not.toContain("Ends soon");
    expect(html).not.toContain("Reconnect to keep posting");
    // Still there for after the date, or a sign-out and a new sign-in.
    expect(html).toMatch(RECONNECT_BUTTON);
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
    expect(html).toContain("Ended November 12, 2026, 12:00 UTC. The workspace owner can reconnect it.");
    expect(html).not.toContain(">Connected<");
    expect(html).not.toContain("Ends soon");
    expect(html).not.toContain("<button");
  });

  it("a member: healthy -> Connected as before", () => {
    expect(row({ readOnly: true })).toContain(">Connected<");
  });

  // R12-pages L3: a flagged row says who can reconnect it, after the badge.
  it("a member: needs reconnecting -> the badge, then who can reconnect it", () => {
    const html = row({ readOnly: true, needsReconnect: true, platform: "instagram" });
    expect(html).toContain("Needs reconnect");
    expect(html).toContain("The workspace owner can reconnect it.");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
  });
});

// R12-pages L4: "Ended" is written in UTC like the Ends line (endsAtText), so the
// server and a browser in another zone render the same text.
describe("Settings connection row, Ended in UTC", () => {
  const ORIGINAL_TZ = process.env.TZ;
  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  for (const timeZone of ["UTC", "America/Chicago", "Asia/Tokyo"]) {
    it(`an end at 01:00 UTC reads the same in ${timeZone}, for an owner and a member`, () => {
      process.env.TZ = timeZone;
      const endedAt = "2026-11-21T01:00:00.000Z";
      expect(row({ reconnectSoon: true, endedAt })).toContain(
        "Ended November 21, 2026, 01:00 UTC. Reconnect to keep posting.",
      );
      expect(row({ reconnectSoon: true, endedAt, readOnly: true })).toContain(
        "Ended November 21, 2026, 01:00 UTC. The workspace owner can reconnect it.",
      );
    });
  }
});

// R13-pages L3: a member's Ends soon row says when (UTC, endsAtText) and who reconnects it.
describe("Settings connection row, a member's Ends soon", () => {
  it("with the end time: the badge, the end in UTC and who can reconnect it", () => {
    const html = row({ readOnly: true, reconnectSoon: true, endsAt: "2026-11-21T01:00:00.000Z" });
    expect(html).toContain("Ends soon");
    expect(html).toContain("Ends November 21, 2026, 01:00 UTC. The workspace owner can reconnect it.");
    expect(html).not.toContain("<button");
  });

  it("without the end time: still names who can reconnect it", () => {
    const html = row({ readOnly: true, reconnectSoon: true });
    expect(html).toContain("Ends soon");
    expect(html).toContain("The workspace owner can reconnect it.");
  });

  it("the owner's row is unchanged (its Reconnect button says what to do)", () => {
    const html = row({ reconnectSoon: true, endsAt: "2026-11-21T01:00:00.000Z" });
    expect(html).toContain("Ends soon");
    expect(html).not.toContain("The workspace owner");
  });
});

// R57 pages-b L2 (#282's rule): every connected row repeats these, so each
// one's name starts with its text and names the platform.
describe("Settings connection row names its platform", () => {
  it("Switch account and Disconnect", () => {
    for (const [platform, label] of [["linkedin", "LinkedIn"], ["instagram", "Instagram"]] as const) {
      const html = row({ platform });
      expect(html).toMatch(new RegExp(`aria-label="Switch account ${label}"[^>]*>Switch account</button>`));
      expect(html).toMatch(new RegExp(`aria-label="Disconnect ${label}"[^>]*>Disconnect</button>`));
    }
  });

  it("Reconnect, LinkedIn's button and another platform's link", () => {
    expect(row({ platform: "linkedin", needsReconnect: true })).toMatch(/aria-label="Reconnect LinkedIn"[^>]*>Reconnect<\/button>/);
    expect(row({ platform: "x", needsReconnect: true })).toMatch(/aria-label="Reconnect X"[^>]*>Reconnect<\/a>/);
    expect(row({ platform: "x", reconnectSoon: true, endsAt: "2026-12-01T00:00:00.000Z" })).toMatch(
      /aria-label="Reconnect X"[^>]*>Reconnect<\/a>/,
    );
  });
});
