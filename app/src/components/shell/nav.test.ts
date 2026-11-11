import { describe, expect, it } from "vitest";

import { isPublicRoute, NAV_ITEMS, pricingShellProps, PUBLIC_ROUTE_PREFIXES, sectionTitle } from "./nav";

describe("isPublicRoute", () => {
  it("treats the help page as public", () => {
    expect(isPublicRoute("/help")).toBe(true);
    expect(isPublicRoute("/help/anything")).toBe(true);
  });

  it("keeps the existing public pages public", () => {
    for (const path of ["/login", "/about", "/privacy", "/terms", "/data-deletion"]) {
      expect(isPublicRoute(path), path).toBe(true);
    }
  });

  it("does not treat app pages, or names that only start with a public one, as public", () => {
    expect(isPublicRoute("/settings")).toBe(false);
    expect(isPublicRoute("/")).toBe(false);
    expect(isPublicRoute("/helpdesk")).toBe(false);
  });
});

describe("sectionTitle", () => {
  it("titles the workspaces page without adding it to the sidebar", () => {
    expect(sectionTitle("/workspaces")).toBe("Workspaces");
    expect(NAV_ITEMS.some((item) => item.href === "/workspaces")).toBe(false);
  });

  it("still titles sidebar pages and falls back to the product name", () => {
    expect(sectionTitle("/queue")).toBe("Queue");
    expect(sectionTitle("/")).toBe("Dashboard");
    expect(sectionTitle("/nowhere")).toBe("Vibe Socials");
  });

  it("keeps the workspaces page an app page, not a public one", () => {
    expect(isPublicRoute("/workspaces")).toBe(false);
  });
});

describe("isPublicRoute — client upload link", () => {
  it("renders /u/<token> with no app shell, and only that", () => {
    expect(isPublicRoute("/u/abc")).toBe(true);
    expect(isPublicRoute("/upload")).toBe(false);
  });
});

describe("isPublicRoute — client review link", () => {
  it("renders /v/<token> with no app shell, and only that", () => {
    expect(isPublicRoute("/v/abc")).toBe(true);
    expect(isPublicRoute("/videos")).toBe(false);
  });
});

describe("Reports", () => {
  it("is in the navigation, after Activity, and is an app page", () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(hrefs).toContain("/reports");
    expect(hrefs.indexOf("/reports")).toBe(hrefs.indexOf("/activity") + 1);
    expect(isPublicRoute("/reports")).toBe(false);
    expect(sectionTitle("/reports")).toBe("Reports");
  });

  it("renders the client's report with no app shell: /v already covers it", () => {
    expect(isPublicRoute("/v/abc/report")).toBe(true);
  });
});

describe("/pricing in the shell (23, fix round 1)", () => {
  it("leaves the public list as it was", () => {
    expect(PUBLIC_ROUTE_PREFIXES).toEqual([
      "/login",
      "/register",
      "/forgot-password",
      "/reset-password",
      "/verify-email",
      "/privacy",
      "/terms",
      "/data-deletion",
      "/about",
      "/help",
      "/u",
      "/v",
    ]);
  });

  it("is an app page (its 404 inside the shell, like any unknown page) unless pricing is public", () => {
    expect(isPublicRoute("/pricing")).toBe(false);
    expect(isPublicRoute("/pricing", { pricingPublic: true })).toBe(true);
    expect(isPublicRoute("/pricings", { pricingPublic: true })).toBe(false);
  });

  it("gives the shell no prop at all without payments configured, so the page is as before", () => {
    expect(pricingShellProps({})).toEqual({});
    expect(pricingShellProps({ BILLING_ENABLED: "true" })).toEqual({});
    expect(
      pricingShellProps({
        BILLING_ENABLED: "true",
        STRIPE_SECRET_KEY: "sk_test_placeholder",
        STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
        STRIPE_PRICE_PRO: "price_pro",
      }),
    ).toEqual({ pricingPublic: true });
  });
});
