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

type Row = { platform: string; connected: boolean; needsReconnect?: boolean };

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
    expect(row).not.toMatch(/>\s*Connected\s*<\/(div|span)>\s*$/);
    expect(row.match(/Connected/g)).toHaveLength(2); // the title and the screen-reader text
  });

  it("a connection that needs reconnecting keeps its Reconnect button", () => {
    const row = rowFor(render([{ platform: "linkedin", connected: true, needsReconnect: true }]), "LinkedIn");
    expect(row).toContain('href="/api/auth/linkedin/start"');
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
