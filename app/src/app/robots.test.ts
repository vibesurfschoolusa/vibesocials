import { afterEach, beforeEach, describe, expect, it } from "vitest";

import robots from "./robots";

const SIGNED_IN_PATHS = [
  "/settings", "/posts", "/queue", "/activity", "/reports", "/media",
  "/reviews", "/workspaces", "/admin", "/connections", "/join",
];

describe("robots()", () => {
  const saved = process.env.NEXTAUTH_URL;
  beforeEach(() => { process.env.NEXTAUTH_URL = "https://vibesocials.wtf/"; });
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = saved;
  });

  function rule() {
    const r = robots().rules;
    return Array.isArray(r) ? r[0] : r;
  }

  it("allows the site and blocks the API and every signed-in path", () => {
    const r = rule();
    expect(r.userAgent).toBe("*");
    expect(r.allow).toBe("/");
    const disallow = ([] as string[]).concat(r.disallow ?? []);
    expect(disallow).toContain("/api/");
    for (const p of SIGNED_IN_PATHS) expect(disallow, p).toContain(p);
  });

  it("leaves the link pages crawlable so their noindex can be seen", () => {
    const disallow = ([] as string[]).concat(rule().disallow ?? []);
    for (const p of ["/u/", "/v/", "/c/", "/u", "/v", "/c"]) expect(disallow, p).not.toContain(p);
  });

  it("names the absolute sitemap address", () => {
    expect(robots().sitemap).toBe("https://vibesocials.wtf/sitemap.xml");
  });
});
