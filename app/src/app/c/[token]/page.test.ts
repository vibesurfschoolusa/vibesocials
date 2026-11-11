import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ findLink: vi.fn(), listConnections: vi.fn(), choiceProps: vi.fn() }));
vi.mock("@/server/connectLink/link", () => ({
  findActiveConnectLink: h.findLink,
  listLinkConnections: h.listConnections,
}));
// The choice list is a client component; what the page hands it is what matters here.
vi.mock("./connect-link-choice", () => ({
  ConnectLinkChoice: (props: Record<string, unknown>) => {
    h.choiceProps(props);
    return createElement("section", null, "choice");
  },
}));

import { CONNECT_LINK_INACTIVE_MESSAGE } from "@/lib/connectLink";

import ConnectLinkPage, { metadata } from "./page";

const TOKEN = "T".repeat(43);

const LINK = {
  id: "link-1",
  workspaceId: "ws-1",
  workspaceName: "Surf & Co",
  createdById: "owner-1",
  platforms: ["instagram", "tiktok", "x", "facebook_page"],
  expiresAt: new Date("2026-11-25T08:00:00Z"),
};

async function render(query: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(
    (await ConnectLinkPage({
      params: Promise.resolve({ token: TOKEN }),
      searchParams: Promise.resolve(query),
    })) as ReactElement,
  );
}

beforeEach(() => {
  for (const m of Object.values(h)) m.mockReset();
  h.findLink.mockResolvedValue(LINK);
  h.listConnections.mockResolvedValue([]);
  for (const [key, value] of Object.entries({
    TIKTOK_CLIENT_KEY: "k",
    TIKTOK_CLIENT_SECRET: "s",
    TIKTOK_REDIRECT_URI: "r",
    FACEBOOK_APP_ID: "k",
    FACEBOOK_APP_SECRET: "s",
    INSTAGRAM_REDIRECT_URI: "r",
    FACEBOOK_PAGE_REDIRECT_URI: "r",
  })) {
    vi.stubEnv(key, value);
  }
});

afterEach(() => vi.unstubAllEnvs());

describe("the connect link page", () => {
  it("is not indexed, and sends only the bare origin as referrer (never the address with the token)", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe("strict-origin");
  });

  it("an inactive link shows only the sentence", async () => {
    h.findLink.mockResolvedValue(null);
    const html = await render({ success: "tiktok_connected" });
    expect(html).toContain(CONNECT_LINK_INACTIVE_MESSAGE);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("is connected");
    expect(h.listConnections).not.toHaveBeenCalled();
  });

  it("names the workspace, says what connecting allows and how to take it back, and links the terms and privacy", async () => {
    const html = await render();
    expect(html).toContain("Connect your accounts to Surf &amp; Co");
    expect(html).toContain(
      "Surf &amp; Co will be able to publish posts to the accounts you connect here. They cannot see your password.",
    );
    expect(html).toContain("You can remove this access at any time in each platform&#x27;s own settings.");
    expect(html).toMatch(/href="\/terms"/);
    expect(html).toMatch(/href="\/privacy"/);
  });

  it("one plain form per offered and configured platform, posting to the start route", async () => {
    const html = await render();
    const forms = html.match(/<form[^>]*>/g) ?? [];
    expect(forms).toHaveLength(3);
    for (const form of forms) {
      expect(form).toContain(`action="/api/connect-link/${TOKEN}/start"`);
      expect(form).toContain('method="post"');
    }
    for (const platform of ["tiktok", "instagram", "facebook_page"]) {
      expect(html).toContain(`name="platform" value="${platform}"`);
    }
    // Offered, but X's app credentials are not set on this site: not shown at all.
    expect(html).not.toContain('value="x"');
    expect(html).not.toMatch(/>X</);
  });

  it("a working connection shows its account name instead of a button; one that needs reconnecting shows Reconnect", async () => {
    h.listConnections.mockResolvedValue([
      { platform: "instagram", accountIdentifier: "ig-1", username: "surfco", locationName: null, needsReconnect: false },
      { platform: "tiktok", accountIdentifier: "open-1", username: "Surf TT", locationName: null, needsReconnect: true },
    ]);
    const html = await render();
    expect(html).toContain("Connected: surfco");
    expect(html).not.toContain('value="instagram"');
    expect(html).toMatch(/value="tiktok"[\s\S]*?Reconnect/);
  });

  it.each([
    [{ success: "tiktok_connected" }, "TikTok is connected."],
    [{ error: "tiktok_cancelled" }, "You cancelled. Nothing was connected."],
    [{ error: "youtube_oauth_denied" }, "We couldn&#x27;t connect YouTube. Try again, or tell Surf &amp; Co."],
    [{ error: "linkedin_auth_failed" }, "We couldn&#x27;t connect LinkedIn. Try again, or tell Surf &amp; Co."],
    [{ error: "instagram_already_connected" }, "Instagram is already connected. Ask Surf &amp; Co if it should be changed."],
    [{ error: "pinterest_no_boards" }, "Create a board on Pinterest"],
    [{ error: "tiktok_token_exchange_failed" }, "We couldn&#x27;t connect TikTok. Try again, or tell Surf &amp; Co."],
  ])("after a flow %o: %s, and never the code", async (query, sentence) => {
    const html = await render(query);
    expect(html).toContain(sentence);
    const code = Object.values(query)[0];
    expect(html).not.toContain(code);
  });

  it("a waiting choice hands the list only the token and the choice id", async () => {
    const html = await render({ choose: "pending-1" });
    expect(html).toContain("<section>choice</section>");
    expect(h.choiceProps).toHaveBeenCalledWith({ token: TOKEN, pendingId: "pending-1" });
  });

  it("says nothing of the workspace's ids", async () => {
    const html = await render();
    expect(html).not.toContain("ws-1");
    expect(html).not.toContain("link-1");
    expect(html).not.toContain("owner-1");
  });
});
