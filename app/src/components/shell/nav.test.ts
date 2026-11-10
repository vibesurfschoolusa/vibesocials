import { describe, expect, it } from "vitest";

import { isPublicRoute, NAV_ITEMS, sectionTitle } from "./nav";

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
