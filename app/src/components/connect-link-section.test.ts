import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { ConnectLinkSection, ConnectLinkSectionView, type ConnectLinkViewProps } from "./connect-link-section";

function view(overrides: Partial<ConnectLinkViewProps> = {}): string {
  const props: ConnectLinkViewProps = {
    available: ["tiktok", "instagram"],
    link: null,
    selected: ["tiktok"],
    busy: false,
    onToggle: () => {},
    onCreate: () => {},
    onCopy: () => {},
    onRevoke: () => {},
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

  it("with a link: the address with Copy, the expiry, the last use and Revoke", () => {
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
    expect(html).toContain("Revoke");
    expect(html).toContain("Offers: TikTok");
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

  it("with nothing configured on this site, says so instead of offering boxes", () => {
    const html = view({ available: [], selected: [] });
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain("No platform can be connected on this site yet.");
  });

  it("members do not see the group", () => {
    expect(renderToStaticMarkup(createElement(ConnectLinkSection, { workspaceId: "ws-1", isOwner: false }))).toBe("");
  });
});
