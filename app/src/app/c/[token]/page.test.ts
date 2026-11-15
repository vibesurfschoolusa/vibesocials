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
    expect(html).toMatch(/<h1[^>]*>Vibe Socials<\/h1>/);
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
    expect(html).toContain(
      "This connection belongs to Surf Co. Ask the workspace owner to disconnect it in Settings, Connections; then connect your account here.",
    );
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

  it("a typed-in success is not told for a connection in its warning window", async () => {
    h.listConnections.mockResolvedValue([
      { platform: "instagram", accountIdentifier: "ig-1", username: "surfco", locationName: null, needsReconnect: false, reconnectSoon: true },
    ]);
    expect(await render({ success: "instagram_connected" })).not.toContain("is connected");
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
    expect(row).toContain("sign in with a LinkedIn account that manages Surf Co page");
    expect(row).not.toContain("sign in to Surf Co page");
    // The sign-in is the last step, inside the steps, posting as before.
    const steps = row.slice(row.indexOf("<details"));
    expect(steps).toContain(`<form action="/api/connect-link/${TOKEN}/start" method="post">`);
    expect(steps).toContain('name="platform" value="linkedin"');
    expect(steps).toMatch(/<button[^>]*type="submit"[^>]*>Continue<\/button>/);
  });

  it("without the page's name: the connected LinkedIn page, never the profile id", async () => {
    h.listConnections.mockResolvedValue([linkedin({ username: null, accountIdentifier: "aB3xYz9q" })]);
    const html = await render({ error: "linkedin_different_account" });
    expect(html).toContain("sign in with a LinkedIn account that manages the connected LinkedIn page");
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
      "This connection posts to Surf Co page. If you manage that page, sign out of LinkedIn first (Reconnect shows the steps), then sign in with a LinkedIn account that manages Surf Co page. If not, ask the workspace owner to disconnect it in Settings, Connections; then connect your account here.",
    );
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
    expect(html).not.toContain("is connected");
    const row = linkedInRow(html);
    expect(row).not.toContain("press Reconnect to keep it posting");
    expect(row).toContain("Connected: Surf Co page. Ends November 16, 2026. LinkedIn kept this end date.");
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
