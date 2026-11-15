import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConnectionHealth } from "./connection-health";

/**
 * Dashboard Connections card. 2026-11-14: at the shared page width each row's
 * green dot plus a "Connected" badge made long names wrap ("Google Business
 * Profile"); a healthy row now shows one check, named for screen readers.
 */

type Row = { platform: string; connected: boolean; needsReconnect?: boolean; expiry?: "ends_soon" | "ended" | null };

function render(connections: Row[]) {
  return renderToStaticMarkup(
    createElement(ConnectionHealth, {
      connections: connections as never,
      loading: false,
      error: null,
    }) as ReactElement,
  );
}

function rowFor(html: string, label: string): string {
  const start = html.indexOf(`>${label}<`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</li>", start));
}

describe("ConnectionHealth rows", () => {
  it("a healthy connection shows a check that reads Connected, and no badge", () => {
    const row = rowFor(render([{ platform: "google_business_profile", connected: true }]), "Google Business Profile");
    expect(row).toContain('<span class="sr-only">Connected</span>');
    expect(row).toContain('title="Connected"');
    expect(row.match(/Connected/g)).toHaveLength(2); // the title and the screen-reader text
  });

  it("a connection that needs reconnecting keeps its Reconnect button", () => {
    const row = rowFor(render([{ platform: "linkedin", connected: true, needsReconnect: true }]), "LinkedIn");
    // F3: the dashboard is not rendered for one workspace, so its Reconnect
    // goes to Settings, whose Reconnect carries the workspace id.
    expect(row).toContain('href="/settings#connections"');
    expect(row).not.toContain("/api/auth/");
    expect(row).toContain("Reconnect");
    expect(row).not.toContain("sr-only");
  });

  it("a platform that is not connected keeps its Connect link", () => {
    const row = rowFor(render([{ platform: "tiktok", connected: false }]), "TikTok");
    expect(row).toContain(">Connect</a>");
    expect(row).not.toContain("Connected");
  });

  it("still counts connected platforms in the description", () => {
    const html = render([
      { platform: "tiktok", connected: true },
      { platform: "youtube", connected: false },
    ]);
    expect(html).toContain("1 of 2 platforms connected");
  });
});

// R7-pages L4 / client-journey L3: the warning window and the end show here too.
describe("ConnectionHealth: connections that end", () => {
  it("ends soon: says so, links to Settings, not a check", () => {
    const row = rowFor(render([{ platform: "linkedin", connected: true, expiry: "ends_soon" }]), "LinkedIn");
    expect(row).toContain("Ends soon");
    expect(row).toContain('href="/settings#connections"');
    expect(row).not.toContain("sr-only");
  });

  it("ended: says so, links to Settings, not a check", () => {
    const row = rowFor(render([{ platform: "linkedin", connected: true, expiry: "ended" }]), "LinkedIn");
    expect(row).toContain("Ended");
    expect(row).not.toContain("Ends soon");
    expect(row).toContain('href="/settings#connections"');
    expect(row).not.toContain("sr-only");
  });

  it("healthy with no expiry: the check as before", () => {
    const row = rowFor(render([{ platform: "linkedin", connected: true, expiry: null }]), "LinkedIn");
    expect(row).toContain('<span class="sr-only">Connected</span>');
  });
});

// R11-client-journey L2: only the owner can connect or reconnect, so a member
// reads each row's state as a badge, with no buttons into Settings.
describe("ConnectionHealth for a member", () => {
  function renderMember(connections: Row[]) {
    return renderToStaticMarkup(
      createElement(ConnectionHealth, {
        connections: connections as never,
        loading: false,
        error: null,
        isMember: true,
      }) as ReactElement,
    );
  }

  const ROWS: Row[] = [
    { platform: "tiktok", connected: false },
    { platform: "linkedin", connected: true, needsReconnect: true },
    { platform: "youtube", connected: true, expiry: "ends_soon" },
    { platform: "instagram", connected: true, expiry: "ended" },
    { platform: "x", connected: true },
  ];

  it("no link into Settings anywhere on the card, and no Manage connections", () => {
    const html = renderMember(ROWS);
    expect(html).not.toContain("<a");
    expect(html).not.toContain("Manage connections");
  });

  it("each state is a badge: Not connected, Needs reconnecting, Ends soon, Ended", () => {
    const html = renderMember(ROWS);
    expect(rowFor(html, "TikTok")).toContain("Not connected");
    expect(rowFor(html, "LinkedIn")).toContain("Needs reconnecting");
    expect(rowFor(html, "YouTube")).toContain("Ends soon");
    expect(rowFor(html, "Instagram")).toContain("Ended");
    expect(rowFor(html, "X")).toContain('<span class="sr-only">Connected</span>');
  });

  it("says the owner connects and reconnects", () => {
    expect(renderMember(ROWS)).toContain("The workspace owner can connect and reconnect accounts for this workspace.");
  });

  it("the owner keeps the buttons", () => {
    const html = render(ROWS);
    expect(html).toContain("Manage connections");
    expect(rowFor(html, "TikTok")).toContain(">Connect</a>");
    expect(html).not.toContain("The workspace owner can");
  });
});
