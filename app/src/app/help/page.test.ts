import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { signInTo } from "@/lib/differentAccount";

import HelpPage from "./page";

// R6-pages L5: clients connect their own accounts through the connect link.
describe("Help: connecting your accounts", () => {
  const html = () => renderToStaticMarkup(HelpPage());

  it("says a client can connect their own accounts through a client connect link", () => {
    expect(html()).toContain(
      "Only a workspace owner can connect an account there. A client can connect their own accounts through a client connect link an owner sends them.",
    );
  });

  it("explains the client connect link", () => {
    const page = html();
    expect(page).toContain('id="client-connect-link"');
    expect(page).toContain("Letting a client connect their accounts");
    expect(page).toContain(
      "An owner makes the link in Settings, under Connections, Client connect link: tick the platforms it offers, then copy the link and send it to your client.",
    );
    expect(page).toContain(
      "Your client opens it and signs in on each platform. They don&#x27;t need a Vibe Socials account, and you never see their password.",
    );
    expect(page).toContain(
      "The link works for 14 days. An owner can replace it or turn it off at any time, and it stops working when the owner who made it is no longer an owner.",
    );
    expect(page).toContain(
      "It connects a platform that has no working account yet, or one that is about to stop working; it never replaces an account that works.",
    );
  });
});

// R8-pages L7: Settings' different-account banner links here, so the list covers it.
describe("Help: when something goes wrong", () => {
  const html = () => renderToStaticMarkup(HelpPage());

  it("covers a reconnect that came back with a different account, with LinkedIn's sign-out step", () => {
    const section = html().slice(html().indexOf('id="troubleshooting"'));
    expect(section).toContain("Reconnect came back with a different account.");
    expect(section).toContain(
      "Nothing changed: the connection still posts where it did. Press Reconnect again and sign in to the account that is connected.",
    );
    expect(section).toContain(
      "LinkedIn reuses the account signed in to LinkedIn in this browser, so sign out of LinkedIn first",
    );
    expect(section).toContain('href="https://www.linkedin.com/m/logout/"');
    expect(section).toContain("To use the other account instead, use Switch account.");
  });
});

// R52 pages-a L2: Help named no Instagram case and no tick step. It uses
// the same sign-in step as Settings, so the two can't drift apart.
describe("Help: a different account on Facebook Page and Instagram", () => {
  it("names the Facebook Page and Instagram steps from the shared sign-in text", () => {
    const section = renderToStaticMarkup(HelpPage()).split('id="troubleshooting"')[1];
    expect(section).toContain(`For a LinkedIn page, ${signInTo("linkedin", "that page")}.`);
    expect(section).toContain(`For a Facebook Page, ${signInTo("facebook_page", "the connected Page")}.`);
    expect(section).toContain(`For Instagram, ${signInTo("instagram", "the connected Instagram account")}.`);
    expect(section).toContain(
      "For Instagram, sign in with a Facebook account that manages the Page linked to the connected Instagram account and tick that Page when Facebook lists the Pages (and its Instagram account, if listed).",
    );
    expect(section).toContain(
      "For a Facebook Page, sign in with a Facebook account that manages the connected Page and tick it when Facebook lists the Pages.",
    );
  });
});

// R29 lead review: "click Connect again" was wrong when the platform is
// already connected and its card shows Reconnect.
describe("Help: the retry step names both buttons", () => {
  it("LinkedIn's and Pinterest's lines say Connect, or Reconnect when connected", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8").replace(/\s+/g, " ");
    expect(source).toContain(
      "Sign in to LinkedIn with an account that is a Super admin of your page, then click Connect (or Reconnect, if the platform is already connected).",
    );
    expect(source).toContain(
      "Create a board on Pinterest (not a secret one), then click Connect (or Reconnect, if the platform is already connected).",
    );
    expect(source).not.toContain("click Connect again");
  });
});

// R29 lead review: after a cancelled Reconnect the existing connection is
// unchanged, so the cancel line neither says nothing was connected nor names
// only Connect. R30 pages L3: Switch account disconnects first, so after it
// a cancel leaves no connection: not "nothing changed".
describe("Help: a cancelled sign-in", () => {
  it("says nothing new was connected, warns after Switch account, and names Connect or Reconnect", () => {
    const section = renderToStaticMarkup(HelpPage()).split('id="troubleshooting"')[1];
    expect(section).toContain(
      "Nothing new was connected. If you used Switch account, the old account was already disconnected: click Connect. Otherwise, click Connect (or Reconnect, if the platform is already connected) to try again.",
    );
    expect(section).not.toContain("Nothing was connected. Click Connect to try again.");
  });
});
