import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findLink: vi.fn(),
  listConnections: vi.fn(),
  choiceProps: vi.fn(),
  findLogo: vi.fn(),
  notifyRefused: vi.fn(),
  findConnection: vi.fn(),
}));
vi.mock("@/server/notifications/refusedConnectEmail", () => ({ notifyOwnersOfRefusedConnect: h.notifyRefused }));
vi.mock("@/lib/db", () => ({ prisma: { socialConnection: { findUnique: h.findConnection } } }));
vi.mock("@/lib/clientPageLogo", () => ({ findClientPageLogo: h.findLogo }));
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
  h.findLogo.mockResolvedValue(null);
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
    // R11-pages L5: the page still has an h1.
    expect(html).toMatch(/<h1[^>]*>This link is not active<\/h1>/);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("is connected");
    expect(h.listConnections).not.toHaveBeenCalled();
  });

  it("names the business in the header, says what connecting allows and how to take it back, and links the terms and privacy", async () => {
    const html = await render();
    expect(html).toMatch(/<h1[^>]*>Connect your accounts<\/h1>/);
    expect(html).toContain("Surf &amp; Co");
    // The workspace is the client's own business: never the publisher or the one to ask.
    expect(html).not.toMatch(/Surf &amp; Co will|Ask Surf|tell Surf/);
    expect(html).toContain(
      "The person who sent you this link will be able to publish posts to the accounts you connect here. They cannot see your password.",
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

  // R56 pages-a L3: Connect and Reconnect repeat per row, so each names its platform.
  it("names the platform on each Connect and Reconnect, and keeps their text", async () => {
    h.listConnections.mockResolvedValue([
      { platform: "tiktok", accountIdentifier: "open-1", username: "Surf TT", locationName: null, needsReconnect: true },
    ]);
    const html = await render();
    expect(html).toContain('aria-label="Reconnect TikTok"');
    expect(html).toContain('aria-label="Connect Instagram"');
    expect(html).toContain('aria-label="Connect Facebook Page"');
    expect(html.match(/>Connect</g)).toHaveLength(2);
    expect(html.match(/>Reconnect</g)).toHaveLength(1);
  });

  // R33 new-customer L2 / pages L6a: every offered platform lost its app keys on this site.
  it("nothing left to connect: one sentence instead of an empty list", async () => {
    h.findLink.mockResolvedValue({ ...LINK, platforms: ["x", "pinterest"] });
    const html = await render();
    expect(html).toContain(
      "Nothing can be connected through this link right now. Ask the person who sent it for a new link.",
    );
    expect(html).not.toContain("<ul");
    expect(html).not.toContain("<form");
    // Lead review: only the heading and the sentence; nothing to consent to.
    expect(html).toMatch(/<h1[^>]*>Connect your accounts<\/h1>/);
    expect(html).not.toContain("will be able to publish posts");
    expect(html).not.toContain("remove this access");
    expect(html).not.toMatch(/href="\/terms"|href="\/privacy"/);
    expect(html).not.toContain('role="alert"');
    expect(await render({ choose: "pending-1", error: "tiktok_cancelled" })).not.toMatch(/choice|You cancelled/);
  });

  it("something to connect: no such sentence", async () => {
    expect(await render()).not.toContain("Nothing can be connected through this link");
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
    [{ error: "tiktok_cancelled" }, "You cancelled. Nothing was connected."],
    [{ error: "youtube_oauth_denied" }, "We couldn&#x27;t connect YouTube. Try again, or tell the person who sent you this link."],
    [{ error: "linkedin_auth_failed" }, "We couldn&#x27;t connect LinkedIn. Try again, or tell the person who sent you this link."],
    [{ error: "instagram_already_connected" }, "Instagram is already connected. Ask the person who sent you this link if it should be changed."],
    [{ error: "pinterest_no_boards" }, "Create a board on Pinterest"],
    [{ error: "tiktok_token_exchange_failed" }, "We couldn&#x27;t connect TikTok. Try again, or tell the person who sent you this link."],
  ])("after a flow %o: %s, and never the code", async (query, sentence) => {
    const html = await render(query);
    expect(html).toContain(sentence);
    const code = Object.values(query)[0];
    expect(html).not.toContain(code);
  });

  // R28 new-customer L6: the sentence names the button the row shows.
  it("a missing Google permission: Reconnect for a row that shows it, Connect with no row", async () => {
    // Both Google platforms configured, so their rows (and the outcome above them) show.
    vi.stubEnv("GOOGLE_GBP_CLIENT_ID", "g");
    vi.stubEnv("GOOGLE_GBP_CLIENT_SECRET", "s");
    vi.stubEnv("YOUTUBE_REDIRECT_URI", "r");
    vi.stubEnv("GOOGLE_GBP_REDIRECT_URI", "r");
    h.findLink.mockResolvedValue({ ...LINK, platforms: ["youtube", "google_business_profile"] });
    h.listConnections.mockResolvedValue([
      { platform: "youtube", accountIdentifier: "chan-1", username: "My Channel", locationName: null, needsReconnect: true },
    ]);
    expect(await render({ error: "youtube_upload_not_allowed" })).toContain(
      "YouTube wasn&#x27;t reconnected: the permission to upload videos wasn&#x27;t allowed. Press Reconnect and",
    );
    expect(await render({ error: "google_business_profile_permission_missing" })).toContain(
      "so nothing changed. Press Connect and, on Google&#x27;s screen, allow access to the Business Profile.",
    );
  });

  // R6 M1: an account that can't be renewed and ends within the warning lead.
  it("a connection in its warning window still says Connected, and offers Reconnect", async () => {
    h.listConnections.mockResolvedValue([
      { platform: "instagram", accountIdentifier: "ig-1", username: "surfco", locationName: null, needsReconnect: false, reconnectSoon: true },
      { platform: "tiktok", accountIdentifier: "open-1", username: "Surf TT", locationName: null, needsReconnect: false, reconnectSoon: false },
    ]);
    const html = await render();
    expect(html).toContain("Connected: surfco. It stops working soon: press Reconnect to keep it posting.");
    expect(html).toMatch(/value="instagram"[\s\S]*?Reconnect/);
    expect(html).toContain("Connected: Surf TT</span>");
    expect(html).not.toContain('value="tiktok"');
  });

  // R60 pages-a L2: a nameless TikTok row never shows its open_id.
  it("a TikTok row with no name says Connected, never the open_id, also in the reconnect-soon line", async () => {
    h.listConnections.mockResolvedValue([
      { platform: "tiktok", accountIdentifier: "-000AbOpenId", username: null, locationName: null, needsReconnect: false, reconnectSoon: true },
    ]);
    const html = await render();
    expect(html).toContain(">Connected. It stops working soon: press Reconnect to keep it posting.</span>");
    expect(html).not.toContain("-000AbOpenId");
  });

  it("an ended TikTok row with no name starts with what to do, never the open_id", async () => {
    h.listConnections.mockResolvedValue([
      { platform: "tiktok", accountIdentifier: "-000AbOpenId", username: null, locationName: null, needsReconnect: false, reconnectSoon: true, ended: true },
    ]);
    const html = await render();
    expect(html).toContain(">It stopped working: press Reconnect.</span>");
    expect(html).not.toContain("-000AbOpenId");
  });

  it("a working nameless TikTok row says Connected; X and Instagram keep their fallback", async () => {
    h.findLink.mockResolvedValue({ ...LINK, platforms: ["instagram", "tiktok", "x"] });
    h.listConnections.mockResolvedValue([
      { platform: "tiktok", accountIdentifier: "-000AbOpenId", username: null, locationName: null, needsReconnect: false, reconnectSoon: false },
      { platform: "x", accountIdentifier: "vibesurf", username: null, locationName: null, needsReconnect: false, reconnectSoon: false },
      { platform: "instagram", accountIdentifier: "ig-1", username: null, locationName: null, needsReconnect: false, reconnectSoon: false },
    ]);
    const html = await render();
    expect(html).toContain(">Connected</span>");
    expect(html).not.toContain("-000AbOpenId");
    expect(html).toContain("Connected: vibesurf</span>");
    expect(html).toContain("Connected: ig-1</span>");
  });

  it("the row's name comes from the shared helper, not its own rule", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
    expect(source).not.toMatch(/\.accountIdentifier/);
    expect(source).toContain("connectionShownName(");
  });

  it("a connection whose end date passed (not flagged yet) says it stopped working, with Reconnect", async () => {
    h.listConnections.mockResolvedValue([
      { platform: "instagram", accountIdentifier: "ig-1", username: "surfco", locationName: null, needsReconnect: false, reconnectSoon: true, ended: true },
    ]);
    const html = await render();
    expect(html).toContain("surfco. It stopped working: press Reconnect.");
    expect(html).not.toContain("stops working soon");
    expect(html).toMatch(/value="instagram"[\s\S]*?Reconnect/);
  });

  // R6 review low 1 / R7-client-journey L4: the reconnect came back with another account; nothing changed.
  it("a different account than the one connected: says whose it is and what works; a name in the address is ignored", async () => {
    h.listConnections.mockResolvedValue([
      { platform: "facebook_page", accountIdentifier: "page-1", username: "Surf Co", locationName: null, needsReconnect: true, reconnectSoon: false, ended: false },
    ]);
    const html = await render({ error: "facebook_page_different_account", signed_in_as: "Client Cafe" });
    // R52 client-journey L1: someone who manages the Page gets its own step first, then the owner route.
    expect(html).toContain(
      "If you manage Surf Co, press Reconnect, sign in with a Facebook account that manages it and tick it when Facebook lists the Pages. If not, ask the workspace owner to disconnect it, then connect yours.",
    );
    // The step names the button this row shows.
    expect(html).toMatch(/value="facebook_page"[\s\S]*?Reconnect/);
    expect(html).not.toContain("Client Cafe");
  });

  // R7-client-journey L4: the owners are told where the refusal happens (the
  // callback and the choice route); typing the code into the address sends nothing.
  it("a different-account code typed into the address: the sentence, but no email", async () => {
    h.listConnections.mockResolvedValue([
      { platform: "facebook_page", accountIdentifier: "page-1", username: "Surf Co", locationName: null, needsReconnect: true, reconnectSoon: false, ended: false },
    ]);
    await render({ error: "facebook_page_different_account" });
    expect(h.notifyRefused).not.toHaveBeenCalled();
  });

  it("a different-account code without such a connection: no sentence", async () => {
    const html = await render({ error: "facebook_page_different_account" });
    expect(html).not.toContain("This connection belongs to");
  });

  // R53 client-journey L1: the sentence says "press Reconnect", so it shows
  // only while the row's button is Reconnect, by the success sentence's rule.
  describe("the different-account sentence follows the row's button", () => {
    const page = (extra: Record<string, unknown>) => ({
      platform: "facebook_page",
      accountIdentifier: "page-1",
      username: "Surf Co",
      locationName: null,
      needsReconnect: false,
      reconnectSoon: false,
      ended: false,
      ...extra,
    });
    const SENTENCE = "If you manage Surf Co, press Reconnect";

    it("a flagged connection: the sentence", async () => {
      h.listConnections.mockResolvedValue([page({ needsReconnect: true })]);
      expect(await render({ error: "facebook_page_different_account" })).toContain(SENTENCE);
    });

    it("a connection that ends soon: the sentence", async () => {
      h.listConnections.mockResolvedValue([page({ reconnectSoon: true })]);
      expect(await render({ error: "facebook_page_different_account" })).toContain(SENTENCE);
    });

    it("a working connection after the owner reconnected: no sentence at all", async () => {
      h.listConnections.mockResolvedValue([page({})]);
      const html = await render({ error: "facebook_page_different_account" });
      expect(html).not.toContain(SENTENCE);
      expect(html).not.toContain('role="alert"');
      expect(html).toContain("Connected: Surf Co");
    });

    it("no connection: no sentence at all", async () => {
      const html = await render({ error: "facebook_page_different_account" });
      expect(html).not.toContain("press Reconnect");
      expect(html).not.toContain('role="alert"');
    });
  });

  it("a Business Profile reconnect that couldn't be checked: names the location, try again", async () => {
    vi.stubEnv("GOOGLE_GBP_CLIENT_ID", "g");
    vi.stubEnv("GOOGLE_GBP_CLIENT_SECRET", "s");
    vi.stubEnv("GOOGLE_GBP_REDIRECT_URI", "r");
    h.findLink.mockResolvedValue({ ...LINK, platforms: [...LINK.platforms, "google_business_profile"] });
    h.listConnections.mockResolvedValue([
      { platform: "google_business_profile", accountIdentifier: "", username: "Surf Co Dania", locationName: null, needsReconnect: true, reconnectSoon: false, ended: false },
    ]);
    const html = await render({ error: "google_business_profile_account_check_failed" });
    expect(html).toContain("We couldn&#x27;t check that this Google account manages Surf Co Dania. Try again in a minute.");
  });

  it("a Business Profile reconnect that cleared the location: connected, the owner chooses it", async () => {
    vi.stubEnv("GOOGLE_GBP_CLIENT_ID", "g");
    vi.stubEnv("GOOGLE_GBP_CLIENT_SECRET", "s");
    vi.stubEnv("GOOGLE_GBP_REDIRECT_URI", "r");
    h.findLink.mockResolvedValue({ ...LINK, platforms: [...LINK.platforms, "google_business_profile"] });
    h.listConnections.mockResolvedValue([
      { platform: "google_business_profile", accountIdentifier: "", username: null, locationName: null, needsReconnect: false, reconnectSoon: false, ended: false },
    ]);
    const html = await render({ success: "google_business_profile_connected", location_cleared: "1" });
    expect(html).toContain("Connected. The workspace owner will choose the location.");
    expect(html).not.toContain("Surf Co Dania");
  });

  // R34 client-journey L1: the owner has since chosen the location, so a reload
  // or a restored tab with the one-time flag says only that it is connected.
  it("a location-cleared address after the owner chose a location: connected, nothing about choosing", async () => {
    vi.stubEnv("GOOGLE_GBP_CLIENT_ID", "g");
    vi.stubEnv("GOOGLE_GBP_CLIENT_SECRET", "s");
    vi.stubEnv("GOOGLE_GBP_REDIRECT_URI", "r");
    h.findLink.mockResolvedValue({ ...LINK, platforms: [...LINK.platforms, "google_business_profile"] });
    h.listConnections.mockResolvedValue([
      { platform: "google_business_profile", accountIdentifier: "", username: null, locationName: "Surf Co Dania", needsReconnect: false, reconnectSoon: false, ended: false },
    ]);
    const html = await render({ success: "google_business_profile_connected", location_cleared: "1" });
    expect(html).not.toContain("The workspace owner will choose the location.");
    expect(html).not.toContain("will choose the business location");
    expect(html).toContain("Google Business Profile is connected.");
  });

  it("a typed-in success is not told for a connection in its warning window", async () => {
    h.listConnections.mockResolvedValue([
      { platform: "instagram", accountIdentifier: "ig-1", username: "surfco", locationName: null, needsReconnect: false, reconnectSoon: true },
    ]);
    expect(await render({ success: "instagram_connected" })).not.toContain("is connected");
  });

  it("a waiting choice hands the list only the token, the choice id and the rows' button names", async () => {
    const html = await render({ choose: "pending-1" });
    expect(html).toContain("<section>choice</section>");
    expect(h.choiceProps).toHaveBeenCalledWith({
      token: TOKEN,
      pendingId: "pending-1",
      buttons: { instagram: "Connect", tiktok: "Connect", facebook_page: "Connect" },
    });
  });

  // R40 review: the limit's "press ... again" names the button each row shows.
  it("a row with a connection that needs it names Reconnect; a working one names none", async () => {
    h.listConnections.mockResolvedValue([
      { platform: "facebook_page", accountIdentifier: "1", username: "Surf Co", locationName: null, needsReconnect: true },
      { platform: "instagram", accountIdentifier: "ig-1", username: "surfco", locationName: null, needsReconnect: false },
    ]);
    await render({ choose: "pending-1" });
    expect(h.choiceProps).toHaveBeenCalledWith({
      token: TOKEN,
      pendingId: "pending-1",
      buttons: { tiktok: "Connect", facebook_page: "Reconnect" },
    });
  });

  // R45 pages-a L7: a refused Connect press comes back here with its wait.
  // R46 client-journey L1: as the wait's end, read against the request's own time.
  describe("a refused Connect press", () => {
    const REFUSED_AT = new Date("2026-11-19T10:15:00Z");
    const at = (seconds: number) => String(REFUSED_AT.getTime() / 1000 + seconds);
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(REFUSED_AT);
    });
    afterEach(() => vi.useRealTimers());

    it("the wait left and the row's button, announced", async () => {
      h.listConnections.mockResolvedValue([
        { platform: "tiktok", accountIdentifier: "open-1", username: "Surf TT", locationName: null, needsReconnect: true },
      ]);
      const html = await render({ error: "rate_limited", until: at(1500), platform: "facebook_page" });
      expect(html).toMatch(
        /role="alert"[^>]*>[\s\S]*?Too many requests from this network in the last hour\. Wait 25 minutes, then press Connect beside Facebook Page again\./,
      );
      const reconnect = await render({ error: "rate_limited", until: at(60), platform: "tiktok" });
      expect(reconnect).toContain("Wait 1 minute, then press Reconnect beside TikTok again.");
    });

    it("read at 10:15, then the same address at 11:00: the wait, then only the step", async () => {
      const query = { error: "rate_limited", until: at(45 * 60), platform: "instagram" };
      expect(await render(query)).toContain(
        "Too many requests from this network in the last hour. Wait 45 minutes, then press Connect beside Instagram again.",
      );
      vi.setSystemTime(new Date("2026-11-19T11:00:00Z"));
      const later = await render(query);
      expect(later).toContain("Press Connect beside Instagram again.");
      expect(later).not.toContain("Too many requests");
      expect(later).not.toContain("Wait");
    });

    it("an end already past: only the step", async () => {
      const html = await render({ error: "used_too_often", until: at(-600), platform: "x" });
      expect(html).toContain("Press Connect beside X again.");
      expect(html).not.toContain("used too many times");
    });

    it("the link's own limit: its own sentence", async () => {
      const html = await render({ error: "used_too_often", until: at(120), platform: "x" });
      expect(html).toContain("This link was used too many times in the last hour. Wait 2 minutes, then press Connect beside X again.");
      expect(html).toContain('role="alert"');
    });

    // R46 pages-a L1: a limit that couldn't be checked comes back here too, announced.
    it("a limit that couldn't be checked: its sentence and the minute, announced", async () => {
      const html = await render({ error: "limit_unchecked", until: at(60), platform: "instagram" });
      expect(html).toMatch(
        /role="alert"[^>]*>[\s\S]*?We couldn&#x27;t check that just now\. Nothing was changed\. Wait 1 minute, then press Connect beside Instagram again\./,
      );
      vi.setSystemTime(new Date(REFUSED_AT.getTime() + 61_000));
      expect(await render({ error: "limit_unchecked", until: at(60), platform: "instagram" })).toContain(
        "Press Connect beside Instagram again.",
      );
    });

    it.each<Record<string, string>>([{}, { until: "soon" }, { until: "999999999999" }, { until: "1".repeat(50) }, { wait: "60" }])(
      "a missing or garbage end %o: a plain sentence",
      async (until) => {
        const html = await render({ error: "rate_limited", platform: "nonsense", ...until });
        expect(html).toContain("Too many requests from this network in the last hour. Wait up to an hour, then press Connect again.");
        expect(html).not.toContain("nonsense");
      },
    );
  });

  it("says nothing of the workspace's ids", async () => {
    const html = await render();
    expect(html).not.toContain("ws-1");
    expect(html).not.toContain("link-1");
    expect(html).not.toContain("owner-1");
  });
});

// Fix round 2: a success sentence only when the workspace really has a
// working connection for that platform; the query alone is not enough.
describe("the success sentence is checked against the connection", () => {
  const youtube = (needsReconnect: boolean) => ({
    platform: "youtube",
    accountIdentifier: "chan-1",
    username: "Channel",
    locationName: null,
    needsReconnect,
  });

  it("YouTube connected and working: the sentence", async () => {
    h.listConnections.mockResolvedValue([youtube(false)]);
    expect(await render({ success: "youtube_connected" })).toContain("YouTube is connected.");
  });

  it("no YouTube connection: no sentence", async () => {
    const html = await render({ success: "youtube_connected" });
    expect(html).not.toContain("is connected");
    expect(html).not.toContain('role="status"');
  });

  it("a YouTube connection that needs reconnecting: no sentence", async () => {
    h.listConnections.mockResolvedValue([youtube(true)]);
    expect(await render({ success: "youtube_connected" })).not.toContain("is connected");
  });

  it("Google Business Profile working: the sentence with the business-location part", async () => {
    h.listConnections.mockResolvedValue([
      { platform: "google_business_profile", accountIdentifier: "", username: null, locationName: null, needsReconnect: false },
    ]);
    expect(await render({ success: "google_business_profile_connected" })).toContain(
      "Google Business Profile is connected. The person who sent you this link will choose the business location.",
    );
  });

  // R14-client-journey L2: a reconnect that kept its saved location needs no choosing.
  it("Google Business Profile reconnected with its location kept: connected, nothing more", async () => {
    h.listConnections.mockResolvedValue([
      { platform: "google_business_profile", accountIdentifier: "", username: null, locationName: "Surf Co Dania", needsReconnect: false },
    ]);
    const html = await render({ success: "google_business_profile_connected" });
    expect(html).toContain("Google Business Profile is connected.");
    expect(html).not.toContain("will choose the business location");
  });

  it("a success naming no known platform: no sentence", async () => {
    h.listConnections.mockResolvedValue([youtube(false)]);
    const html = await render({ success: "myspace_connected" });
    expect(html).not.toContain("is connected");
    expect(html).not.toContain('role="status"');
  });

  it("an error query is unchanged by this", async () => {
    expect(await render({ error: "tiktok_cancelled" })).toContain("You cancelled. Nothing was connected.");
  });

  it("a waiting choice is unchanged by this", async () => {
    expect(await render({ choose: "pending-1" })).toContain("<section>choice</section>");
  });

  it("shows the workspace logo when it has one, and the product name on an inactive link", async () => {
    h.findLogo.mockResolvedValue("https://x.example/logos/ws-1/a.png");
    expect(await render()).toContain('src="https://x.example/logos/ws-1/a.png"');
    h.findLink.mockResolvedValue(null);
    const inactive = await render();
    expect(inactive).toContain("Vibe Socials");
    expect(inactive).not.toContain("logos/ws-1");
  });
});

// R7-pages M2: LinkedIn connects whichever account the browser is signed in to,
// so Reconnect on the client's page shows the sign-out steps before the sign-in.
describe("LinkedIn on the client's page", () => {
  const linkedin = (extra: Record<string, unknown> = {}) => ({
    platform: "linkedin",
    accountIdentifier: "org-1",
    username: "Surf Co page",
    locationName: null,
    needsReconnect: false,
    reconnectSoon: true,
    ended: false,
    ...extra,
  });

  beforeEach(() => {
    vi.stubEnv("LINKEDIN_CLIENT_ID", "k");
    vi.stubEnv("LINKEDIN_CLIENT_SECRET", "s");
    vi.stubEnv("LINKEDIN_REDIRECT_URI", "r");
    h.findLink.mockResolvedValue({ ...LINK, platforms: [...LINK.platforms, "linkedin"] });
  });

  function linkedInRow(html: string): string {
    const start = html.indexOf(">LinkedIn<");
    expect(start).toBeGreaterThan(-1);
    // Up to the next platform's row: the steps are an inner list of their own.
    const next = html.indexOf('<li class="flex min-h-14', start);
    return html.slice(start, next === -1 ? undefined : next);
  }

  it.each([
    ["ends soon", linkedin()],
    ["flagged", linkedin({ needsReconnect: true, reconnectSoon: false })],
  ])("Reconnect (%s) opens the steps: sign out of LinkedIn, then the sign-in to the connected account", async (_case, connection) => {
    h.listConnections.mockResolvedValue([connection]);
    const row = linkedInRow(await render());
    expect(row).toMatch(/<details[\s\S]*<summary[^>]*>Reconnect<\/summary>/);
    expect(row).toContain('href="https://www.linkedin.com/m/logout/"');
    expect(row).toContain('target="_blank"');
    // R8-client-journey L2: the name is the company page, which nobody signs in to.
    expect(row).toContain("sign in with a LinkedIn account that is a Super admin of Surf Co page");
    expect(row).not.toContain("sign in to Surf Co page");
    // The sign-in is the last step, inside the steps, posting as before.
    const steps = row.slice(row.indexOf("<details"));
    expect(steps).toContain(`<form action="/api/connect-link/${TOKEN}/start" method="post">`);
    expect(steps).toContain('name="platform" value="linkedin"');
    expect(steps).toMatch(/<button[^>]*type="submit"[^>]*>Continue<\/button>/);
    // R56: the summary and its Continue name LinkedIn; the visible text stays.
    expect(row).toContain('aria-label="Reconnect LinkedIn"');
    expect(steps).toContain('aria-label="Continue to LinkedIn"');
  });

  it("without the page's name: the connected LinkedIn page, never the profile id", async () => {
    h.listConnections.mockResolvedValue([linkedin({ username: null, accountIdentifier: "aB3xYz9q" })]);
    const html = await render({ error: "linkedin_different_account" });
    expect(html).toContain("sign in with a LinkedIn account that is a Super admin of the connected LinkedIn page");
    expect(html).not.toContain("aB3xYz9q");
  });

  it("other platforms keep the plain Reconnect form", async () => {
    h.listConnections.mockResolvedValue([
      { platform: "tiktok", accountIdentifier: "open-1", username: "Surf TT", locationName: null, needsReconnect: true },
    ]);
    const html = await render();
    expect(html).not.toContain("<details");
    expect(html).not.toContain("linkedin.com/m/logout");
    expect(html).toMatch(/value="tiktok"[\s\S]*?Reconnect/);
  });

  it("a different LinkedIn account: the sentence names the sign-out step", async () => {
    h.listConnections.mockResolvedValue([linkedin({ needsReconnect: true, reconnectSoon: false })]);
    expect(await render({ error: "linkedin_different_account" })).toContain(
      "This connection posts to Surf Co page. If you are a Super admin of that page, sign out of LinkedIn first (Reconnect shows the steps), then sign in with a LinkedIn account that is a Super admin of Surf Co page. If not, ask the workspace owner to disconnect it in Settings, Connections; then connect your account here.",
    );
  });

  // R53 client-journey L1: "(Reconnect shows the steps)" only while the row shows Reconnect.
  it("a different LinkedIn account on a row that ends soon: the sentence", async () => {
    h.listConnections.mockResolvedValue([linkedin()]);
    expect(await render({ error: "linkedin_different_account" })).toContain("(Reconnect shows the steps)");
  });

  it("a different LinkedIn account after the owner reconnected: no sentence at all", async () => {
    h.listConnections.mockResolvedValue([linkedin({ reconnectSoon: false })]);
    const html = await render({ error: "linkedin_different_account" });
    expect(html).not.toContain("Reconnect shows the steps");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("<details");
  });

  // Unconfirmed (client-journey): LinkedIn may give the same end date on a reconnect.
  it("a reconnect that left the same end date (the callback's flag) says so instead of nothing", async () => {
    h.listConnections.mockResolvedValue([linkedin()]);
    h.findConnection.mockResolvedValue({ expiresAt: new Date("2026-11-16T12:00:00Z") });
    const html = await render({ success: "linkedin_connected", same_end: "1" });
    // R8-pages L5: what to do next, and the row no longer asks for the Reconnect that changed nothing.
    expect(html).toContain("LinkedIn kept the same end date. Reconnect after that date to keep posting; posts due after it fail until you do.");
    expect(html).not.toContain("sign out of LinkedIn and reconnect");
    // R9-pages L2: the date is shown once, in the row.
    expect(html.match(/November 16, 2026/g)).toHaveLength(1);
    // R11-pages L3: with the time, in UTC and labelled, so it can't read as another day than the owners' email.
    expect(html).not.toContain("is connected");
    const row = linkedInRow(html);
    expect(row).not.toContain("press Reconnect to keep it posting");
    expect(row).toContain("Connected: Surf Co page. Ends November 16, 2026, 12:00 UTC. LinkedIn kept this end date.");
    expect(h.findConnection).toHaveBeenCalledWith({
      where: { workspaceId_platform: { workspaceId: "ws-1", platform: "linkedin" } },
      select: { expiresAt: true },
    });
  });

  it("a Facebook Page without its stored name: never the numeric id in its row", async () => {
    h.listConnections.mockResolvedValue([
      { platform: "facebook_page", accountIdentifier: "102938475610", username: null, locationName: null, needsReconnect: false },
    ]);
    expect(await render()).not.toContain("102938475610");
  });

  // R8 review: the flag is LinkedIn's only (as Settings); typed on another platform it adds nothing.
  it("a typed same_end on another platform: no kept-date banner or row, and no end-date read", async () => {
    h.listConnections.mockResolvedValue([
      { platform: "instagram", accountIdentifier: "ig-1", username: "surfco", locationName: null, needsReconnect: false, reconnectSoon: true, ended: false },
    ]);
    h.findConnection.mockResolvedValue({ expiresAt: new Date("2026-11-16T12:00:00Z") });
    const html = await render({ success: "instagram_connected", same_end: "1" });
    expect(html).not.toContain("kept the same end date");
    expect(html).not.toContain("kept this end date");
    expect(h.findConnection).not.toHaveBeenCalled();
  });

  it("without the flag: no such sentence and no end-date read", async () => {
    h.listConnections.mockResolvedValue([linkedin()]);
    const html = await render({ success: "linkedin_connected" });
    expect(html).not.toContain("kept the same end date");
    expect(linkedInRow(html)).toContain("press Reconnect to keep it posting");
    expect(h.findConnection).not.toHaveBeenCalled();
  });

  it("a crafted flag on a connection that renewed: the usual sentence, and no end-date read", async () => {
    h.listConnections.mockResolvedValue([linkedin({ reconnectSoon: false })]);
    const html = await render({ success: "linkedin_connected", same_end: "1" });
    expect(html).toContain("LinkedIn is connected.");
    expect(html).not.toContain("kept the same end date");
    expect(h.findConnection).not.toHaveBeenCalled();
  });
});
