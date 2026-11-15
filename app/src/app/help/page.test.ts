import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
      "Nothing changed: the connection still posts where it did. Sign in to the account that is connected (for a LinkedIn or Facebook page, with an account that manages that page), then press Reconnect again.",
    );
    expect(section).toContain(
      "LinkedIn reuses the account signed in to LinkedIn in this browser, so sign out of LinkedIn first",
    );
    expect(section).toContain('href="https://www.linkedin.com/m/logout/"');
    expect(section).toContain("To use the other account instead, use Switch account.");
  });
});
