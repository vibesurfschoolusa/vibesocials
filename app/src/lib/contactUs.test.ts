import { describe, expect, it } from "vitest";

import { SUPPORT_EMAIL } from "./siteInfo";
import { contactUsHref } from "./contactUs";

/** S1 item 9: the account menu's "Contact us" link. */

function parts(href: string) {
  const url = new URL(href);
  return { to: url.pathname, subject: url.searchParams.get("subject"), body: url.searchParams.get("body") };
}

describe("contactUsHref", () => {
  it("writes to the support address, names the workspace and carries its id", () => {
    const href = contactUsHref({ id: "cmws123", name: "Surf & Sun Co" });
    expect(href.startsWith(`mailto:${SUPPORT_EMAIL}?`)).toBe(true);
    expect(parts(href)).toEqual({
      to: SUPPORT_EMAIL,
      subject: "Vibe Socials help: Surf & Sun Co",
      body: "Workspace id: cmws123\n\n",
    });
  });

  it("encodes so that a name cannot add its own fields", () => {
    const href = contactUsHref({ id: "ws-1", name: "A&cc=x@example.test" });
    expect(href).not.toContain("&cc=");
    expect(parts(href).subject).toBe("Vibe Socials help: A&cc=x@example.test");
  });

  it("before the workspace is known, writes without it", () => {
    expect(parts(contactUsHref(null))).toEqual({ to: SUPPORT_EMAIL, subject: "Vibe Socials help", body: null });
  });
});
