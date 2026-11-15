import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Platform } from "@prisma/client";

// The dialogs read the address bar and the router; not what these tests are about.
vi.mock("./linkedin-setup-dialog", () => ({ LinkedInSetupDialog: () => null }));
vi.mock("./pending-connection-dialog", () => ({ PendingConnectionDialog: () => null }));
const actionProps = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("./connection-actions", () => ({
  ConnectionActions: (props: Record<string, unknown>) => {
    actionProps.push(props);
    return null;
  },
}));
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
  return renderToStaticMarkup(createElement(ConnectionsSection, { connections: [], workspaceId: "ws-1", ...props }));
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

// F3 (R1 security H1): a Connect in a tab rendered for one workspace must not
// connect the account to another; the start route checks this id.
describe("ConnectionsSection Connect links", () => {
  it("carry the workspace the page was rendered for", () => {
    const html = render({});
    const starts = [...html.matchAll(/href="(\/api\/auth\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    // LinkedIn's Connect is a button that opens a dialog (mocked here).
    expect(starts).toHaveLength(ALL.length - 1);
    for (const href of starts) expect(href).toMatch(/^\/api\/auth\/[a-z_]+\/start\?workspaceId=ws-1$/);
  });
});

describe("ConnectionsSection connected rows", () => {
  // R7-pages M2: LinkedIn's Reconnect names the account to sign in to.
  it("hands the row's actions the connected account's name", () => {
    actionProps.length = 0;
    render({ connections: [{ ...connected("linkedin"), username: "Surf Co page" }] });
    expect(actionProps[0]).toMatchObject({ platform: "linkedin", accountName: "Surf Co page" });
  });

  // R7-pages L7: the Ended sentence and three buttons must fit at 1024-1300 px.
  it("the actions block may shrink and wrap; it is never shrink-0", () => {
    const html = render({ connections: [connected("linkedin")] });
    const block = html.match(/<div class="([^"]*xl:justify-end[^"]*)">/);
    expect(block).not.toBeNull();
    const classes = block![1].split(" ");
    expect(classes).not.toContain("shrink-0");
    expect(classes).not.toContain("sm:shrink-0");
    expect(classes).not.toContain("md:shrink-0");
    expect(classes).toContain("min-w-0");
  });
});

// R7 review 1: the name column never collapses. Below xl the row stacks (name
// on top, state and buttons below, wrapping); from xl side by side, the name
// column keeping a minimum width and the actions wrapping.
describe("ConnectionsSection row layout per width", () => {
  const BREAKPOINTS: [string, number][] = [["sm", 640], ["md", 768], ["lg", 1024], ["xl", 1280], ["2xl", 1536]];

  /** The classes that apply at `width` px, later breakpoints overriding earlier ones (as Tailwind's order does). */
  function at(classes: string, width: number): Set<string> {
    const active = new Map<string, string>();
    const groupOf = (name: string) =>
      name.startsWith("flex-") && ["flex-row", "flex-col"].includes(name) ? "direction" : name.startsWith("min-w-") ? "min-w" : name;
    const ordered = classes.split(/\s+/).filter(Boolean).map((cls) => {
      const [prefix, rest] = cls.includes(":") ? [cls.slice(0, cls.indexOf(":")), cls.slice(cls.indexOf(":") + 1)] : ["", cls];
      const min = prefix === "" ? 0 : BREAKPOINTS.find(([p]) => p === prefix)?.[1] ?? Infinity;
      return { min, name: rest };
    });
    for (const { min, name } of ordered.sort((a, b) => a.min - b.min)) {
      if (width >= min) active.set(groupOf(name), name);
    }
    return new Set(active.values());
  }

  function rowClasses(): { row: string; name: string; actions: string } {
    const html = render({ connections: [{ ...connected("linkedin"), username: "A rather long company page name" }] });
    // The card's first child is the row.
    const row = /sm:p-5[^"]*"><div class="([^"]*)">/.exec(html)![1];
    const name = /<div class="(flex min-w-0 flex-1 items-start[^"]*)">/.exec(html)![1];
    const actions = /<div class="([^"]*flex-wrap items-center gap-2[^"]*)">/.exec(html)![1];
    return { row, name, actions };
  }

  it.each([360, 768, 1024])("%i px: stacked, the actions wrap below the name", (width) => {
    const { row, actions } = rowClasses();
    expect(at(row, width).has("flex-col")).toBe(true);
    expect(at(row, width).has("flex-row")).toBe(false);
    expect(at(actions, width).has("flex-wrap")).toBe(true);
  });

  it("1280 px: side by side, the name column keeps a minimum width, the actions wrap", () => {
    const { row, name, actions } = rowClasses();
    expect(at(row, 1280).has("flex-row")).toBe(true);
    expect(at(name, 1280).has("min-w-[12rem]")).toBe(true);
    expect(at(actions, 1280).has("flex-wrap")).toBe(true);
    expect(at(actions, 1280).has("shrink-0")).toBe(false);
  });
});

// R11-pages L2: a member's unconnected row says who can connect it.
describe("ConnectionsSection unconnected rows for a member", () => {
  const NOTE = "Not connected. The workspace owner can connect it.";

  it("a member reads that the owner can connect it, on every unconnected row and no connected one", () => {
    const html = render({ readOnly: true, connections: [connected("youtube")] });
    expect(html.split(NOTE).length - 1).toBe(ALL.length - 1);
  });

  it("the owner does not", () => {
    expect(render({})).not.toContain(NOTE);
  });
});

// R12 L2: a Business Profile connected without a location; only an owner has the form.
describe("ConnectionsSection, Google Business Profile without a location", () => {
  const gbp = { ...connected("google_business_profile"), username: null, accountIdentifier: "" } as ConnectionSummary;

  it("the owner: choose it below, as before", () => {
    expect(render({ connections: [gbp] })).toContain("Connected. Choose the Maps location to post to below.");
  });

  it("a member: who chooses it", () => {
    const html = render({ readOnly: true, connections: [gbp] });
    expect(html).toContain("Connected. The workspace owner chooses the Maps location.");
    expect(html).not.toContain("Choose the Maps location");
  });
});
