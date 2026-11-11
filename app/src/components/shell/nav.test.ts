import { describe, expect, it } from "vitest";

import { isPublicRoute, NAV_ITEMS, PUBLIC_ROUTE_PREFIXES, sectionTitle } from "./nav";

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

describe("PUBLIC_ROUTE_PREFIXES — pricing (23)", () => {
  it("adds /pricing and nothing else", () => {
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
      "/pricing",
    ]);
    expect(isPublicRoute("/pricing")).toBe(true);
    expect(isPublicRoute("/pricings")).toBe(false);
  });
});
