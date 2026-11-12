import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Platform } from "@prisma/client";

// The dialogs read the address bar and the router; not what these tests are about.
vi.mock("./linkedin-setup-dialog", () => ({ LinkedInSetupDialog: () => null }));
vi.mock("./pending-connection-dialog", () => ({ PendingConnectionDialog: () => null }));
vi.mock("./connection-actions", () => ({ ConnectionActions: () => null }));
vi.mock("./linkedin-account-dialog", () => ({ LinkedInConnectButton: () => null }));
vi.mock("./google-business-location-form", () => ({ GoogleBusinessLocationForm: () => null }));

import type { ConnectionSummary } from "@/lib/connectionSummary";
import { PLATFORM_GUIDES } from "@/lib/platformGuides";

import { ConnectionsSection } from "./connections-section";

/** S1 item 1: a platform's open review is said on its card before Connect. */

const ALL: Platform[] = ["youtube", "x", "tiktok", "pinterest", "instagram", "facebook_page", "linkedin", "google_business_profile"];

function connected(platform: Platform): ConnectionSummary {
  return { platform, accountIdentifier: "acct", username: "Some account", locationName: null, needsReconnect: false } as ConnectionSummary;
}

function render(props: { connections?: ConnectionSummary[]; readOnly?: boolean; unavailablePlatforms?: Platform[] }): string {
  return renderToStaticMarkup(createElement(ConnectionsSection, { connections: [], ...props }));
}

function escaped(text: string): string {
  return renderToStaticMarkup(createElement("span", null, text)).slice(6, -7);
}

describe("ConnectionsSection review notes", () => {
  it("shows each platform's review note on its unconnected card, with the setup guide link", () => {
    const html = render({});
    for (const platform of ALL) {
      const status = PLATFORM_GUIDES[platform].status;
      if (status) expect(html, platform).toContain(escaped(status));
      expect(html).toContain(`href="/help#${PLATFORM_GUIDES[platform].anchor}"`);
    }
  });

  it("drops the note once that platform is connected", () => {
    for (const platform of ALL) {
      const status = PLATFORM_GUIDES[platform].status;
      if (!status) continue;
      const html = render({ connections: [connected(platform)] });
      // Facebook and Instagram share Meta's note: the other one still shows it once.
      const shared = ALL.filter((p) => p !== platform && PLATFORM_GUIDES[p].status === status).length;
      expect(html.split(escaped(status)).length - 1, platform).toBe(shared);
    }
  });

  it("adds nothing for a platform with no review open", () => {
    const html = render({});
    const notes = ALL.map((p) => PLATFORM_GUIDES[p].status).filter(Boolean) as string[];
    const count = [...new Set(notes)].reduce((n, note) => n + html.split(escaped(note)).length - 1, 0);
    // One note per card that has a review open, none for YouTube, X and Pinterest.
    expect(count).toBe(notes.length);
    expect(html.match(/text-xs text-muted-foreground">/g)?.length).toBe(notes.length);
  });

  it("shows members no note (their cards cannot connect)", () => {
    const html = render({ readOnly: true });
    for (const platform of ALL) {
      const status = PLATFORM_GUIDES[platform].status;
      if (status) expect(html, platform).not.toContain(escaped(status));
    }
  });

  it("still leaves Pinterest out when it is not configured", () => {
    const html = render({ unavailablePlatforms: ["pinterest"] });
    expect(html).not.toContain("Pinterest");
  });
});
