import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import {
  CONNECT_LINK_MAYBE_MADE_MESSAGE,
  CONNECT_LINK_MAYBE_OFF_MESSAGE,
  changeConnectLink,
  ConnectLinkSection,
  REPLACE_NONE_OFFERED_MESSAGE,
  replaceDescription,
  replacePlatforms,
  ConnectLinkSectionView,
  type ConnectLinkViewProps,
} from "./connect-link-section";

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

// Lead review 2 (R28 NN2): the route turns the old link off before it
// answers, so a lost answer (or a gateway's 5xx) may have replaced it or
// turned it off. The panel says so and reads the link again; offline at the
// press nothing was sent.
describe("changeConnectLink when the answer is lost", () => {
  it("no answer or an unreadable 5xx: lost, and the Team card is told to read again", async () => {
    for (const fetchImpl of [
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
      vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })),
    ]) {
      const announce = vi.fn();
      await expect(
        changeConnectLink(fetchImpl as unknown as typeof fetch, "DELETE", { workspaceId: "ws-1" }, announce, () => true),
      ).resolves.toEqual({ ok: false, error: null, lost: true });
      expect(announce).toHaveBeenCalledTimes(1);
    }
  });

  // R29 OO1 (client-journey L4): the route turned the old link off and made a
  // new one; only its answer can't be read. As Queue and Media do: lost.
  it("an OK answer to Make whose link can't be read, or a 5xx with no sentence: lost, and the Team card is told to read again", async () => {
    for (const fetchImpl of [
      vi.fn(async () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } })),
      vi.fn(async () => Response.json({ ok: true }, { status: 200 })),
      // A 5xx with no sentence of the route's: it may have gone through too.
      vi.fn(async () => Response.json({}, { status: 500 })),
    ]) {
      const announce = vi.fn();
      await expect(
        changeConnectLink(fetchImpl as unknown as typeof fetch, "POST", { workspaceId: "ws-1", platforms: ["tiktok"] }, announce, () => true),
      ).resolves.toEqual({ ok: false, error: null, lost: true });
      expect(announce).toHaveBeenCalledTimes(1);
    }
  });

  it("offline at the press: nothing is sent", async () => {
    const announce = vi.fn();
    const fetchImpl = vi.fn();
    await expect(
      changeConnectLink(fetchImpl as unknown as typeof fetch, "POST", { workspaceId: "ws-1" }, announce, () => false),
    ).resolves.toEqual({ ok: false, error: null, notSent: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it("the panel says what may have happened, reads the link again, and says nothing was sent offline", () => {
    expect(CONNECT_LINK_MAYBE_MADE_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so a new connect link may have been made, which turns any old one off. If your connection dropped, reconnect first. Reload this page and copy the link before you send it.",
    );
    expect(CONNECT_LINK_MAYBE_OFF_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so the connect link may have been turned off. If your connection dropped, reconnect first. Reload this page to see.",
    );
    const source = readFileSync(join(__dirname, "connect-link-section.tsx"), "utf8");
    const send = source.slice(source.indexOf("const send = useCallback("), source.indexOf("const makeLink = useCallback("));
    expect(send).toMatch(/result\.notSent\) \{\s+toast\.error\(CONFIRM_NOTHING_SENT_MESSAGE\);\s+throw new ConfirmFailureShown/);
    expect(send).toMatch(/result\.lost\) \{\s+toast\.error\(method === "POST" \? CONNECT_LINK_MAYBE_MADE_MESSAGE : CONNECT_LINK_MAYBE_OFF_MESSAGE\);\s+void readLink\(\);\s+throw new ConfirmFailureShown/);
    expect(source).not.toContain("Couldn't reach Vibe Socials. Check your connection and try again.");
  });
});

// R27 MM3 (pages L1): "Create link" is replaced by the new link, so focus fell
// to the page. It goes to the new link's Copy button (lib/focusAfter).
describe("Client connect link: focus after Create link", () => {
  it("the press hands focus to the new Copy button", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./connect-link-section.tsx", import.meta.url)), "utf8");
    const create = source.slice(source.indexOf("async function onCreate("), source.indexOf("async function onCopy("));
    expect(create).toMatch(/const pressed = event\?\.currentTarget \?\? null;/);
    expect(create).toMatch(/await makeLink\(selected\);\s+(\/\/[^\n]*\n\s+)?focusAfterPress\(pressed, \(\) => copyRef\.current\);/);
    expect(source).toMatch(/<Button ref=\{copyRef\} type="button" variant="outline" onClick=\{onCopy\}>/);
    expect(source).toMatch(/copyRef=\{copyRef\}/);
  });
});

// R32 client-journey L3: Replace sent the old link's platforms as they were, so
// one the site no longer offers was refused with "Untick it", and the dialog has
// no boxes. Replace sends only what the site still offers, as Make new client
// links does; with none left it says so and leaves Turn off.
describe("Client connect link: Replace when the site offers fewer platforms", () => {
  const LINK = {
    url: "https://vibesocials.example/c/abc",
    platforms: ["tiktok", "instagram"] as ConnectLinkViewProps["available"],
    expiresAt: "2026-11-25T08:00:00.000Z",
    lastUsedAt: null,
    createdAt: "2026-11-11T08:00:00.000Z",
  };

  it("sends only the platforms the site still offers", () => {
    expect(replacePlatforms(LINK, ["instagram", "facebook_page"])).toEqual(["instagram"]);
    expect(replacePlatforms(LINK, ["tiktok", "instagram"])).toEqual(["tiktok", "instagram"]);
    expect(replacePlatforms(LINK, ["facebook_page"])).toEqual([]);
    expect(replacePlatforms(null, ["instagram"])).toEqual([]);
  });

  it("the confirm names what the new link will offer when some are dropped", () => {
    expect(replaceDescription(LINK, ["tiktok", "instagram"])).toBe(
      "The old link stops working. Your client will need the new one.",
    );
    expect(replaceDescription(LINK, ["instagram"])).toBe(
      "The old link stops working. Your client will need the new one. It offers Instagram only: TikTok can't be connected on this site now.",
    );
  });

  it("with none left: no Replace link, a sentence that says why, and Turn off", () => {
    const html = view({ link: LINK, available: ["facebook_page"] });
    expect(html).not.toContain("Replace link");
    expect(REPLACE_NONE_OFFERED_MESSAGE).toBe(
      "None of the platforms this link offers can be connected on this site now, so it can't be replaced. Press Turn off to stop it.",
    );
    expect(html).toContain(REPLACE_NONE_OFFERED_MESSAGE.replace("'", "&#x27;"));
    expect(html).toContain("Turn off");
  });

  it("the panel's Replace confirm sends replacePlatforms and words it with replaceDescription", () => {
    const source = readFileSync(join(__dirname, "connect-link-section.tsx"), "utf8");
    expect(source).toContain("() => makeLink(replacePlatforms(link, available))");
    expect(source).toContain("replaceDescription(link, available)");
    expect(source).not.toContain("makeLink(link?.platforms ?? [])");
  });
});

// R32 lead review: "Offers:" lists what the link really offers now, as /c does;
// a platform the site dropped is named on a line of its own.
describe("Client connect link: Offers lists only what the site still offers", () => {
  const LINK = {
    url: "https://vibesocials.example/c/abc",
    platforms: ["tiktok", "instagram"] as ConnectLinkViewProps["available"],
    expiresAt: "2026-11-25T08:00:00.000Z",
    lastUsedAt: null,
    createdAt: "2026-11-11T08:00:00.000Z",
  };

  it("all still offered: one Offers line", () => {
    const html = view({ link: LINK, available: ["tiktok", "instagram"] });
    expect(html).toContain("Offers: TikTok, Instagram");
    expect(html).not.toContain("No longer offered");
  });

  it("some dropped: Offers names the rest, and one line names the dropped ones", () => {
    const html = view({ link: LINK, available: ["instagram"] });
    expect(html).toContain("Offers: Instagram<");
    expect(html).toContain("No longer offered: TikTok. This site can&#x27;t connect it now.");
  });

  it("none left: no empty Offers line, the dropped line and the Turn off sentence", () => {
    const html = view({ link: LINK, available: [] });
    expect(html).not.toContain("Offers:");
    expect(html).toContain("No longer offered: TikTok, Instagram. This site can&#x27;t connect them now.");
  });
});
