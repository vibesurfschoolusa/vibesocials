import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { changeConnectLink, ConnectLinkSection, ConnectLinkSectionView, type ConnectLinkViewProps } from "./connect-link-section";

function view(overrides: Partial<ConnectLinkViewProps> = {}): string {
  const props: ConnectLinkViewProps = {
    available: ["tiktok", "instagram"],
    link: null,
    selected: ["tiktok"],
    busy: false,
    onToggle: () => {},
    onCreate: () => {},
    onCopy: () => {},
    onReplace: () => {},
    onTurnOff: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(createElement(ConnectLinkSectionView, props));
}

describe("the Client connect link group in Settings", () => {
  it("says what it is, offers a tick box per configured platform, and Create link", () => {
    const html = view();
    expect(html).toContain("Client connect link");
    expect(html).toMatch(/connect their own accounts to this workspace/);
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain("TikTok");
    expect(html).toContain("Instagram");
    expect(html).toContain("Create link");
    expect(html).toContain(
      "Facebook, Instagram and the other platforms let people outside your team connect only after the platform has approved this app.",
    );
  });

  it("with a link: the address with Copy, the expiry, the last use, Replace link and Turn off", () => {
    const html = view({
      link: {
        url: "https://vibesocials.example/c/abc",
        platforms: ["tiktok"],
        expiresAt: "2026-11-25T08:00:00.000Z",
        lastUsedAt: null,
        createdAt: "2026-11-11T08:00:00.000Z",
      },
    });
    expect(html).toContain('value="https://vibesocials.example/c/abc"');
    expect(html).toContain("Copy");
    expect(html).toMatch(/Expires on [^<]*2026/);
    expect(html).toContain("Not used yet");
    expect(html).toContain("Replace link");
    expect(html).toContain("Turn off");
    expect(html).not.toContain("Revoke");
    expect(html).toContain("Offers: TikTok");
  });

  // R5-pages L4: as the review and upload link panels.
  it("says, as the other link panels, that a link can't be shown again and how to get a new one", () => {
    const html = view({
      link: {
        url: null,
        platforms: ["tiktok"],
        expiresAt: "2026-11-25T08:00:00.000Z",
        lastUsedAt: null,
        createdAt: "2026-11-11T08:00:00.000Z",
      },
    });
    expect(html).toContain("This link can&#x27;t be shown again. Replace it to get a new one.");
    expect(html).toContain("Replace link");
    expect(html).toContain("Turn off");
  });

  it("offers no Replace link while the plan pauses the link, only Turn off", () => {
    const html = view({
      pausedByPlan: true,
      link: {
        url: "https://vibesocials.example/c/abc",
        platforms: ["tiktok"],
        expiresAt: "2026-11-25T08:00:00.000Z",
        lastUsedAt: null,
        createdAt: "2026-11-11T08:00:00.000Z",
      },
    });
    expect(html).not.toContain("Replace link");
    expect(html).toContain("Turn off");
  });

  it("renders the confirm dialog it is given inside the card", () => {
    const html = view({ dialog: createElement("div", { id: "confirm-slot" }) });
    expect(html).toContain('id="confirm-slot"');
  });

  it("names the last use when there was one", () => {
    const html = view({
      link: {
        url: "https://vibesocials.example/c/abc",
        platforms: ["tiktok"],
        expiresAt: "2026-11-25T08:00:00.000Z",
        lastUsedAt: "2026-11-12T08:00:00.000Z",
        createdAt: "2026-11-11T08:00:00.000Z",
      },
    });
    expect(html).toMatch(/Last used [^<]*2026/);
  });

  // R6-pages L8: the same date format as Account and Team.
  it("writes its dates as the rest of Settings does", () => {
    const html = view({
      link: {
        url: "https://vibesocials.example/c/abc",
        platforms: ["tiktok"],
        expiresAt: "2026-11-25T12:00:00.000Z",
        lastUsedAt: "2026-11-12T12:00:00.000Z",
        createdAt: "2026-11-11T12:00:00.000Z",
      },
    });
    expect(html).toContain("Expires on November 25, 2026");
    expect(html).toContain("Last used November 12, 2026");
  });

  it("with nothing configured on this site, says so instead of offering boxes", () => {
    const html = view({ available: [], selected: [] });
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain("No platform can be connected on this site yet.");
  });

  it("members do not see the group", () => {
    expect(renderToStaticMarkup(createElement(ConnectLinkSection, { workspaceId: "ws-1", isOwner: false }))).toBe("");
  });

  // S2 fix round 2: the connect-link anchor lives on Settings' server-rendered
  // wrapper (settings/page.tsx), not here, so it is never duplicated.
  it("carries no connect-link anchor of its own", () => {
    expect(view()).not.toContain('id="connect-link"');
  });
});

// R6 review low 2: a link made, replaced or turned off here is announced, so
// the Team card's "Make new client links" follows it without a reload.
describe("changeConnectLink", () => {
  const LINK_DTO = {
    url: "https://app.example.com/c/NEW",
    platforms: ["tiktok"],
    expiresAt: "2026-11-28T10:00:00.000Z",
    lastUsedAt: null,
    createdAt: "2026-11-14T10:00:00.000Z",
  };

  it("made (or replaced): answers the link and announces it", async () => {
    const announce = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ link: LINK_DTO }), { status: 200 }));
    await expect(
      changeConnectLink(fetchImpl as unknown as typeof fetch, "POST", { workspaceId: "ws-1", platforms: ["tiktok"] }, announce),
    ).resolves.toEqual({ ok: true, link: LINK_DTO });
    expect(fetchImpl).toHaveBeenCalledWith("/api/workspaces/connect-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-1", platforms: ["tiktok"] }),
    });
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("turned off: announces it", async () => {
    const announce = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(changeConnectLink(fetchImpl as unknown as typeof fetch, "DELETE", { workspaceId: "ws-1" }, announce)).resolves.toEqual({
      ok: true,
      link: null,
    });
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("refused: the route's sentence, and nothing announced", async () => {
    const announce = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "Pick a platform." }), { status: 400 }));
    await expect(changeConnectLink(fetchImpl as unknown as typeof fetch, "POST", { workspaceId: "ws-1" }, announce)).resolves.toEqual({
      ok: false,
      error: "Pick a platform.",
    });
    expect(announce).not.toHaveBeenCalled();
  });
});
